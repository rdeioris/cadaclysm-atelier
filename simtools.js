// The simulation's 2D tools (spec S1 §6), registered in tools.js's TOOLS: Fold line (an internal
// line of kind "fold" on a piece; its angle is set in the property panel, 180 flat until then)
// and Tack (a point on one piece, then a point on the same or another piece: a garment.tack
// joining them). And the tacks as the 2D window draws them: a marker at each end and a thin line
// between. Gesture machines as tools.js's: down/move/up/key returning {ops?, overlay?, select?,
// status?, done?}.
import { setPattern } from "./model.js";
import { addTack } from "./tacks.js";
import { bandOf, ACCENT } from "./scene2d.js";

const DRAG_PX = 3;
const TACK = "#4fd1c5";
const nodeOf = (ctx, id) => ctx.nodes.find((n) => n.id === id);
const line = (pts) => ({ lines: [pts.map((p) => [...p])] });
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
// The piece a 2D hit is on: a fill, an edge (a seamed one too), an internal line, a point or a
// handle of it. A tack's marker or a hole is not on a piece.
const PIECE_HITS = new Set(["pattern", "edge", "internal", "point", "handle"]);
export const pieceOf = (h) => (h && PIECE_HITS.has(h.kind) ? h.id : null);

// Fold line: click points on a piece (the first click's piece, else the selected one), Enter or
// a double click ends it.
function foldTool(ctx) {
    const drag = DRAG_PX * (ctx.pxToWorld > 0 ? ctx.pxToWorld : 1);
    const pts = [];
    let on = null;
    const commit = () => {
        const id = on ?? (ctx.selection?.kind === "pattern" ? ctx.selection.id : null);
        if (pts.length > 2 && dist(pts.at(-1), pts.at(-2)) < drag) pts.pop();
        if (!id || pts.length < 2) { pts.length = 0; on = null; return { overlay: { lines: [] }, done: true, ...(id ? {} : { status: "start a fold line on a piece" }) }; }
        const path = { start: [...pts[0]], segments: pts.slice(1).map((to) => ({ type: "line", to: [...to] })) };
        const index = (nodeOf(ctx, id)?.internal ?? []).length;
        pts.length = 0; on = null;
        return { ops: setPattern(ctx.nodes, id, { internal: [...(nodeOf(ctx, id)?.internal ?? []), { kind: "fold", path }] }), overlay: { lines: [] },
            select: { kind: "internal", id, index }, done: true };
    };
    return {
        down() { return {}; },
        move(w) { return pts.length ? { overlay: line([...pts, w]) } : {}; },
        up(w, h, mods) {
            if (mods?.dblclick || mods?.detail === 2) return commit();
            if (!pts.length) on = pieceOf(h);
            pts.push(w);
            return { overlay: line(pts) };
        },
        key(k) {
            if (k === "Enter") return commit();
            if (k === "Escape") { pts.length = 0; on = null; return { overlay: { lines: [] }, done: true }; }
            if (k === "Backspace") { pts.pop(); return { overlay: line(pts) }; }
            return {};
        },
        lastPoint() { return pts.length ? [...pts.at(-1)] : null; },
    };
}

// Tack: a click on a piece, then one on the same or another piece. The tool stays on for the next.
function tackTool(ctx) {
    let first = null;
    return {
        down(w, h) {
            const id = pieceOf(h);
            if (!id) return { status: h?.kind === "tack" ? "that is a tack: click a point on a piece" : "click a point on a piece" };
            if (!first) { first = { id, at: [...w] }; return { overlay: { lines: [], points: [first.at] }, status: "tack: now a point on the same or another piece", error: false }; }
            if (first.id === id && dist(first.at, w) < 1e-6) return { status: "tack: the second point is the first" };
            const r = addTack(ctx.nodes, { a: first.id, a_at: first.at, b: id, b_at: w });
            first = null;
            return { ops: r.ops, select: { kind: "tack", id: r.id }, overlay: { lines: [] }, status: "tacked", error: false };
        },
        move(w) { return first ? { overlay: { lines: [[first.at, w]], points: [first.at] } } : {}; },
        up() { return {}; },
        key(k) { if (k === "Escape") { first = null; return { overlay: { lines: [] }, done: true }; } return {}; },
        lastPoint() { return first ? [...first.at] : null; },
    };
}

export const SIM_TOOLS = { fold: foldTool, tack: tackTool };
// The ones that place points: snapping is on while one is armed.
export const SIM_SNAPPING = ["fold", "tack"];

// The tacks as item specs for the 2D window (scene2d.js specs2d's form), above every piece: a
// marker at each end, a thin line between. A tack whose piece is not drawn is still drawn (its
// numbers are the document's).
export function tackSpecs({ nodes = [], drawings = [], selection = null }) {
    const z = bandOf(drawings.length).seam;
    const out = [];
    for (const t of nodes) {
        if (t.kind !== "garment.tack" || !t.a_at || !t.b_at) continue;
        const colour = selection?.kind === "tack" && selection.id === t.id ? ACCENT : TACK;
        const what = { kind: "tack", id: t.id }, sig = JSON.stringify([t.a_at, t.b_at, z]);
        out.push({ key: `tack/${t.id}/line`, show: "lines", data: [t.a_at[0], t.a_at[1], z, t.b_at[0], t.b_at[1], z], colour, dash: { dash: 3, gap: 2 }, what, sig });
        out.push({ key: `tack/${t.id}/ends`, show: "points", data: [t.a_at[0], t.a_at[1], z, t.b_at[0], t.b_at[1], z], colour, size: 7,
            pointStyle: { shape: "disc", hollow: false }, onTop: true, what, sig });
    }
    return out;
}
