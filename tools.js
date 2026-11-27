// The 2D pattern tools. Each is a small gesture machine: down/move/up/key, returning
// {ops?, preview?, endPreview?, overlay?, select?, done?} (mirror and transform may return
// promises; callers await). No geometry here: the tools only write control points the user
// placed, and translation/mirroring go to the kernel through ctx.request.
// ctx is {nodes, drawings, selection, fabric, request}; the app makes a fresh tool after every
// document change, so a tool never holds a stale node list.
import { makeSewingTool } from "./sewing.js";
import { makeGroupTool } from "./seamgroup.js";
import { addPattern, addHole, addInternal, convertToHole, setOutline, setPattern, pieceOps, polyPath, openPath, freeLabel, pieceLabel, isClosedPath, linkedCopyOps } from "./model.js";
import { pointsOf, internalPointsOf, isCurvePoint } from "./view2d.js";
import { printTool } from "./prints.js";
import { SIM_TOOLS, SIM_SNAPPING } from "./simtools.js";
import { gradingOf } from "./grading.js";

export const NOTCH_DEFAULT = { kind: "slit", depth: 6 };
const CLOSE_PX = 6; // screen pixels: how near the first point a click closes the polygon
const DRAG_PX = 3; // screen pixels: less movement than this is a click, not a drag
const TINY = 1e-9;
// ctx.pxToWorld is world units per CSS pixel (1 when absent).
const tols = (ctx) => { const k = ctx.pxToWorld > 0 ? ctx.pxToWorld : 1; return { CLOSE: CLOSE_PX * k, DRAG: DRAG_PX * k }; };

const nodeOf = (ctx, id) => ctx.nodes.find((n) => n.id === id);
// In a graded size other than the base (A3 spec §3) a drag of an outline point sets its rule; a
// handle moves only in the base: the refusal's text, or null.
export function baseOnlyText(nodes) {
    const t = gradingOf(nodes.find((n) => n.id === "garment"));
    return t && t.current !== t.base ? `edit the shape in the base size (${t.base})` : null;
}
const outlineOf = (ctx, id) => nodeOf(ctx, `${id}_outline`)?.path;
// an internal line selected (its simulation properties) keeps its piece the one being edited
const selectedId = (ctx) => (ctx.selection?.kind === "pattern" || ctx.selection?.kind === "internal" ? ctx.selection.id : null);
const clone = (v) => JSON.parse(JSON.stringify(v));
const add = (p, d) => [p[0] + d[0], p[1] + d[1]];
const line = (pts) => ({ lines: [pts.map((p) => [...p])] });
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function newPattern(ctx, label, path, extra = {}) {
    const r = addPattern(ctx.nodes, { label, path, fabric: ctx.fabric, ...extra });
    return { ops: r.ops, select: { kind: "pattern", id: r.id }, done: true };
}

// Move point i by d: the vertex, the closing segment's `to` for i = 0 (a closed path), and the
// handles attached to it. An open path's point i ends segment i - 1 and starts segment i.
export function movePoint(path, i, d, closed = true) {
    const n = path.segments.length;
    if (i === 0) path.start = add(path.start, d);
    if (i > 0 || closed) {
        const ends = path.segments[(i - 1 + n) % n];
        ends.to = add(ends.to, d);
        if (ends.type === "bezier") ends.c2 = add(ends.c2, d);
    }
    const starts = path.segments[i];
    if (starts?.type === "bezier") starts.c1 = add(starts.c1, d);
}

