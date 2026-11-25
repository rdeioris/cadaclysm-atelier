// The 2D pattern tools. Each is a small gesture machine: down/move/up/key, returning
// {ops?, preview?, endPreview?, overlay?, select?, done?} (mirror and transform may return
// promises; callers await). No geometry here: the tools only write control points the user
// placed, and translation/mirroring go to the kernel through ctx.request.
// ctx is {nodes, drawings, selection, fabric, request}; the app makes a fresh tool after every
// document change, so a tool never holds a stale node list.
import { makeSewingTool } from "./sewing.js";
import { addPattern, addHole, addInternal, convertToHole, setOutline, setPattern, pieceOps, polyPath, freeLabel, pieceLabel, isClosedPath } from "./model.js";
import { pointsOf } from "./view2d.js";

const CLOSE_PX = 6; // screen pixels: how near the first point a click closes the polygon
const DRAG_PX = 3; // screen pixels: less movement than this is a click, not a drag
const TINY = 1e-9;
// ctx.pxToWorld is world units per CSS pixel (1 when absent).
const tols = (ctx) => { const k = ctx.pxToWorld > 0 ? ctx.pxToWorld : 1; return { CLOSE: CLOSE_PX * k, DRAG: DRAG_PX * k }; };

const nodeOf = (ctx, id) => ctx.nodes.find((n) => n.id === id);
const outlineOf = (ctx, id) => nodeOf(ctx, `${id}_outline`)?.path;
const selectedId = (ctx) => (ctx.selection?.kind === "pattern" ? ctx.selection.id : null);
const clone = (v) => JSON.parse(JSON.stringify(v));
const add = (p, d) => [p[0] + d[0], p[1] + d[1]];
const line = (pts) => ({ lines: [pts.map((p) => [...p])] });
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function newPattern(ctx, label, path, extra = {}) {
    const r = addPattern(ctx.nodes, { label, path, fabric: ctx.fabric, ...extra });
    return { ops: r.ops, select: { kind: "pattern", id: r.id }, done: true };
}

// Move point i by d: the vertex, the closing segment's `to` for i = 0, and the handles attached to it.
function movePoint(path, i, d) {
    const n = path.segments.length;
    if (i === 0) path.start = add(path.start, d);
    const ends = path.segments[(i - 1 + n) % n];
    ends.to = add(ends.to, d);
    if (ends.type === "bezier") ends.c2 = add(ends.c2, d);
    const starts = path.segments[i];
    if (starts?.type === "bezier") starts.c1 = add(starts.c1, d);
}

// A box drag on nothing: the rectangle as overlay lines while dragging; on release the worker's
// pickRect over viewport-1 pixels (left to right a window, right to left a crossing box).
function boxGesture(ctx, kind) {
    let from = null;
    const box = (a, b) => [a, [b[0], a[1]], b, [a[0], b[1]], a];
    return {
        start(w, mods) { from = mods?.px ? { w, px: mods.px } : null; return !!from; },
        get on() { return !!from; },
        move(w) { return { overlay: { lines: [box(from.w, w)] } }; },
        async end(mods) {
            const f = from; from = null;
            if (!mods?.px) return null;
            return ctx.request("pickRect", { from: f.px, to: mods.px, kind });
        },
        cancel() { from = null; },
    };
}

