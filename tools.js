// The 2D pattern tools. Each is a small gesture machine: down/move/up/key, returning
// {ops?, preview?, endPreview?, overlay?, select?, done?} (mirror and transform may return
// promises; callers await). No geometry here: the tools only write control points the user
// placed, and translation/mirroring go to the kernel through ctx.request.
// ctx is {nodes, drawings, selection, fabric, request}; the app makes a fresh tool after every
// document change, so a tool never holds a stale node list.
import { addPattern, setOutline, setPattern, polyPath } from "./model.js";

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
const patternCount = (ctx) => ctx.nodes.filter((n) => n.kind === "garment.pattern").length;

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

const TOOLS = {
    rectangle(ctx) {
        const { DRAG } = tols(ctx);
        let a = null;
        const corners = (b, o = a) => [o, [b[0], o[1]], b, [o[0], b[1]], o];
        return {
            down(w) { a = w; return {}; },
            move(w) { return a ? { overlay: line(corners(w)) } : {}; },
            up(w) {
                if (!a) return {};
                const from = a; a = null;
                if (dist(w, from) < DRAG || Math.abs(w[0] - from[0]) < TINY || Math.abs(w[1] - from[1]) < TINY) return {}; // a plain click opens nothing
                const pts = polyPath(corners(w, from).slice(0, 4));
                return newPattern(ctx, `Piece ${patternCount(ctx) + 1}`, pts);
            },
            key(k) { if (k === "Escape") { a = null; return { overlay: { lines: [] }, done: true }; } return {}; },
        };
    },

    polygon(ctx) {
        const { CLOSE, DRAG } = tols(ctx);
        const pts = [], out = [], inn = []; // out[i]: handle leaving point i; inn[i]: handle entering it
        let downAt = null, dragTo = null;
        const overlay = (cursor) => line(cursor ? [...pts, cursor] : pts);
        const close = () => {
            const curves = pts.map((p, i) => {
                const j = (i + 1) % pts.length;
                return out[i] || inn[j] ? { c1: out[i] ?? p, c2: inn[j] ?? pts[j] } : null;
            });
            return newPattern(ctx, `Piece ${patternCount(ctx) + 1}`, polyPath(pts, curves));
        };
        return {
            down(w) { downAt = w; dragTo = null; return {}; },
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
            key(k) {
                if (k === "Escape") { pts.length = 0; return { overlay: { lines: [] }, done: true }; }
                if (k === "Backspace") { pts.pop(); out.length = inn.length = pts.length; return { overlay: overlay() }; }
                return {};
            },
        };
    },

    edit(ctx) {
        let start = null, hit = null, path0 = null, id = null;
        const preview = (w) => {
            const d = [w[0] - start[0], w[1] - start[1]];
            const path = clone(path0);
            if (hit.kind === "point") movePoint(path, hit.index, d);
            else if (hit.kind === "handle") { const s = path.segments[hit.index]; s[hit.which] = add(s[hit.which], d); }
            else { const n = path.segments.length; movePoint(path, hit.side, d); movePoint(path, (hit.side + 1) % n, d); }
            return { preview: setOutline(ctx.nodes, id, path) };
        };
        return {
            down(w, h) {
                if (h?.kind === "pattern") return { select: { kind: "pattern", id: h.id } };
                if (h && (h.kind === "point" || h.kind === "handle" || h.kind === "edge")) {
                    id = h.id; path0 = outlineOf(ctx, id);
                    if (!path0) return {};
                    start = w; hit = h;
                }
                return {};
            },
            move(w) { return hit ? preview(w) : {}; },
            up() { if (!hit) return {}; hit = null; return { endPreview: true }; },
            key(k) { if (k === "Escape" && hit) { hit = null; return { cancel: true }; } return {}; },
        };
    },

    transform(ctx) {
        const fresh = () => ({ id: null, start: null, want: null, asked: null, busy: null, result: null, live: true });
        let st = fresh();
        const preview = (g) => (g.result ? { preview: setOutline(ctx.nodes, g.id, g.result) } : {});
        // One request in flight; the latest wanted delta is sent when it returns. A request that
        // rejects ends the loop and keeps the last good path; a cancelled gesture resolves to {}.
        const pump = (g) => {
            const run = (async () => {
                try {
                    while (g.live && g.want && !(g.asked && g.want[0] === g.asked[0] && g.want[1] === g.asked[1])) {
                        const d = g.want; g.asked = d;
                        const r = await ctx.request("transform", { id: g.id, matrix: [1, 0, d[0], 0, 1, d[1]] });
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
            down(w, h) {
                st.live = false; st = fresh();
                st.id = h && h.kind !== "handle" && h.kind !== "seam" ? h.id : selectedId(ctx);
                st.start = st.id ? w : null;
                return h?.kind === "pattern" ? { select: { kind: "pattern", id: st.id } } : {};
            },
            move(w) {
                if (!st.start) return {};
                st.want = [w[0] - st.start[0], w[1] - st.start[1]];
                return st.busy ? {} : pump(st);
            },
            async up(w) {
                const g = st;
                if (!g.start) return {};
                g.want = [w[0] - g.start[0], w[1] - g.start[1]];
                g.start = null;
                await g.busy;
                if (g.live && (!g.asked || g.want[0] !== g.asked[0] || g.want[1] !== g.asked[1])) await pump(g);
                g.live = false;
                return { ...preview(g), endPreview: true };
            },
            key(k) {
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
        };
    },

    mirror(ctx) {
        const { DRAG } = tols(ctx);
        const pts = [];
        const freeLabel = (label) => {
            const taken = new Set(ctx.nodes.filter((n) => n.kind === "garment.pattern").map((n) => n.label));
            const first = `${label} (mirror)`;
            let l = first;
            for (let k = 2; taken.has(l); k++) l = `${first} ${k}`;
            return l;
        };
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
                return Promise.resolve(ctx.request("mirror", { id, axis })).then((path) => ({
                    ...newPattern(ctx, freeLabel(src.label ?? "Piece"), path, { layer: src.layer ?? 0, allowance: src.allowance, grain }),
                    overlay: { lines: [] },
                }), () => ({})); // a failed kernel call: nothing added, the gesture is already reset
            },
            key(k) { if (k === "Escape") { pts.length = 0; return { overlay: { lines: [] }, done: true }; } return {}; },
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
        };
    },
};

export function makeTool(name, ctx) {
    if (!Object.hasOwn(TOOLS, name)) throw new Error(`unknown tool ${name}`);
    return TOOLS[name](ctx);
}
