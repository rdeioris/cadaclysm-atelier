// Sewing: the two sewing tools, seam re-anchoring after an outline edit, and the seam colours.
// Ranges are arc lengths along a pattern's closed outline. A range that passes arc length 0 is
// stored as from > to: the kernel's garment_range_points reads that as the short wrapped range
// (280..20 on a 100x50 rectangle is 280 -> corner -> 20), while 20..280 is the long way round.
// Each seam keeps an anchor in meta.atelier, {a:[side, tFrom, tTo(, sideTo)], b:[...]}: the
// range as side + fraction, so it follows its sides when an outline edit moves the arc lengths.
//
// Hole edges (A2 spec §2): a seam end may lie on a loop of its piece other than the outer one,
// the seam's a_loop/b_loop (loop k >= 1 is hole k - 1; absent or 0 is the outer outline). A hole
// range's arc lengths are the hole's own (from the hole's start point, in its direction of
// travel), and its sides are the hole's segments. Its anchor is always the 5-form
//     [side, tFrom, tTo, sideTo, loop]
// with sideTo written out even when it equals side, so the loop sits alone at index 4 and the
// 3- and 4-forms keep their meaning. An anchor with no 5th entry is on the outer outline
// (loop 0): every anchor written before hole seams reads as before.
import { addSeam } from "./model.js";

const PALETTE = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#46a6b8",
    "#d2a100", "#e05fb0", "#7a9a01", "#9a6324", "#008080", "#808000"];
export const seamColour = (i) => PALETTE[((i % 12) + 12) % 12];
// Each seam's colour index in `seams` (the list's order): its own, or for a member of an M:N
// group (seam.group, seamgroup.js) its group's first member's, so a group is one colour.
export function seamColourIndex(seams) {
    const first = new Map();
    return seams.map((s, i) => {
        if (!s.group) return i;
        if (!first.has(s.group)) first.set(s.group, i);
        return first.get(s.group);
    });
}

/** The loop an anchor lies on: 0 the outer outline, k hole k - 1. */
export const loopOf = (anchor) => anchor?.[4] ?? 0;
/** `anchor` put on loop `loop`: the 5-form for a hole; for loop 0 the outer 3- or 4-form. */
export function withLoop(anchor, loop) {
    const [sf, tf, tt, st = sf] = anchor;
    if (loop > 0) return [sf, tf, tt, st, loop];
    return anchor.length <= 4 ? anchor : sf === st && tf <= tt ? [sf, tf, tt] : [sf, tf, tt, st];
}
/** fn on outer-outline anchors only: a hole anchor passes through unchanged (an outline point
 *  insert, removal or fillet renumbers the outline's sides, never a hole's). */
export const outerOnly = (fn) => (anchor) => (anchor && loopOf(anchor) > 0 ? anchor : fn(anchor));
/** A drawing's sides (arc length at each side start, then the perimeter) on loop `loop`;
 *  undefined when the piece has no such hole. */
export const loopSides = (d, loop = 0) => (loop > 0 ? d?.holes?.[loop - 1]?.sides : d?.sides);
/** A drawing's 1 mm samples (flat triples arc, x, y) on loop `loop`. */
export const loopSamples = (d, loop = 0) => (loop > 0 ? d?.holes?.[loop - 1]?.samples : d?.samples);
/** A 2D hit the sewing tools take: an outline edge, or a hole edge with its arc length. */
export const sewableHit = (hit) => hit?.kind === "edge" || (hit?.kind === "hole" && Number.isFinite(hit.s));
/** The loop a hit lies on (0 for an outline edge). */
export const hitLoop = (hit) => (hit?.kind === "hole" ? hit.loop ?? hit.index + 1 : 0);

// samples are flat triples (arc, x, y); the points whose arc lies in the range, in travel order
// (a wrapped range runs from..end, then 0..to). `loop`: the outline (0) or a hole's samples.
export function rangeLine(drawing, from, to, loop = 0) {
    const s = loopSamples(drawing, loop);
    if (!s || s.length < 3) return [];
    const pts = (keep) => { const o = []; for (let i = 0; i < s.length; i += 3) if (keep(s[i])) o.push([s[i + 1], s[i + 2]]); return o; };
    return from <= to ? pts((a) => a >= from && a <= to) : [...pts((a) => a >= from), ...pts((a) => a <= to)];
}

const frac = (sides, side, s) => {
    const len = sides[side + 1] - sides[side];
    return len > 0 ? Math.min(1, Math.max(0, (s - sides[side]) / len)) : 0;
};
// A range's anchor on `sides` (side + fractions, as the sewing tools write it): one side when the
// range starts and ends on it running forward, else the start side and the end side. On a hole
// (`loop` >= 1, `sides` the hole's) the 5-form with the loop.
export function anchorOf(sides, from, to, loop = 0) {
    // the side a range starts on, and the one it ends on (a range ending at a side's end ends on
    // that side, not the next); a side start found by bisection lies a hair past the exact one:
    // 1e-6 mm of slack
    const last = sides.length - 2;
    const startSide = (s) => { let k = 0; for (let i = 0; i <= last; i++) if (sides[i] <= s + 1e-6) k = i; return k; };
    const endSide = (s) => { let k = 0; for (let i = 0; i <= last; i++) if (sides[i] < s - 1e-6) k = i; return k; };
    const a = startSide(from), b = endSide(to);
    const anchor = a === b && from <= to ? [a, frac(sides, a, from), frac(sides, b, to)] : [a, frac(sides, a, from), frac(sides, b, to), b];
    return withLoop(anchor, loop);
}
const arcOf = (sides, side, t) => sides[side] + t * (sides[side + 1] - sides[side]);
const sidesOf = (ctx, id, loop = 0) => loopSides(ctx.drawings.get(id), loop);

