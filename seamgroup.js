// M:N sewing (A2 spec §1): an app-level group of the kernel's 1:1 seams. Side A's ranges, end to
// end, map onto side B's, end to end, by length (arc a on A is a * Lb / La on B); every range
// boundary on either side cuts the run, and each piece of it is one kernel seam (at most
// M + N - 1). Each member carries meta.atelier.group = {id, a: [ranges], b: [ranges]} (a range is
// {pattern, anchor, dir}: the anchor in Segment sewing's form, dir +1 when the range runs with
// the outline's arc length, -1 against it, as picked) and meta.atelier.member, its place in the
// run. Arc-length arithmetic only: the sides come from the kernel's drawings. A range may lie on
// a hole of its piece (A2 spec §2): its anchor is then the 5-form with the loop (sewing.js), its
// lengths the hole's own, and the member seams carry a_loop/b_loop. sidesOf(pattern, loop) gives
// the sides of either.
import { addSeam, nextId } from "./model.js";
import { anchorOf, sidePick, freeRange, rangeLine, loopOf, loopSides, sewableHit, hitLoop, sameLoop } from "./sewing.js";
export { mapGroupRanges } from "./sewing.js";

const EPS = 1e-9;
const groupOf = (n) => (n?.kind === "garment.seam" ? n.meta?.atelier?.group ?? null : null);
export { groupOf };
const arcOf = (sides, side, t) => sides[side] + t * (sides[side + 1] - sides[side]);

// A range's arcs on its piece's `sides`: {from, to, len} (from > to: it runs through arc 0), or
// null when a side it names is gone.
export function rangeArcs(sides, anchor) {
    if (!sides || !anchor) return null;
    const [sf, tf, tt, st = sf] = anchor, count = sides.length - 1;
    if (!(sf >= 0 && st >= 0 && sf < count && st < count)) return null;
    const P = sides.at(-1), from = arcOf(sides, sf, tf), to = arcOf(sides, st, tt);
    return { from, to, len: from <= to && !(sf === st && tf > tt) ? to - from : P - from + to };
}

// Side A's and side B's ranges ({sides, from, len, dir} each) distributed by length.
// -> [{a: {from, to}, b: {from, to}, ia, ib, reversed}] in run order (ia, ib: the range indices)
export function distribute(A, B) {
    const sum = (rs) => rs.reduce((s, r) => s + r.len, 0);
    const La = sum(A), Lb = sum(B);
    if (!(La > 0 && Lb > 0)) throw new Error("M:N sewing: a side has no length");
    const cum = (rs, k) => { const c = [0]; for (const r of rs) c.push(c.at(-1) + r.len * k); return c; };
    const ca = cum(A, 1), cb = cum(B, La / Lb);     // B's boundaries in A's arc length
    ca[ca.length - 1] = La; cb[cb.length - 1] = La;
    const tol = EPS * La * 1e3;
    const cuts = [];
    for (const u of [...ca, ...cb].sort((x, y) => x - y)) if (!cuts.length || u - cuts.at(-1) > tol) cuts.push(u);
    if (La - cuts.at(-1) > 0) cuts[cuts.length - 1] = La;
    const index = (c, u) => { let i = 0; while (i < c.length - 2 && c[i + 1] <= u) i++; return i; };
    // the stretch o0..o1 (travel offsets) of range r as arcs on its outline, running with the arc
    const part = (r, o0, o1) => {
        o0 = Math.max(0, Math.min(r.len, o0)); o1 = Math.max(0, Math.min(r.len, o1));
        const P = r.sides.at(-1);
        let s0 = r.dir > 0 ? r.from + o0 : r.from + r.len - o1, s1 = r.dir > 0 ? r.from + o1 : r.from + r.len - o0;
        if (s0 >= P - 1e-9) { s0 -= P; s1 -= P; }
        s0 = Math.max(0, s0);
        if (s1 > P + 1e-9) s1 -= P; else s1 = Math.min(s1, P);
        return { from: s0, to: s1 };
    };
    const out = [];
    for (let j = 0; j + 1 < cuts.length; j++) {
        const u0 = cuts[j], u1 = cuts[j + 1], mid = (u0 + u1) / 2;
        const ia = index(ca, mid), ib = index(cb, mid), k = Lb / La;
        out.push({
            ia, ib, reversed: A[ia].dir !== B[ib].dir,
            a: part(A[ia], u0 - ca[ia], u1 - ca[ia]),
            b: part(B[ib], (u0 - cb[ib]) * k, (u1 - cb[ib]) * k),
        });
    }
    return out;
}