// A drag-a-box shape: rectangle or ellipse, made by place(path, firstHit). A click without a drag
// asks the page for a size, and sized(w, h) places it at the click: a rectangle's lower-left
// corner, an ellipse's centre (ruling 15). Shift while dragging an ellipse: a circle -- so the
// ellipse gives no lastPoint (a 45 degree snap base from its corner would bend the drag); the
// rectangle keeps the angle lock from its first corner (a square on the diagonal).
export function boxShape(ctx, shape, place) {
    const { DRAG } = tols(ctx);
    let a = null, first = null, at = null;
    const corners = (b, o = a) => [o, [b[0], o[1]], b, [o[0], b[1]], o];
    const ellipseOf = (p, q, circle) => {
        let rx = Math.abs(q[0] - p[0]) / 2, ry = Math.abs(q[1] - p[1]) / 2;
        if (circle) rx = ry = Math.max(rx, ry);
        return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, rx, ry];
    };
    const ellipse = (cx, cy, rx, ry, hit) => Promise.resolve(ctx.request("ellipse", { cx, cy, rx, ry }))
        .then((path) => ({ ...place(path, hit), overlay: { lines: [] } }), (e) => ({ status: `ellipse: ${e?.message ?? e}`, overlay: { lines: [] } }));
    return {
        down(w, h) { a = w; first = h ?? null; at = null; return {}; },
        move(w, h, mods) {
            if (!a) return {};
            return shape === "ellipse" ? { overlay: { ellipse: ellipseOf(a, w, mods?.shift) } } : { overlay: line(corners(w)) };
        },
        up(w, h, mods) {
            if (!a) return {};
            const from = a, hit = first;
            a = null;
            if (dist(w, from) < DRAG) { at = { w: from, hit }; return { ask: { kind: "size", shape } }; }
            if (Math.abs(w[0] - from[0]) < TINY || Math.abs(w[1] - from[1]) < TINY) return { overlay: { lines: [] } };
            if (shape === "rectangle") return { ...place(polyPath(corners(w, from).slice(0, 4)), hit), overlay: { lines: [] } };
            return ellipse(...ellipseOf(from, w, mods?.shift), hit);
        },
        sized(width, height) {
            if (!at || !(width > 0) || !(height > 0)) return {};
            const { w, hit } = at;
            at = null;
            return shape === "rectangle" ? place(polyPath(corners([w[0] + width, w[1] + height], w).slice(0, 4)), hit) : ellipse(w[0], w[1], width / 2, height / 2, hit);
        },
        lastPoint() { return a && shape === "rectangle" ? [...a] : null; },
        key(k) { if (k === "Escape") { a = null; at = null; return { overlay: { lines: [] }, done: true }; } return {}; },
    };
}

// Click points, drag for a curve into the point, click the first point to close: place(path, firstHit).
export function polygonShape(ctx, place) {
    const { CLOSE, DRAG } = tols(ctx);
    const pts = [], out = [], inn = []; // out[i]: handle leaving point i; inn[i]: handle entering it
    let downAt = null, dragTo = null, first = null;
    const overlay = (cursor) => line(cursor ? [...pts, cursor] : pts);
    const close = () => {
        const curves = pts.map((p, i) => {
            const j = (i + 1) % pts.length;
            return out[i] || inn[j] ? { c1: out[i] ?? p, c2: inn[j] ?? pts[j] } : null;
        });
        const r = place(polyPath(pts, curves), first);
        pts.length = 0; out.length = 0; inn.length = 0; first = null;
        return { ...r, overlay: { lines: [] } };
    };
    return {
        down(w, h) { downAt = w; dragTo = null; if (!pts.length) first = h ?? null; return {}; },
        move(w) {
            if (!downAt) return { overlay: overlay(w) };
            dragTo = w;
            return { overlay: overlay(downAt) };
        },
        up(w) {
            if (!downAt) return {};
            const p = downAt; downAt = null;
            const drag = dragTo && dist(w, p) >= DRAG ? w : null;
            dragTo = null;
            if (!drag && pts.length && dist(p, pts[0]) <= CLOSE) return pts.length >= 3 ? close() : {};
            pts.push(p);
            if (drag) { out[pts.length - 1] = [...drag]; inn[pts.length - 1] = [2 * p[0] - drag[0], 2 * p[1] - drag[1]]; }
            return { overlay: overlay() };
        },
        lastPoint() { return pts.length ? [...pts.at(-1)] : null; },
        key(k) {
            if (k === "Escape") { pts.length = 0; out.length = 0; inn.length = 0; first = null; return { overlay: { lines: [] }, done: true }; }
            if (k === "Backspace") { pts.pop(); out.length = inn.length = pts.length; return { overlay: overlay() }; }
            return {};
        },
    };
}

const newPiece = (ctx) => (path) => newPattern(ctx, pieceLabel(ctx.nodes), path);

// Where a hole goes: the piece under the first press, else the selected one. The kernel (and
// kernel.js checkHoles) refuses a hole not inside the material; the app reports it, nothing changes.
const targetOf = (ctx, hit) => hit?.id ?? selectedId(ctx);
const holeAt = (ctx) => (path, hit) => {
    const id = targetOf(ctx, hit);
    return id ? { ops: addHole(ctx.nodes, id, path), done: true } : { status: "start a hole on a piece, or select the piece first" };
};