const validSide = (ctx, hit) => {
    const sides = sidesOf(ctx, hit.id, hitLoop(hit));
    return !!sides && hit.side >= 0 && hit.side < sides.length - 1;
};

// One pick on a piece: a whole side (segment sewing) as a range plus which end was nearer the
// click. A hole hit takes the hole's side, on its loop.
export function sidePick(ctx, hit) {
    const loop = hitLoop(hit), sides = sidesOf(ctx, hit.id, loop);
    if (!sides || !(hit.side >= 0) || hit.side >= sides.length - 1) return null;
    const near = frac(sides, hit.side, hit.s) >= 0.5 ? 1 : 0;
    return { id: hit.id, loop, from: sides[hit.side], to: sides[hit.side + 1], anchor: withLoop([hit.side, 0, 1], loop), near };
}

// Two free clicks on one loop of one piece (the outline, or a hole) -> the range between them,
// the short way round, and the direction the user went (+1 increasing arc, -1 decreasing).
export function freeRange(ctx, id, h1, h2) {
    const loop = hitLoop(h1), sides = sidesOf(ctx, id, loop);
    const P = sides.at(-1);
    let d = h2.s - h1.s;
    d -= Math.round(d / P) * P; // into [-P/2, P/2]
    const dir = d >= 0 ? 1 : -1;
    const [a, b] = dir > 0 ? [h1, h2] : [h2, h1];
    const anchor = a.side === b.side && !(a.s > b.s)
        ? [a.side, frac(sides, a.side, a.s), frac(sides, b.side, b.s)]
        : [a.side, frac(sides, a.side, a.s), frac(sides, b.side, b.s), b.side];
    return { id, loop, from: a.s, to: b.s, anchor: withLoop(anchor, loop), dir };
}
// Whether two hits lie on the same loop of the same piece (a free range's two clicks must).
export const sameLoop = (h1, h2) => h1.id === h2.id && hitLoop(h1) === hitLoop(h2);