// The member seams of `group` as seam fields ({a, b, a_from, ..., reversed, meta}), the ranges
// read from their anchors on the sides now (sidesOf(pattern) -> sides). null when a range's
// piece or side is gone (the group can no longer be distributed).
export function groupMembers(group, sidesOf) {
    const resolve = (rs) => rs.map((r) => {
        const loop = loopOf(r.anchor);
        let sides = null;
        try { sides = sidesOf(r.pattern, loop); } catch { sides = null; }
        const arcs = rangeArcs(sides, r.anchor);
        return arcs && arcs.len > 0 ? { ...arcs, sides, loop, dir: r.dir < 0 ? -1 : 1, pattern: r.pattern } : null;
    });
    const A = resolve(group.a ?? []), B = resolve(group.b ?? []);
    if (!A.length || !B.length || A.includes(null) || B.includes(null)) return null;
    return distribute(A, B).map((p, k) => {
        const ra = A[p.ia], rb = B[p.ib];
        return {
            a: ra.pattern, b: rb.pattern, a_from: p.a.from, a_to: p.a.to, b_from: p.b.from, b_to: p.b.to, reversed: p.reversed,
            // a hole end's loop; an outline end has none (absent is 0, as the kernel writes it)
            ...(ra.loop ? { a_loop: ra.loop } : {}), ...(rb.loop ? { b_loop: rb.loop } : {}),
            meta: { atelier: { a: anchorOf(ra.sides, p.a.from, p.a.to, ra.loop), b: anchorOf(rb.sides, p.b.from, p.b.to, rb.loop), group, member: k } },
        };
    });
}

// Every group in `nodes`: id -> {group, members: the member nodes in run order}.
export function groupsIn(nodes) {
    const out = new Map();
    for (const n of nodes) {
        const g = groupOf(n);
        if (!g) continue;
        const e = out.get(g.id) ?? { group: g, members: [] };
        e.members.push(n);
        out.set(g.id, e);
    }
    for (const e of out.values()) e.members.sort((x, y) => (x.meta.atelier.member ?? 0) - (y.meta.atelier.member ?? 0));
    return out;
}
// The member ids of the group seam `id` belongs to, in run order; null when it is a plain seam.
export function membersOf(nodes, id) {
    const g = groupOf(nodes.find((n) => n.id === id));
    return g ? groupsIn(nodes).get(g.id).members.map((n) => n.id) : null;
}
// A seam selection widened to its whole group (id: the first member, ids: all of them); any
// other selection as it is.
export function groupSelection(sel, nodes) {
    if (sel?.kind !== "seam") return sel;
    const ids = membersOf(nodes, sel.id);
    return ids ? { kind: "seam", id: ids[0], ids } : sel;
}

const garmentSet = (nodes, seams) => {
    const g = nodes.find((n) => n.id === "garment");
    return { op: "set", id: "garment", fields: { patterns: g.patterns, seams } };
};
// meta without the group (an Ungroup, or a group whose ranges can no longer be read)
const plainMeta = (meta) => {
    const atelier = { ...(meta?.atelier ?? {}) };
    delete atelier.group; delete atelier.member;
    return { ...(meta ?? {}), atelier };
};