// An internal closed shape on the piece under the first press, else on the selected one.
const internalAt = (ctx) => (path, hit) => {
    const id = targetOf(ctx, hit);
    return id ? { ops: addInternal(ctx.nodes, id, path), done: true } : { status: "start the shape on a piece, or select the piece first" };
};

// Cut / Cut & Sew: a click on an internal open line cuts along it; else clicks draw a cutter
// across the selected piece, Enter or a double click ends it (spec §4).
function cutTool(ctx, sew) {
    const pts = [];
    const finish = () => {
        const id = selectedId(ctx);
        const cutter = pts.length >= 2 ? { start: [...pts[0]], segments: pts.slice(1).map((to) => ({ type: "line", to: [...to] })) } : null;
        pts.length = 0;
        if (!id) return { status: "select the piece to cut first", overlay: { lines: [] } };
        if (!cutter) return { status: "a cutter needs two points", overlay: { lines: [] } };
        return { cut: { id, cutter, sew, consume: null }, overlay: { lines: [] }, done: true };
    };
    return {
        down() { return {}; },
        move(w) { return pts.length ? { overlay: line([...pts, w]) } : {}; },
        up(w, h, mods) {
            if (!pts.length && h?.kind === "internal") {
                const entry = nodeOf(ctx, h.id)?.internal?.[h.index];
                if (entry && !isClosedPath(entry.path)) return { cut: { id: h.id, cutter: clone(entry.path), sew, consume: h.index }, done: true };
            }
            if (mods?.dblclick) return finish();
            pts.push([...w]);
            return { overlay: line(pts) };
        },
        lastPoint() { return pts.length ? [...pts.at(-1)] : null; },
        key(k) {
            if (k === "Enter") return finish();
            if (k === "Escape") { pts.length = 0; return { overlay: { lines: [] }, done: true }; }
            if (k === "Backspace") { pts.pop(); return { overlay: line(pts) }; }
            return {};
        },
    };
}

// The point a typed length places: `length` mm from `last`, at `angleDeg` (counter-clockwise
// from +x) when typed, else toward the cursor (+x when the cursor sits on the last point).
export function typedPoint(last, cursor, length, angleDeg = null) {
    let dx = 1, dy = 0;
    if (angleDeg !== null) { const a = (angleDeg * Math.PI) / 180; dx = Math.cos(a); dy = Math.sin(a); }
    else if (cursor) {
        const l = Math.hypot(cursor[0] - last[0], cursor[1] - last[1]);
        if (l > 1e-12) { dx = (cursor[0] - last[0]) / l; dy = (cursor[1] - last[1]) / l; }
    }
    return [last[0] + dx * length, last[1] + dy * length];
}
// The typed box's text as numbers: {length, angle} (angle null when blank), or null when the
// length is not a finite number above 0 or the angle not a finite number ("1,5", "abc", "1e999").
export function typedValues(lengthText, angleText = "") {
    const num = (t) => (/^\s*$/.test(t) ? NaN : Number(t));
    const length = num(String(lengthText ?? ""));
    const a = String(angleText ?? "").trim(), angle = a === "" ? null : num(a);
    if (!(Number.isFinite(length) && length > 0) || (angle !== null && !Number.isFinite(angle))) return null;
    return { length, angle };
}
// The length read-out while drawing (a label until the View's dimensions, spec section 1).
export const readout = (last, cursor) => (last && cursor ? `${Math.hypot(cursor[0] - last[0], cursor[1] - last[1]).toFixed(1)} mm` : null);

// The tools that place points: snapping is on while one is armed (plan ruling 16).
export const SNAPPING = new Set(["rectangle", "polygon", "ellipse", "internal", "internal-rectangle", "internal-ellipse", "internal-polygon",
    "hole-rectangle", "hole-ellipse", "hole-polygon", "cut", "cut-sew", "dart", "mirror", "grain"]);