export function makeSewingTool(name, ctx) {
    const free = name === "free";
    const picks = []; // edge hits so far
    const ranges = []; // finished ranges (free) or side picks (segment)
    const overlayOf = () => {
        const lines = ranges.map((r) => rangeLine(ctx.drawings.get(r.id), r.from, r.to, r.loop));
        return { lines };
    };
    const finish = () => {
        const [A, B] = ranges;
        const reversed = free ? A.dir !== B.dir : A.near !== B.near;
        const r = addSeam(ctx.nodes, {
            a: A.id, b: B.id, a_from: A.from, a_to: A.to, b_from: B.from, b_to: B.to, reversed,
            a_loop: A.loop, b_loop: B.loop, anchor: { a: A.anchor, b: B.anchor },
        });
        return { ops: r.ops, overlay: { lines: [] }, select: { kind: "seam", id: r.id }, done: true };
    };
    return {
        down(w, hit) {
            if (!sewableHit(hit) || !validSide(ctx, hit)) return {};
            if (!free) {
                const p = sidePick(ctx, hit);
                if (!p) return {};
                if (ranges.length === 1 && ranges[0].id === p.id && ranges[0].loop === p.loop && ranges[0].anchor[0] === p.anchor[0]) return {};
                ranges.push(p);
                return ranges.length === 2 ? finish() : { overlay: overlayOf() };
            }
            // free: the clicks pair up; the second click of a pair must be on the same loop of the
            // same piece as the first
            if (picks.length % 2 === 1 && !sameLoop(picks[picks.length - 1], hit)) return {};
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
// sides; a seam whose side no longer exists is removed (named in `removed`). `drawings` holds
// the piece's {sides, holes: [{sides}]}: a hole anchor reads its hole's sides, and a seam on a
// hole the piece no longer has (a fold back dropping the mirrored holes) is removed too.
export function reanchor(nodes, drawings, patternId) {
    const d = drawings.get(patternId);
    const ops = [];
    const removed = [];
    if (!d?.sides) return { ops, removed };
    const dead = new Set();
    for (const n of nodes) {
        if (n.kind !== "garment.seam") continue;
        const anchor = n.meta?.atelier;
        if (!anchor) continue;
        const fields = {};
        let gone = false;
        for (const end of ["a", "b"]) {
            if (n[end] !== patternId || !anchor[end]) continue;
            const [sf, tf, tt, st = sf] = anchor[end], loop = loopOf(anchor[end]);
            const sides = loopSides(d, loop), sideCount = sides ? sides.length - 1 : 0;
            if (sf >= sideCount || st >= sideCount) { gone = true; break; }
            const from = arcOf(sides, sf, tf), to = arcOf(sides, st, tt);
            if (Math.abs(from - n[`${end}_from`]) > 1e-6) fields[`${end}_from`] = from;
            if (Math.abs(to - n[`${end}_to`]) > 1e-6) fields[`${end}_to`] = to;
            if ((n[`${end}_loop`] ?? 0) !== loop) fields[`${end}_loop`] = loop;
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

// Every outer-outline anchor on piece `id` -- seam ends and M:N group ranges (seamgroup.js) --
// through fn(anchor) -> anchor; hole anchors are left (outerOnly). -> the set ops of the seams
// that changed
function mapAnchors(nodes, id, fn0) {
    const fn = outerOnly(fn0);
    const ops = [];
    for (const n of nodes) {
        if (n.kind !== "garment.seam" || !n.meta?.atelier) continue;
        let anchor = { ...n.meta.atelier }, moved = false;
        for (const end of ["a", "b"]) {
            if (n[end] !== id || !anchor[end]) continue;
            const next = fn(anchor[end]);
            if (JSON.stringify(next) !== JSON.stringify(anchor[end])) { anchor[end] = next; moved = true; }
        }
        const grouped = mapGroupRanges(anchor, id, fn);
        if (grouped !== anchor) { anchor = grouped; moved = true; }
        if (moved) ops.push({ op: "set", id: n.id, fields: { meta: { ...n.meta, atelier: anchor } } });
    }
    return ops;
}

// After a side is inserted at `at` in piece `id` (a fillet's arc): every seam anchor on that
// piece's outline naming side `at` or later names the next one.
export function shiftAnchors(nodes, id, at) {
    const bump = (s) => (s >= at ? s + 1 : s);
    return mapAnchors(nodes, id, ([sf, tf, tt, st]) => (st === undefined ? [bump(sf), tf, tt] : [bump(sf), tf, tt, bump(st)]));
}

// Every outline seam anchor on piece `id` rewritten by map(end) -> [side, t] (`end` the anchor end
// {side, t, isTo}): the 3-form when both ends land on one side running forward, else the 4-form.
function remapAnchors(nodes, id, map) {
    return mapAnchors(nodes, id, ([sf, tf, tt, st = sf]) => {
        const [a, ta] = map({ side: sf, t: tf, isTo: false }), [b, tb] = map({ side: st, t: tt, isTo: true });
        return a === b && ta <= tb ? [a, ta, tb] : [a, ta, tb, b];
    });
}
// After a point is inserted on side `side` of piece `id`, a fraction `t0` of its arc length
// along it (the side splits there into `side` and `side + 1`): every seam anchor on that piece
// keeps its place -- a fraction on the split side goes to the half it lies on, later sides move
// up one. A range's start exactly at the new point starts the second half; its end ends the first.
// The point is on the outline: anchors on the piece's holes are left.
export function splitAnchors(nodes, id, side, t0) {
    return remapAnchors(nodes, id, ({ side: s, t, isTo }) => {
        if (s < side) return [s, t];
        if (s > side) return [s + 1, t];
        const first = isTo ? t <= t0 : t < t0;
        return first ? [s, t0 > 0 ? t / t0 : 0] : [s + 1, t0 < 1 ? (t - t0) / (1 - t0) : 1];
    });
}
// The inverse, after point `vertex` of piece `id`'s loop of `count` sides is removed: the sides
// before and after it (`vertex - 1` and `vertex`; for point 0 the last side and side 0) become
// one, `w` the first one's share of their arc length. Its fractions are scaled onto the merged
// side, and the sides past it move down one. Removing point 0 makes old point 1 the start: every
// side moves down one, the merged side is the last. Hole anchors are left.
export function mergeAnchors(nodes, id, vertex, count, w) {
    const before = (vertex - 1 + count) % count, merged = vertex === 0 ? count - 2 : vertex - 1;
    return remapAnchors(nodes, id, ({ side: s, t }) => {
        if (s === before) return [merged, t * w];
        if (s === vertex) return [merged, w + t * (1 - w)];
        return [s > vertex ? s - 1 : s, t];
    });
}

// meta.atelier (`atelier`) with its group's ranges on piece `id` mapped by fn(anchor) -> anchor;
// fn's null dissolves the group (no group, no member). The same object when nothing changes.
export function mapGroupRanges(atelier, id, fn) {
    const g = atelier?.group;
    if (!g) return atelier;
    let moved = false, dead = false;
    const map = (rs) => rs.map((r) => {
        if (r.pattern !== id) return r;
        const next = fn(r.anchor);
        if (!next) { dead = true; return r; }
        if (JSON.stringify(next) === JSON.stringify(r.anchor)) return r;
        moved = true;
        return { ...r, anchor: next };
    });
    const a = map(g.a ?? []), b = map(g.b ?? []);
    if (dead) { const out = { ...atelier }; delete out.group; delete out.member; return out; }
    return moved ? { ...atelier, group: { ...g, a, b } } : atelier;
}