// The Move tool's handle drags (spec §2) as the kernel's row-major 2x3 m6 (x' = m0 x + m1 y + m2,
// y' = m3 x + m4 y + m5). `box` is the selection's [x0, y0, x1, y1] when the drag began, `start`
// the press and `pointer` where it is now. A corner ("nw", "ne", "se", "sw") scales uniformly
// about the opposite corner, by how far the corner, moved with the pointer, now lies along the
// diagonal; a side ("n", "e", "s", "w") scales that one axis about the opposite side; "rot" turns
// about the box centre by the angle the pointer swept round it, in 15 degree steps with Shift.
// A scale never goes below MIN_SCALE (no collapse, no flip through the anchor). null where the
// drag means nothing: a box of no size along the axis, a pointer on the centre.
export const MIN_SCALE = 0.02, ROT_SNAP = 15;
export function handleMatrix(start, pointer, box, handle, shift = false) {
    const m = handleM(start, pointer, box, handle, shift);
    return m && m.map((v) => v + 0);                  // no -0 in the matrix
}
function handleM(start, pointer, box, handle, shift) {
    const [x0, y0, x1, y1] = box;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    if (handle === "rot") {
        if (Math.hypot(start[0] - cx, start[1] - cy) < TINY || Math.hypot(pointer[0] - cx, pointer[1] - cy) < TINY) return null;
        const a0 = Math.atan2(start[1] - cy, start[0] - cx), a1 = Math.atan2(pointer[1] - cy, pointer[0] - cx);
        let deg = ((a1 - a0) * 180) / Math.PI;
        if (shift) deg = Math.round(deg / ROT_SNAP) * ROT_SNAP;
        const a = (deg * Math.PI) / 180;
        // exact quarter turns (and none): no 6e-17 in the matrix
        const exact = (v) => (Math.abs(v) < 1e-15 ? 0 : Math.abs(Math.abs(v) - 1) < 1e-15 ? Math.sign(v) : v);
        const c = exact(Math.cos(a)), s = exact(Math.sin(a));
        return [c, -s, cx - c * cx + s * cy, s, c, cy - s * cx - c * cy];
    }
    const hx = handle.includes("w") ? x0 : handle.includes("e") ? x1 : null;
    const hy = handle.includes("s") ? y0 : handle.includes("n") ? y1 : null;
    if (hx === null && hy === null) throw new Error(`no handle ${handle}`);
    const ax = handle.includes("w") ? x1 : x0, ay = handle.includes("s") ? y1 : y0;   // the opposite corner or side
    const d = [pointer[0] - start[0], pointer[1] - start[1]];
    const k = (v) => Math.max(v, MIN_SCALE);
    if (hx !== null && hy !== null) {
        const vx = hx - ax, vy = hy - ay, l2 = vx * vx + vy * vy;
        if (!(l2 > TINY)) return null;
        const s = k(((hx + d[0] - ax) * vx + (hy + d[1] - ay) * vy) / l2);
        return [s, 0, ax * (1 - s), 0, s, ay * (1 - s)];
    }
    if (hx !== null) {
        if (!(Math.abs(hx - ax) > TINY)) return null;
        const s = k((hx + d[0] - ax) / (hx - ax));
        return [s, 0, ax * (1 - s), 0, 1, 0];
    }
    if (!(Math.abs(hy - ay) > TINY)) return null;
    const s = k((hy + d[1] - ay) / (hy - ay));
    return [1, 0, 0, 0, s, ay * (1 - s)];
}
const IDENTITY = [1, 0, 0, 0, 1, 0];
const sameM = (a, b) => !!a && !!b && a.every((v, i) => v === b[i]);
// The union of pieces `ids`' kernel bounds (ctx.drawings: id -> drawing); null for none.
function boundsOf(ctx, ids) {
    const bs = ids.map((id) => ctx.drawings?.get?.(id)?.bounds).filter(Boolean);
    if (!bs.length) return null;
    return [Math.min(...bs.map((b) => b[0])), Math.min(...bs.map((b) => b[1])), Math.max(...bs.map((b) => b[2])), Math.max(...bs.map((b) => b[3]))];
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
// `open` (an internal line): no closing click; Enter or a double click ends the path, which runs
// from the first point to the last (a lone point places nothing: place(null, firstHit)).
export function polygonShape(ctx, place, { open = false } = {}) {
    const { CLOSE, DRAG } = tols(ctx);
    const pts = [], out = [], inn = []; // out[i]: handle leaving point i; inn[i]: handle entering it
    let downAt = null, dragTo = null, first = null;
    const overlay = (cursor) => line(cursor ? [...pts, cursor] : pts);
    const reset = () => { pts.length = 0; out.length = 0; inn.length = 0; first = null; };
    const close = () => {
        const curves = pts.map((p, i) => {
            const j = (i + 1) % pts.length;
            return out[i] || inn[j] ? { c1: out[i] ?? p, c2: inn[j] ?? pts[j] } : null;
        });
        const r = place(polyPath(pts, curves), first);
        reset();
        return { ...r, overlay: { lines: [] } };
    };
    const finish = () => {
        // a click on the last point before Enter, or a double click's first click on it: placed once
        const n = pts.length;
        if (n > 2 && dist(pts[n - 1], pts[n - 2]) < DRAG && !out[n - 1] && !inn[n - 1]) { pts.pop(); out.length = inn.length = pts.length; }
        const curves = pts.slice(1).map((p, k) => (out[k] || inn[k + 1] ? { c1: out[k] ?? pts[k], c2: inn[k + 1] ?? p } : null));
        const r = place(pts.length >= 2 ? openPath(pts, curves) : null, first);
        reset();
        return { ...r, overlay: { lines: [] } };
    };
    return {
        down(w, h) { downAt = w; dragTo = null; if (!pts.length) first = h ?? null; return {}; },
        move(w) {
            if (!downAt) return { overlay: overlay(w) };
            dragTo = w;
            return { overlay: overlay(downAt) };
        },
        up(w, h, mods) {
            if (!downAt) return {};
            const p = downAt; downAt = null;
            const drag = dragTo && dist(w, p) >= DRAG ? w : null;
            dragTo = null;
            if (open && !drag && (mods?.dblclick || mods?.detail === 2)) return finish();
            if (!open && !drag && pts.length && dist(p, pts[0]) <= CLOSE) return pts.length >= 3 ? close() : {};
            pts.push(p);
            if (drag) { out[pts.length - 1] = [...drag]; inn[pts.length - 1] = [2 * p[0] - drag[0], 2 * p[1] - drag[1]]; }
            return { overlay: overlay() };
        },
        lastPoint() { return pts.length ? [...pts.at(-1)] : null; },
        key(k) {
            if (k === "Escape") { reset(); return { overlay: { lines: [] }, done: true }; }
            if (k === "Backspace") { pts.pop(); out.length = inn.length = pts.length; return { overlay: overlay() }; }
            if (k === "Enter" && open) return finish();
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
export const readout = (last, cursor) => (last && cursor ? mmText(Math.hypot(cursor[0] - last[0], cursor[1] - last[1])) : null);
export const mmText = (v) => `${v.toFixed(1)} mm`;

// The Ruler's measures (spec §7), each {length, text, line (the polyline drawn), at (its
// label's point), ends (the points marked)}. Between two points: the straight distance.
export function measureBetween(a, b) {
    const length = dist(a, b);
    return { length, text: mmText(length), line: [[...a], [...b]], at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], ends: [[...a], [...b]] };
}
// Side `side`'s arc length, from drawing `d`'s side table (`sides`: the kernel's arc length at
// each side's start, the perimeter last); null for no such side.
export function sideLength(d, side) {
    const s = d?.sides;
    return s && Number.isInteger(side) && side >= 0 && side + 1 < s.length ? s[side + 1] - s[side] : null;
}
// A side measured: its arc length, drawn along the kernel's outline samples over its arc
// range (the last side closes on the first sample); the label at its middle sample (`near`
// when the side is too short for one).
export function measureSide(d, side, near = null) {
    const length = sideLength(d, side);
    if (length === null) return null;
    const s0 = d.sides[side], s1 = d.sides[side + 1], smp = d.samples ?? [], line = [];
    for (let i = 0; i + 2 < smp.length; i += 3) if (smp[i] >= s0 - 1e-9 && smp[i] <= s1 + 1e-9) line.push([smp[i + 1], smp[i + 2]]);
    if (side + 2 === d.sides.length && smp.length >= 3) line.push([smp[1], smp[2]]);
    const at = line.length ? line[line.length >> 1] : near ? [...near] : null;
    return { length, text: mmText(length), line, at, ends: [], side };
}
// The Edit tool's hover read-out over an edge: "‹label› side n: 123.4 mm"; null off an edge.
export function sideReadout(drawings, h) {
    if (h?.kind !== "edge") return null;
    const d = drawings?.get?.(h.id), length = sideLength(d, h.side);
    return length === null ? null : `${d.label ? `${d.label} ` : ""}side ${h.side + 1}: ${mmText(length)}`;
}

// The Edit tool's keys on the selected points (spec §3): Delete or Backspace removes them, C
// makes each a curve point or a corner (whichever it is not). The outline's points when any are
// selected, else the internal lines' (each line its own batch: the first line's here). {} for none.
export function pointKey(ctx, op) {
    const id = selectedId(ctx);
    if (!id) return {};
    const sel = ctx.pointSel ?? [];
    if (sel.length) {
        const path = outlineOf(ctx, id);
        if (!path) return {};
        return op === "remove"
            ? { point: { id, op, indices: [...sel] } }
            : { point: { id, op, points: sel.map((index) => ({ index, smooth: !isCurvePoint(path, index) })) } };
    }
    const isel = ctx.ipointSel ?? [];
    if (!isel.length) return {};
    const line = isel[0].line, path = nodeOf(ctx, id)?.internal?.[line]?.path;
    if (!path) return {};
    const mine = isel.filter((q) => q.line === line).map((q) => q.index);
    return op === "remove"
        ? { point: { id, line, op, indices: mine } }
        : { point: { id, line, op, points: mine.map((index) => ({ index, smooth: !isCurvePoint(path, index, isClosedPath(path)) })) } };
}
// The point menu's choice (right click on a point): `smooth` true makes it a curve point.
export function pointMenuOp(hit, smooth) {
    if (hit?.kind === "point") return { id: hit.id, op: "smooth", points: [{ index: hit.index, smooth }] };
    if (hit?.kind === "ipoint") return { id: hit.id, line: hit.line, op: "smooth", points: [{ index: hit.index, smooth }] };
    return null;
}

// The snaps that make a Ruler click on an edge a point (a two-click measure's end), not the side.
const POINT_SNAPS = new Set(["end", "vertex", "point", "intersection"]);

// The tools that place points: snapping is on while one is armed (plan ruling 16).
export const SNAPPING = new Set(["rectangle", "polygon", "ellipse", "internal", "internal-rectangle", "internal-ellipse", "internal-polygon",
    "hole-rectangle", "hole-ellipse", "hole-polygon", "cut", "cut-sew", "dart", "mirror", "sym", "grain", "ruler", ...SIM_SNAPPING]);

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
        let lines0 = null;        // an internal point's or handle's drag: the piece's internal list when it began
        let said = null;          // the hover read-out last put on the status line
        const preview = (w) => {
            const d = [w[0] - start[0], w[1] - start[1]];
            if (lines0) {
                const lines = clone(lines0), path = lines[hit.line].path;
                if (hit.kind === "ipoint") movePoint(path, hit.index, d, isClosedPath(path));
                else { const s = path.segments[hit.index]; s[hit.which] = add(s[hit.which], d); }
                return { preview: setPattern(ctx.nodes, id, { internal: lines }) };
            }
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
                // a notch's mark selects that notch (its panel: kind, depth, at, remove)
                if (h?.kind === "notch") return { select: { kind: "notch", id: h.id, index: h.index } };
                if (h?.kind === "pattern" || (h?.kind === "internal" && h.id !== selectedId(ctx))) return { select: { kind: "pattern", id: h.id } };
                // a tack: its own properties (the simulation's, simprops.js)
                if (h?.kind === "tack") return { select: { kind: "tack", id: h.id } };
                // an internal line's point or handle (drawn on the selected piece only, spec §4)
                if (h && (h.kind === "ipoint" || h.kind === "ihandle")) {
                    const internal = nodeOf(ctx, h.id)?.internal;
                    if (!internal?.[h.line]?.path) return {};
                    id = h.id; lines0 = internal; path0 = null; start = w; hit = h; sent = false; locked = false;
                    return {};
                }
                lines0 = null;
                if (h && (h.kind === "point" || h.kind === "handle" || h.kind === "edge")) {
                    id = h.id; path0 = outlineOf(ctx, id);
                    if (!path0) return {};
                    start = w; hit = h; sent = false; locked = isLocked(h);
                    // a seamed edge's press may be the click that selects its seam: refused on the drag
                    if (locked && !h.seam) { hit = null; return { status: LOCKED }; }
                    // a handle in a graded size: refused at the press, before any preview (A3)
                    const graded = h.kind === "handle" ? baseOnlyText(ctx.nodes) : null;
                    if (graded) { hit = null; return { status: graded }; }
                    // the box-selected points belong to the selected piece (read now: the app keeps one tool across them)
                    chosen = new Set(h.id === selectedId(ctx) ? ctx.pointSel ?? [] : []);
                }
                return {};
            },
            // less travel than a drag is still a click: no preview yet. A hover over an edge
            // names its side's arc length on the status line (spec §7), once per side.
            move(w, h) {
                if (box.on) return box.move(w);
                if (!hit) {
                    const t = sideReadout(ctx.drawings, h);
                    if (t === said) return {};
                    said = t;
                    return t ? { status: t, error: false } : {};
                }
                if (!sent && dist(w, start) < DRAG) return {};
                if (locked) { if (sent) return {}; sent = true; return { status: LOCKED }; }
                sent = true;
                return preview(w);
            },
            // a click (no preview went out) on a seamed edge selects the seam, on a point selects it
            // (Shift adds or takes it away); a drag commits. A double click on an edge, or on an
            // internal line of the selected piece, inserts a point there (spec §3: the kernel's).
            up(w, h0, mods) {
                if (box.on) return box.end(mods).then((r) => ({ pointSel: r?.indices ?? [], ipointSel: [], overlay: { lines: [] } }), () => ({ overlay: { lines: [] } }));
                // a drag commits the preview at the release point: moves still in flight when the
                // pointer was let go are dropped (the page keeps one at a time), so the last one
                // previewed may be short of it
                const h = hit, last = h && sent && !locked ? preview(w) : null;
                hit = null;
                if (mods?.dblclick && !sent) {
                    const at = h0 ?? h;
                    if (at?.kind === "edge") return { point: { id: at.id, op: "insert", s: at.s }, status: "point added", error: false };
                    if (at?.kind === "internal" && at.id === selectedId(ctx)) return { point: { id: at.id, line: at.index, op: "insert", at: [...w] }, status: "point added", error: false };
                }
                // a plain click on an internal line of the piece being edited selects that line (its
                // simulation properties, simprops.js); a double click still inserts a point
                if (!h && !mods?.dblclick && h0?.kind === "internal" && h0.id === selectedId(ctx)) return { select: { kind: "internal", id: h0.id, index: h0.index } };
                // a click on a seam sewn to a hole's edge selects it (hole points are not edited)
                if (!h && !mods?.dblclick && h0?.kind === "hole" && h0.seam) return { select: { kind: "seam", id: h0.seam } };
                if (!h) return {};
                if (sent) return locked ? {} : { ...last, endPreview: true };
                if (h.kind === "point") {
                    const now = new Set(mods?.shift ? chosen : []);
                    if (mods?.shift && now.has(h.index)) now.delete(h.index); else now.add(h.index);
                    return { pointSel: [...now].sort((a, b) => a - b), ipointSel: [] };
                }
                if (h.kind === "ipoint") {
                    const key = (q) => `${q.line}:${q.index}`, mine = { line: h.line, index: h.index };
                    const old = mods?.shift ? ctx.ipointSel ?? [] : [];
                    const now = old.some((q) => key(q) === key(mine)) ? old.filter((q) => key(q) !== key(mine)) : [...old, mine];
                    return { pointSel: [], ipointSel: now };
                }
                return h.seam ? { select: { kind: "seam", id: h.seam } } : {};
            },
            key(k) {
                if (k === "Escape" && box.on) { box.cancel(); return { overlay: { lines: [] } }; }
                if (k === "Escape" && hit) { hit = null; return { cancel: true }; }
                // read when the page handles it: after a click just before the key has selected its point
                if (k === "Delete" || k === "Backspace") return () => pointKey(ctx, "remove");
                if (k === "c" || k === "C") return () => pointKey(ctx, "smooth");
                return {};
            },
        };
    },

    transform(ctx) {
        // want/asked: the matrix wanted and the one last sent; handle/box: a handle drag's handle
        // and the selection's box when it began (none: a translation)
        const fresh = () => ({ id: null, ids: [], start: null, want: null, asked: null, busy: null, result: null, live: true, handle: null, box: null });
        let st = fresh();
        const box = boxGesture(ctx, "pieces");
        // g.result is always {[id]: piece}, each the kernel's whole moved piece (kernel.js
        // transformedPiece): the outline, internal lines, notches and grain all move together
        const preview = (g) => (g.result ? { preview: g.ids.flatMap((id) => (g.result[id] ? pieceOps(ctx.nodes, id, g.result[id], g.ids) : [])) } : {});
        // The matrix for the pointer at w: a handle's (handleMatrix; the last one where this one
        // means nothing), else the translation.
        const wanted = (g, w, mods) => (g.handle
            ? handleMatrix(g.start, w, g.box, g.handle, !!mods?.shift) ?? g.want
            : [1, 0, w[0] - g.start[0], 0, 1, w[1] - g.start[1]]);
        // One request in flight; the latest wanted matrix is sent when it returns. A request that
        // rejects ends the loop and keeps the last good path; a cancelled gesture resolves to {}.
        const pump = (g) => {
            const run = (async () => {
                try {
                    while (g.live && g.want && !sameM(g.want, g.asked)) {
                        const matrix = g.want; g.asked = matrix;
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
                st.id = h.kind !== "handle" && h.kind !== "seam" && h.kind !== "xform" ? h.id : selectedId(ctx);
                st.start = st.id ? w : null;
                st.ids = st.id ? (ctx.selection?.ids?.includes(st.id) ? [...ctx.selection.ids] : [st.id]) : [];
                // a handle scales or turns the whole selection about its box as it is now
                if (h.kind === "xform") {
                    st.box = st.id ? boundsOf(ctx, st.ids) : null;
                    if (!st.box) { st = fresh(); return {}; }
                    st.handle = h.handle;
                    return {};
                }
                // a press on a piece of the multi-selection keeps it
                return h.kind === "pattern" && st.ids.length === 1 ? { select: { kind: "pattern", id: st.id } } : {};
            },
            move(w, h, mods) {
                if (box.on) return box.move(w);
                if (!st.start) return {};
                st.want = wanted(st, w, mods);
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
                g.want = wanted(g, w, mods);
                g.start = null;
                await g.busy;
                const still = !g.asked && (!g.want || sameM(g.want, IDENTITY));    // a click: nothing to move
                if (g.live && !still && g.want && !sameM(g.want, g.asked)) await pump(g);
                g.live = false;
                // the preview is committed only when one went out
                const p = preview(g);
                // every moved piece's seams re-anchored in the commit
                return p.preview ? { ...p, endPreview: true, reanchor: g.ids } : {};
            },
            key(k) {
                if (k === "Escape" && box.on) { box.cancel(); return { overlay: { lines: [] } }; }
                if (k !== "Escape" || !st.start) return {};
                st.live = false; st = fresh();
                return { cancel: true };
            },
        };
    },

    // An internal line on the selected piece (else the piece under the first press), drawn as the
    // Polygon tool draws: a click a corner, a drag a curve point with mirrored handles (spec §4);
    // open, ended by Enter or a double click.
    internal(ctx) {
        return polygonShape(ctx, (path, hit) => {
            const id = selectedId(ctx) ?? hit?.id ?? null;
            if (!id) return { status: "select the piece first", done: true };
            if (!path) return { done: true };
            const old = nodeOf(ctx, id)?.internal ?? [];
            return { ops: setPattern(ctx.nodes, id, { internal: [...old, { kind: "line", path }] }), done: true };
        }, { open: true });
    },

    // Notch: a click on an edge places one, of the kind and depth last chosen (ctx.notchNext, which
    // a selected notch's panel edit sets; a slit 6 mm deep at first).
    notch(ctx) {
        return {
            down(w, h) {
                if (h?.kind !== "edge") return {};
                const old = nodeOf(ctx, h.id)?.notches ?? [], next = { ...NOTCH_DEFAULT, ...(ctx.notchNext ?? {}) };
                return { ops: setPattern(ctx.nodes, h.id, { notches: [...old, { at: h.s, kind: next.kind, depth: next.depth }] }) };
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

    // Sym (spec §6): two clicks give an axis, as Mirror; the selected piece's mirrored copy is
    // added linked to it (meta.atelier.link on both): an edit of either rebuilds the other.
    sym(ctx) {
        const { DRAG } = tols(ctx);
        const pts = [];
        return {
            down() { return {}; },
            move(w) { return pts.length === 1 ? { overlay: line([pts[0], w]) } : {}; },
            up(w) {
                const id = selectedId(ctx);
                if (!id) return pts.length ? {} : { status: "select the piece first" };
                if (pts.length && dist(pts[0], w) < DRAG) return {};
                pts.push(w);
                if (pts.length < 2) return { overlay: line(pts) };
                const axis = [...pts[0], ...pts[1]];
                pts.length = 0;
                return Promise.resolve(ctx.request("mirror", { id, axis })).then((piece) => {
                    const r = linkedCopyOps(ctx.nodes, id, piece, axis);
                    return { ops: r.ops, select: { kind: "pattern", id: r.id }, overlay: { lines: [] }, status: "linked: an edit of either piece rebuilds the other", error: false, done: true };
                }).catch((e) => ({ status: `${e?.message ?? e}`.replace(/^(?!sym: )/, "sym: "), overlay: { lines: [] } }));
            },
            key(k) { if (k === "Escape") { pts.length = 0; return { overlay: { lines: [] }, done: true }; } return {}; },
            lastPoint() { return pts.length ? [...pts[0]] : null; },
        };
    },
    // Unfold (spec §6): a click on a straight side of a piece makes it whole across that side
    // (the kernel builds it: the worker's unfold).
    unfold() {
        return {
            down(w, h) {
                if (h?.kind !== "edge") return { status: "click a straight side of a piece" };
                return { unfold: { id: h.id, side: h.side }, done: true };
            },
            move() { return {}; }, up() { return {}; }, key(k) { return k === "Escape" ? { done: true } : {}; },
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

    // Ruler (spec §7): two clicks measure the straight distance, snapping on and Shift locking
    // 45 degree steps as in drawing; a first click on an edge (not snapped to a vertex, an end or
    // an intersection, which start a two-click measure) measures that side's arc length. The measures stay drawn, a line and a label each, until
    // the tool changes or Escape; they live in ctx.keep (the app keeps it while the tool stays
    // armed, across the fresh tools a document change makes) and are never saved.
    // Print (prints.js): place an image on a piece, move, turn and scale it
    print: (ctx) => printTool(ctx),

    ruler(ctx) {
        const keep = ctx.keep ?? {};
        const measures = (keep.measures ??= []);
        let a = null;
        const overlay = (cursor = null) => ({
            lines: [...measures.map((q) => q.line), ...(a && cursor ? [[a, cursor]] : [])].filter((l) => l.length >= 2),
            points: [...measures.flatMap((q) => q.ends), ...(a ? [a] : [])],
            labels: measures.filter((q) => q.at).map((q) => ({ at: q.at, text: q.text })),
        });
        const said = (q, what) => ({ overlay: overlay(), status: `${what}: ${q.text}`, error: false });
        return {
            down() { return {}; },
            move(w) { return a ? { overlay: overlay(w) } : {}; },
            up(w, h, mods) {
                if (!a) {
                    const onEdge = h?.kind === "edge" && !POINT_SNAPS.has(mods?.snap);
                    const q = onEdge ? measureSide(ctx.drawings?.get?.(h.id), h.side, w) : null;
                    if (q) { measures.push(q); return said(q, `side ${h.side + 1}`); }
                    a = [...w];
                    return { overlay: overlay(w) };
                }
                const from = a; a = null;
                if (dist(from, w) < TINY) return { overlay: overlay() };
                const q = measureBetween(from, w);
                measures.push(q);
                return said(q, "ruler");
            },
            lastPoint() { return a ? [...a] : null; },
            key(k) {
                if (k === "Escape") { a = null; measures.length = 0; return { overlay: { lines: [] }, done: true }; }
                if (k === "Backspace" && a) { a = null; return { overlay: overlay() }; }
                return {};
            },
        };
    },
};

// A notch's mark is picked as that notch; every tool but Edit reads it as its piece.
const asPiece = (h) => (h?.kind === "notch" ? { kind: "pattern", id: h.id } : h);
function piecesOnly(t) {
    for (const k of ["down", "move", "up"]) { const fn = t[k]; if (fn) t[k] = (w, h, mods) => fn.call(t, w, asPiece(h), mods); }
    return t;
}
export function makeTool(name, ctx) {
    if (name === "segment" || name === "free") return piecesOnly(makeSewingTool(name, ctx));
    if (Object.hasOwn(SIM_TOOLS, name)) return piecesOnly(SIM_TOOLS[name](ctx));
    if (name === "sewmn") return piecesOnly(makeGroupTool(ctx));
    if (!Object.hasOwn(TOOLS, name)) throw new Error(`unknown tool ${name}`);
    const t = TOOLS[name](ctx);
    return name === "edit" ? t : piecesOnly(t);
}