const TOOLS = {
    rectangle: (ctx) => boxShape(ctx, "rectangle", newPiece(ctx)),
    ellipse: (ctx) => boxShape(ctx, "ellipse", newPiece(ctx)),
    polygon: (ctx) => polygonShape(ctx, newPiece(ctx)),
    "hole-rectangle": (ctx) => boxShape(ctx, "rectangle", holeAt(ctx)),
    "hole-ellipse": (ctx) => boxShape(ctx, "ellipse", holeAt(ctx)),
    "hole-polygon": (ctx) => polygonShape(ctx, holeAt(ctx)),
    "internal-rectangle": (ctx) => boxShape(ctx, "rectangle", internalAt(ctx)),
    "internal-ellipse": (ctx) => boxShape(ctx, "ellipse", internalAt(ctx)),
    "internal-polygon": (ctx) => polygonShape(ctx, internalAt(ctx)),
    cut: (ctx) => cutTool(ctx, false),
    "cut-sew": (ctx) => cutTool(ctx, true),
    // Trace: a click on an internal closed shape copies it out as a new piece beside the piece
    // (the kernel moves it; the original keeps the shape): one batch, one undo.
    trace(ctx) {
        return {
            down(w, h) {
                if (h?.kind !== "internal") return { status: "click an internal closed shape" };
                return isClosedPath(nodeOf(ctx, h.id)?.internal?.[h.index]?.path) ? { trace: { id: h.id, index: h.index }, done: true } : { status: "only a closed internal shape traces" };
            },
            move() { return {}; }, up() { return {}; }, key() { return {}; },
        };
    },
    // Convert to Hole: a click on an internal closed shape moves it into the outline's holes (one
    // batch: one undo); the kernel's hole checks refuse it as they refuse a drawn hole.
    "to-hole"(ctx) {
        return {
            down(w, h) {
                if (h?.kind !== "internal") return { status: "click an internal closed shape" };
                const ops = convertToHole(ctx.nodes, h.id, h.index);
                return ops ? { ops, done: true } : { status: "only a closed internal shape becomes a hole" };
            },
            move() { return {}; }, up() { return {}; }, key() { return {}; },
        };
    },

    // Fillet: click a corner of the selected piece (a first click selects the piece), then drag
    // out the radius or type it (spec §4). The worker builds the batch (one undo) or refuses it.
    fillet(ctx) {
        const { DRAG } = tols(ctx);
        let corner = null, pressed = null;
        const done = (radius) => {
            const c = corner;
            corner = null;
            return radius > 0 ? { fillet: { id: c.id, corner: c.index, radius }, overlay: { lines: [] } } : { status: "a radius above 0", overlay: { lines: [] } };
        };
        return {
            down(w, h) {
                if (h?.kind === "point") {
                    const at = pointsOf(ctx.nodes, h.id).points[h.index];
                    if (at) { corner = { id: h.id, index: h.index, at }; pressed = w; }
                    return {};
                }
                if (h?.id && (h.kind === "pattern" || h.kind === "edge")) return { select: { kind: "pattern", id: h.id } };
                return {};
            },
            move(w) { return corner ? { overlay: line([corner.at, w]) } : {}; },
            up(w) {
                if (!corner || !pressed) return {};
                const from = pressed;
                pressed = null;
                if (dist(w, from) >= DRAG) return done(dist(w, corner.at));
                return { status: "drag out the radius, or type it", error: false };
            },
            lastPoint() { return corner ? [...corner.at] : null; },
            typed(_p, length) { return corner ? done(length) : {}; },
            key(k) { if (k === "Escape") { corner = null; pressed = null; return { overlay: { lines: [] }, done: true }; } return {}; },
        };
    },

    edit(ctx) {
        const { DRAG } = tols(ctx);
        let start = null, hit = null, path0 = null, id = null, sent = false, locked = false;
        // An arc's (or NURBS span's) ends move with Fillet, not by hand (plan ruling 13): a press on
        // one, or on an edge ending at one, drags nothing.
        const LOCKED = "an arc's ends move with Fillet: undo it and fillet again";
        const isLocked = (h) => {
            const ends = pointsOf(ctx.nodes, h.id).locked;
            if (h.kind === "point") return ends.includes(h.index);
            if (h.kind !== "edge") return false;
            const n = outlineOf(ctx, h.id)?.segments?.length ?? 0;
            return n > 0 && (ends.includes(h.side) || ends.includes((h.side + 1) % n));
        };
        const box = boxGesture(ctx, "points");
        let chosen = new Set();
        const preview = (w) => {
            const d = [w[0] - start[0], w[1] - start[1]];
            const path = clone(path0);
            // a press on one of the box-selected points moves every selected point
            if (hit.kind === "point") {
                for (const i of chosen.has(hit.index) ? chosen : [hit.index]) if (i < path.segments.length) movePoint(path, i, d);
            } else if (hit.kind === "handle") { const s = path.segments[hit.index]; s[hit.which] = add(s[hit.which], d); }
            else { const n = path.segments.length; movePoint(path, hit.side, d); movePoint(path, (hit.side + 1) % n, d); }
            return { preview: setOutline(ctx.nodes, id, path) };
        };
        return {
            down(w, h, mods) {
                if (!h && selectedId(ctx)) { box.start(w, mods); return {}; }
                if (h?.kind === "pattern") return { select: { kind: "pattern", id: h.id } };
                if (h && (h.kind === "point" || h.kind === "handle" || h.kind === "edge")) {
                    id = h.id; path0 = outlineOf(ctx, id);
                    if (!path0) return {};
                    start = w; hit = h; sent = false; locked = isLocked(h);
                    // a seamed edge's press may be the click that selects its seam: refused on the drag
                    if (locked && !h.seam) { hit = null; return { status: LOCKED }; }
                    // the box-selected points belong to the selected piece (read now: the app keeps one tool across them)
                    chosen = new Set(h.id === selectedId(ctx) ? ctx.pointSel ?? [] : []);
                }
                return {};
            },
            // less travel than a drag is still a click: no preview yet
            move(w) {
                if (box.on) return box.move(w);
                if (!hit || (!sent && dist(w, start) < DRAG)) return {};
                if (locked) { if (sent) return {}; sent = true; return { status: LOCKED }; }
                sent = true;
                return preview(w);
            },
            // a click (no preview went out) on a seamed edge selects the seam; a drag commits
            up(w, h0, mods) {
                if (box.on) return box.end(mods).then((r) => ({ pointSel: r?.indices ?? [], overlay: { lines: [] } }), () => ({ overlay: { lines: [] } }));
                if (!hit) return {};
                const h = hit; hit = null;
                if (sent) return locked ? {} : { endPreview: true };
                return h.seam ? { select: { kind: "seam", id: h.seam } } : {};
            },
            key(k) {
                if (k === "Escape" && box.on) { box.cancel(); return { overlay: { lines: [] } }; }
                if (k === "Escape" && hit) { hit = null; return { cancel: true }; }
                return {};
            },
        };
    },

    transform(ctx) {
        const fresh = () => ({ id: null, ids: [], start: null, want: null, asked: null, busy: null, result: null, live: true });
        let st = fresh();
        const box = boxGesture(ctx, "pieces");
        // g.result is always {[id]: piece}, each the kernel's whole moved piece (kernel.js
        // transformedPiece): the outline, internal lines, notches and grain all move together
        const preview = (g) => (g.result ? { preview: g.ids.flatMap((id) => (g.result[id] ? pieceOps(ctx.nodes, id, g.result[id]) : [])) } : {});
        // One request in flight; the latest wanted delta is sent when it returns. A request that
        // rejects ends the loop and keeps the last good path; a cancelled gesture resolves to {}.
        const pump = (g) => {
            const run = (async () => {
                try {
                    while (g.live && g.want && !(g.asked && g.want[0] === g.asked[0] && g.want[1] === g.asked[1])) {
                        const d = g.want; g.asked = d;
                        const matrix = [1, 0, d[0], 0, 1, d[1]];
                        // one piece: the single transform (one piece back); a multi-selection: transformAll ({[id]: piece})
                        const r = g.ids.length === 1
                            ? { [g.id]: await ctx.request("transform", { id: g.id, matrix }) }
                            : await ctx.request("transformAll", { ids: g.ids, matrix });
                        if (g.live) g.result = r;
                    }
                } catch { /* keep the last good path */ }
                return g.live ? preview(g) : {};
            })();
            g.busy = run;
            run.then(() => { if (g.busy === run) g.busy = null; });
            return run;
        };
        return {
            down(w, h, mods) {
                st.live = false; st = fresh();
                // a press on nothing always starts the box: a drag from empty space never moves a piece
                if (!h) { box.start(w, mods); return {}; }
                st.id = h.kind !== "handle" && h.kind !== "seam" ? h.id : selectedId(ctx);
                st.start = st.id ? w : null;
                st.ids = st.id ? (ctx.selection?.ids?.includes(st.id) ? [...ctx.selection.ids] : [st.id]) : [];
                // a press on a piece of the multi-selection keeps it
                return h.kind === "pattern" && st.ids.length === 1 ? { select: { kind: "pattern", id: st.id } } : {};
            },
            move(w) {
                if (box.on) return box.move(w);
                if (!st.start) return {};
                st.want = [w[0] - st.start[0], w[1] - st.start[1]];
                return st.busy ? {} : pump(st);
            },
            async up(w, h, mods) {
                if (box.on) {
                    const r = await box.end(mods).catch(() => null);
                    const overlay = { lines: [] };
                    return r?.ids?.length ? { select: { kind: "pattern", id: r.ids[0], ids: r.ids }, overlay } : { select: null, overlay };
                }
                const g = st;
                if (!g.start) return {};
                g.want = [w[0] - g.start[0], w[1] - g.start[1]];
                g.start = null;
                await g.busy;
                const still = !g.asked && g.want[0] === 0 && g.want[1] === 0;    // a click: nothing to move
                if (g.live && !still && (!g.asked || g.want[0] !== g.asked[0] || g.want[1] !== g.asked[1])) await pump(g);
                g.live = false;
                // the preview is committed only when one went out
                const p = preview(g);
                return p.preview ? { ...p, endPreview: true } : {};
            },
            key(k) {
                if (k === "Escape" && box.on) { box.cancel(); return { overlay: { lines: [] } }; }
                if (k !== "Escape" || !st.start) return {};
                st.live = false; st = fresh();
                return { cancel: true };
            },
        };
    },

    internal(ctx) {
        const { DRAG } = tols(ctx);
        const pts = [];
        const commit = () => {
            const id = selectedId(ctx);
            if (!id || pts.length < 2) { pts.length = 0; return { done: true }; }
            if (pts.length > 2 && dist(pts[pts.length - 1], pts[pts.length - 2]) < DRAG) pts.pop();
            const old = nodeOf(ctx, id)?.internal ?? [];
            const path = { start: [...pts[0]], segments: pts.slice(1).map((to) => ({ type: "line", to: [...to] })) };
            pts.length = 0;
            return { ops: setPattern(ctx.nodes, id, { internal: [...old, { kind: "line", path }] }), done: true };
        };
        return {
            down() { return {}; },
            move(w) { return pts.length ? { overlay: line([...pts, w]) } : {}; },
            up(w, h, mods) {
                if (mods?.dblclick || mods?.detail === 2) return commit();
                pts.push(w);
                return { overlay: line(pts) };
            },
            key(k) {
                if (k === "Enter") return commit();
                if (k === "Escape") { pts.length = 0; return { overlay: { lines: [] }, done: true }; }
                if (k === "Backspace") { pts.pop(); return { overlay: line(pts) }; }
                return {};
            },
            lastPoint() { return pts.length ? [...pts.at(-1)] : null; },
        };
    },

    notch(ctx) {
        return {
            down(w, h) {
                if (h?.kind !== "edge") return {};
                const old = nodeOf(ctx, h.id)?.notches ?? [];
                return { ops: setPattern(ctx.nodes, h.id, { notches: [...old, { at: h.s, kind: "slit", depth: 6 }] }) };
            },
            move() { return {}; }, up() { return {}; }, key() { return {}; },
        };
    },

    dart(ctx) {
        const ends = []; // two edge clicks on one side
        let apex = null;
        return {
            down(w, h) {
                if (ends.length < 2) {
                    if (h?.kind !== "edge") return {};
                    if (ends.length && (ends[0].h.id !== h.id || ends[0].h.side !== h.side)) return {};
                    ends.push({ w, h });
                    return { overlay: line(ends.map((e) => e.w)) };
                }
                apex = w; return {};
            },
            move() { return {}; },
            up(w) {
                if (ends.length < 2 || !apex) return {};
                const id = ends[0].h.id, a = ends[0], b = ends[1];
                const p = nodeOf(ctx, id) ?? {};
                const path = { start: [...a.w], segments: [{ type: "line", to: [...apex] }, { type: "line", to: [...b.w] }] };
                ends.length = 0; apex = null;
                return {
                    ops: setPattern(ctx.nodes, id, {
                        internal: [...(p.internal ?? []), { kind: "dart", path }],
                        notches: [...(p.notches ?? []), { at: a.h.s, kind: "slit", depth: 6 }, { at: b.h.s, kind: "slit", depth: 6 }],
                    }),
                    done: true,
                };
            },
            key(k) { if (k === "Escape") { ends.length = 0; apex = null; return { overlay: { lines: [] }, done: true }; } return {}; },
            lastPoint() { return ends.length ? [...ends.at(-1).w] : null; },
        };
    },

    mirror(ctx) {
        const { DRAG } = tols(ctx);
        const pts = [];
        return {
            down() { return {}; },
            move(w) { return pts.length === 1 ? { overlay: line([pts[0], w]) } : {}; },
            up(w) {
                const id = selectedId(ctx);
                if (!id) return {};
                if (pts.length && dist(pts[0], w) < DRAG) return {}; // a zero-length axis
                pts.push(w);
                if (pts.length < 2) return { overlay: line(pts) };
                const axis = [...pts[0], ...pts[1]];
                pts.length = 0;
                const src = nodeOf(ctx, id);
                // The kernel keeps the segment order (side i stays side i), so the allowance list
                // is unchanged; the grain is the user's direction reflected across the axis.
                const dx = axis[2] - axis[0], dy = axis[3] - axis[1], len = Math.hypot(dx, dy), ux = dx / len, uy = dy / len;
                const grain = src.grain && (({ 0: gx, 1: gy }) => { const k = 2 * (gx * ux + gy * uy); return [k * ux - gx, k * uy - gy]; })(src.grain);
                // The kernel answers the whole piece (kernel.js mirroredPiece): outline and holes,
                // internal lines and notches, all mirrored across the axis.
                return Promise.resolve(ctx.request("mirror", { id, axis })).then(({ path, internal = [], notches = [] }) => {
                    const r = newPattern(ctx, freeLabel(ctx.nodes, `${src.label ?? "Piece"} (mirror)`), path, { layer: src.layer ?? 0, allowance: src.allowance, grain });
                    const node = r.ops.find((o) => o.op === "add" && o.node?.kind === "garment.pattern").node;
                    if (internal.length) node.internal = internal;
                    if (notches.length) node.notches = notches;
                    return { ...r, overlay: { lines: [] } };
                }, () => ({})); // a failed kernel call: nothing added, the gesture is already reset
            },
            key(k) { if (k === "Escape") { pts.length = 0; return { overlay: { lines: [] }, done: true }; } return {}; },
            lastPoint() { return pts.length ? [...pts[0]] : null; },
        };
    },

    allowance(ctx) {
        let hit = null, digits = "";
        return {
            down(w, h) { if (h?.kind === "edge") { hit = h; digits = ""; } return {}; },
            move() { return {}; }, up() { return {}; },
            key(k) {
                if (/^[0-9]$/.test(k) || (k === "." && !digits.includes("."))) { digits += k; return {}; }
                if (k === "Backspace") { digits = digits.slice(0, -1); return {}; }
                if (k === "Escape") { hit = null; digits = ""; return { done: true }; }
                if (k !== "Enter" || !hit || !digits || Number.isNaN(Number(digits))) return {};
                const sides = Math.max((ctx.drawings.get(hit.id)?.sides?.length ?? 2) - 1, 1);
                const old = nodeOf(ctx, hit.id)?.allowance ?? [0];
                const list = old.length === sides ? [...old] : Array.from({ length: sides }, (_, i) => old[i] ?? old[0] ?? 0);
                list[Math.min(hit.side, sides - 1)] = Number(digits);
                const id = hit.id; hit = null; digits = "";
                return { ops: setPattern(ctx.nodes, id, { allowance: list }) };
            },
        };
    },

    grain(ctx) {
        let a = null;
        return {
            down(w) { a = w; return {}; },
            move(w) { return a ? { overlay: line([a, w]) } : {}; },
            up(w) {
                const id = selectedId(ctx);
                if (!a || !id) { a = null; return {}; }
                const dx = w[0] - a[0], dy = w[1] - a[1], len = Math.hypot(dx, dy);
                a = null;
                if (len < TINY) return {};
                return { ops: setPattern(ctx.nodes, id, { grain: [dx / len, dy / len] }), overlay: { lines: [] } };
            },
            key() { return {}; },
            lastPoint() { return a ? [...a] : null; },
        };
    },
};

export function makeTool(name, ctx) {
    if (name === "segment" || name === "free") return makeSewingTool(name, ctx);
    if (!Object.hasOwn(TOOLS, name)) throw new Error(`unknown tool ${name}`);
    return TOOLS[name](ctx);
}