// A new group's ops: side A's `A` and side B's `B` ranges ({id, anchor, dir}, as the Sew M:N tool
// picks them), distributed on `sidesOf`. -> {ops, ids, group}
export function sewGroupOps(nodes, sidesOf, A, B) {
    const taken = [...groupsIn(nodes).keys()].map((id) => ({ id }));
    const group = {
        id: nextId(taken, "g"),
        a: A.map((r) => ({ pattern: r.id, anchor: r.anchor, dir: r.dir })),
        b: B.map((r) => ({ pattern: r.id, anchor: r.anchor, dir: r.dir })),
    };
    const members = groupMembers(group, sidesOf);
    if (!members) throw new Error("M:N sewing: a range has no length");
    const adds = [], ids = [];
    let cur = nodes;
    for (const s of members) {
        const r = addSeam(cur, { ...s, anchor: s.meta.atelier });
        adds.push(r.ops[0]); ids.push(r.id);
        cur = [...cur, r.ops[0].node];
    }
    const seams = nodes.find((n) => n.id === "garment")?.seams ?? [];
    return { ops: [...adds, garmentSet(nodes, [...seams, ...ids])], ids, group };
}

const close = (x, y) => Math.abs(x - y) <= 1e-6;
const sameSeam = (n, s) => n.a === s.a && n.b === s.b && !!n.reversed === s.reversed
    && ["a_from", "a_to", "b_from", "b_to"].every((k) => close(n[k], s[k]))
    && ["a_loop", "b_loop"].every((k) => (n[k] ?? 0) === (s[k] ?? 0))
    && JSON.stringify(n.meta?.atelier ?? null) === JSON.stringify(s.meta.atelier);

// After a batch: every group re-distributed from its ranges' anchors on the sides now
// (sidesOf(pattern) -> sides). A group whose members already match is left; with as many members
// as before they are set in place (their ids kept), else replaced; a group whose ranges can no
// longer be read (a piece or side gone) is dissolved, its members left as plain seams.
export function redistributeOps(nodes, sidesOf) {
    const ops = [];
    let seams = nodes.find((n) => n.id === "garment")?.seams ?? [];
    let fresh = nodes, changedList = false;
    for (const { group, members } of groupsIn(nodes).values()) {
        const want = groupMembers(group, sidesOf);
        if (!want) {
            for (const n of members) ops.push({ op: "set", id: n.id, fields: { meta: plainMeta(n.meta) } });
            continue;
        }
        if (want.length === members.length) {
            members.forEach((n, k) => {
                if (sameSeam(n, want[k])) return;
                const { meta, ...rest } = want[k];
                // an end that moved off a hole onto the outline: its loop set back to 0
                for (const l of ["a_loop", "b_loop"]) if (n[l] && !rest[l]) rest[l] = 0;
                ops.push({ op: "set", id: n.id, fields: { ...rest, meta: { ...(n.meta ?? {}), atelier: meta.atelier } } });
            });
            continue;
        }
        const gone = new Set(members.map((n) => n.id));
        const at = seams.findIndex((s) => gone.has(s));
        const added = [];
        for (const s of want) {
            const id = nextId(fresh, "s");
            const { meta, ...fields } = s;
            const node = { id, kind: "garment.seam", ...fields, meta };
            ops.push({ op: "add", node });
            fresh = [...fresh, node];
            added.push(id);
        }
        const kept = seams.filter((s) => !gone.has(s));
        seams = at < 0 ? [...kept, ...added] : [...kept.slice(0, at), ...added, ...kept.slice(at)];
        for (const id of gone) ops.push({ op: "remove", id });
        changedList = true;
    }
    if (changedList) ops.push(garmentSet(nodes, seams));
    return ops;
}

// Ungroup: the group's members stay as plain 1:1 seams. One batch.
export const ungroupOps = (nodes, ids) => ids.map((id) => nodes.find((n) => n.id === id)).filter(Boolean)
    .map((n) => ({ op: "set", id: n.id, fields: { meta: plainMeta(n.meta) } }));

