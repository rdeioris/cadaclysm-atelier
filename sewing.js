// Sewing: the two sewing tools, seam re-anchoring after an outline edit, and the seam colours.
// Ranges are arc lengths along a pattern's closed outline. A range that passes arc length 0 is
// stored as from > to: the kernel's garment_range_points reads that as the short wrapped range
// (280..20 on a 100x50 rectangle is 280 -> corner -> 20), while 20..280 is the long way round.
// Each seam keeps an anchor in meta.atelier, {a:[side, tFrom, tTo(, sideTo)], b:[...]}: the
// range as side + fraction, so it follows its sides when an outline edit moves the arc lengths.
import { addSeam } from "./model.js";

const PALETTE = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#46a6b8",
    "#d2a100", "#e05fb0", "#7a9a01", "#9a6324", "#008080", "#808000"];
export const seamColour = (i) => PALETTE[((i % 12) + 12) % 12];

// samples are flat triples (arc, x, y); the points whose arc lies in the range, in travel order
// (a wrapped range runs from..end, then 0..to).
function rangeLine(drawing, from, to) {
    const s = drawing?.samples;
    if (!s || s.length < 3) return [];
    const pts = (keep) => { const o = []; for (let i = 0; i < s.length; i += 3) if (keep(s[i])) o.push([s[i + 1], s[i + 2]]); return o; };
    return from <= to ? pts((a) => a >= from && a <= to) : [...pts((a) => a >= from), ...pts((a) => a <= to)];
}

const frac = (sides, side, s) => {
    const len = sides[side + 1] - sides[side];
    return len > 0 ? Math.min(1, Math.max(0, (s - sides[side]) / len)) : 0;
};
// A range's anchor on `sides` (side + fractions, as the sewing tools write it): one side when the
// range starts and ends on it running forward, else the start side and the end side.
export function anchorOf(sides, from, to) {
    const sideOf = (s) => { let k = 0; for (let i = 0; i < sides.length - 1; i++) if (sides[i] <= s) k = i; return k; };
    const a = sideOf(from), b = sideOf(to);
    return a === b && from <= to ? [a, frac(sides, a, from), frac(sides, b, to)] : [a, frac(sides, a, from), frac(sides, b, to), b];
}
const arcOf = (sides, side, t) => sides[side] + t * (sides[side + 1] - sides[side]);
const sidesOf = (ctx, id) => ctx.drawings.get(id)?.sides;

const validSide = (ctx, hit) => {
    const sides = sidesOf(ctx, hit.id);
    return !!sides && hit.side >= 0 && hit.side < sides.length - 1;
};

// One pick on a piece: a whole side (segment sewing) as a range plus which end was nearer the click.
function sidePick(ctx, hit) {
    const sides = sidesOf(ctx, hit.id);
    if (!sides || !(hit.side >= 0) || hit.side >= sides.length - 1) return null;
    const near = frac(sides, hit.side, hit.s) >= 0.5 ? 1 : 0;
    return { id: hit.id, from: sides[hit.side], to: sides[hit.side + 1], anchor: [hit.side, 0, 1], near };
}

// Two free clicks on one outline -> the range between them, the short way round, and the
// direction the user went (+1 increasing arc, -1 decreasing).
function freeRange(ctx, id, h1, h2) {
    const sides = sidesOf(ctx, id);
    const P = sides.at(-1);
    let d = h2.s - h1.s;
    d -= Math.round(d / P) * P; // into [-P/2, P/2]
    const dir = d >= 0 ? 1 : -1;
    const [a, b] = dir > 0 ? [h1, h2] : [h2, h1];
    const anchor = a.side === b.side && !(a.s > b.s)
        ? [a.side, frac(sides, a.side, a.s), frac(sides, b.side, b.s)]
        : [a.side, frac(sides, a.side, a.s), frac(sides, b.side, b.s), b.side];
    return { id, from: a.s, to: b.s, anchor, dir };
}

export function makeSewingTool(name, ctx) {
    const free = name === "free";
    const picks = []; // edge hits so far
    const ranges = []; // finished ranges (free) or side picks (segment)
    const overlayOf = () => {
        const lines = ranges.map((r) => rangeLine(ctx.drawings.get(r.id), r.from, r.to));
        return { lines };
    };
    const finish = () => {
        const [A, B] = ranges;
        const reversed = free ? A.dir !== B.dir : A.near !== B.near;
        const r = addSeam(ctx.nodes, {
            a: A.id, b: B.id, a_from: A.from, a_to: A.to, b_from: B.from, b_to: B.to, reversed,
            anchor: { a: A.anchor, b: B.anchor },
        });
        return { ops: r.ops, overlay: { lines: [] }, select: { kind: "seam", id: r.id }, done: true };
    };
    return {
        down(w, hit) {
            if (hit?.kind !== "edge" || !validSide(ctx, hit)) return {};
            if (!free) {
                const p = sidePick(ctx, hit);
                if (!p) return {};
                if (ranges.length === 1 && ranges[0].id === p.id && ranges[0].anchor[0] === p.anchor[0]) return {};
                ranges.push(p);
                return ranges.length === 2 ? finish() : { overlay: overlayOf() };
            }
            // free: the clicks pair up; the second click of a pair must be on the same piece as the first
            if (picks.length % 2 === 1 && picks[picks.length - 1].id !== hit.id) return {};
            picks.push(hit);
            if (picks.length % 2 === 1) return { overlay: { lines: overlayOf().lines, points: [[...w]] } };
            const n = picks.length;
            if (picks[n - 2].s === hit.s) { picks.pop(); return {}; }
            ranges.push(freeRange(ctx, hit.id, picks[n - 2], hit));
            return ranges.length === 2 ? finish() : { overlay: overlayOf() };
        },
        move() { return {}; },
        up() { return {}; },
        key(k) {
            if (k === "Escape") { picks.length = 0; ranges.length = 0; return { overlay: { lines: [] }, done: true }; }
            return {};
        },
    };
}

// After an outline edit of patternId: set each seam's a_/b_ ends from its anchor and the new
// sides; a seam whose side no longer exists is removed (named in `removed`).
export function reanchor(nodes, drawings, patternId) {
    const sides = drawings.get(patternId)?.sides;
    const ops = [];
    const removed = [];
    if (!sides) return { ops, removed };
    const dead = new Set();
    const sideCount = sides.length - 1;
    for (const n of nodes) {
        if (n.kind !== "garment.seam") continue;
        const anchor = n.meta?.atelier;
        if (!anchor) continue;
        const fields = {};
        let gone = false;
        for (const end of ["a", "b"]) {
            if (n[end] !== patternId || !anchor[end]) continue;
            const [sf, tf, tt, st = sf] = anchor[end];
            if (sf >= sideCount || st >= sideCount) { gone = true; break; }
            const from = arcOf(sides, sf, tf), to = arcOf(sides, st, tt);
            if (Math.abs(from - n[`${end}_from`]) > 1e-6) fields[`${end}_from`] = from;
            if (Math.abs(to - n[`${end}_to`]) > 1e-6) fields[`${end}_to`] = to;
        }
        if (gone) { dead.add(n.id); removed.push(n.id); }
        else if (Object.keys(fields).length) ops.push({ op: "set", id: n.id, fields });
    }
    if (dead.size) {
        const g = nodes.find((n) => n.id === "garment");
        if (g) ops.push({ op: "set", id: "garment", fields: { patterns: g.patterns, seams: g.seams.filter((s) => !dead.has(s)) } });
        for (const id of dead) ops.push({ op: "remove", id });
    }
    return { ops, removed };
}