// The group's ranges for the panel: [{side: "A"|"B", k, pattern, length}] on `sidesOf`.
export function groupRanges(group, sidesOf) {
    const out = [];
    for (const [side, rs] of [["A", group.a ?? []], ["B", group.b ?? []]]) {
        rs.forEach((r, k) => {
            let sides = null;
            try { sides = sidesOf(r.pattern, loopOf(r.anchor)); } catch { sides = null; }
            out.push({ side, k, pattern: r.pattern, loop: loopOf(r.anchor), length: rangeArcs(sides, r.anchor)?.len ?? NaN });
        });
    }
    return out;
}

export const namesPiece = (n, id) => !!groupOf(n) && [...(groupOf(n).a ?? []), ...(groupOf(n).b ?? [])].some((r) => r.pattern === id);

// The Sew M:N tool (key B): side A's ranges (a click on a side takes the whole side, running
// away from the end nearer the click; Shift and two clicks take a free range, first click to
// second), Enter, side B's the same way, Enter sews. Backspace drops the last range (or the
// first click of a free one); Escape cancels. A hole's edge is picked the same way: a click
// takes the hole's side, Shift and two clicks on the same hole a free range on it.
export function makeGroupTool(ctx) {
    const sides = { a: [], b: [] };
    let phase = "a", first = null;
    const sidesOf = (id, loop = 0) => loopSides(ctx.drawings.get(id), loop);
    const overlay = () => {
        const lines = [], labels = [];
        for (const k of ["a", "b"]) sides[k].forEach((r, i) => {
            const pts = rangeLine(ctx.drawings.get(r.id), r.from, r.to, r.loop);
            if (pts.length < 2) return;
            lines.push(r.dir > 0 ? pts : [...pts].reverse());
            labels.push({ at: pts[Math.floor(pts.length / 2)], text: `${k.toUpperCase()}${i + 1}` });
        });
        return { lines, labels, ...(first ? { points: [[...first.w]] } : {}) };
    };
    return {
        down(w, hit, mods) {
            if (!sewableHit(hit)) return {};
            const s = sidesOf(hit.id, hitLoop(hit));
            if (!s || !(hit.side >= 0) || hit.side >= s.length - 1) return {};
            if (mods?.shift || first) {
                if (!first) { first = { hit, w }; return { overlay: overlay() }; }
                if (!sameLoop(first.hit, hit) || first.hit.s === hit.s) return {};
                const r = freeRange(ctx, hit.id, first.hit, hit);
                first = null;
                sides[phase].push({ id: r.id, loop: r.loop, from: r.from, to: r.to, anchor: r.anchor, dir: r.dir });
                return { overlay: overlay() };
            }
            const p = sidePick(ctx, hit);
            if (!p) return {};
            sides[phase].push({ id: p.id, loop: p.loop, from: p.from, to: p.to, anchor: p.anchor, dir: p.near ? -1 : 1 });
            return { overlay: overlay() };
        },
        move() { return {}; },
        up() { return {}; },
        key(k) {
            if (k === "Escape") { sides.a.length = 0; sides.b.length = 0; first = null; phase = "a"; return { overlay: { lines: [] }, done: true }; }
            if (k === "Backspace") {
                if (first) first = null;
                else if (sides[phase].length) sides[phase].pop();
                else if (phase === "b") { phase = "a"; sides.a.pop(); }
                return { overlay: overlay() };
            }
            if (k !== "Enter" || first) return {};
            if (phase === "a") { if (!sides.a.length) return {}; phase = "b"; return { overlay: overlay(), status: "M:N: now side B's ranges, then Enter sews", error: false }; }
            if (!sides.b.length) return {};
            const r = sewGroupOps(ctx.nodes, sidesOf, sides.a, sides.b);
            sides.a.length = 0; sides.b.length = 0; phase = "a";
            return { ops: r.ops, overlay: { lines: [] }, select: { kind: "seam", id: r.ids[0], ids: r.ids }, done: true };
        },
    };
}
