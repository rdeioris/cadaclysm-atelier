// M:N sewing (A2 spec §1) against the real kernel: distribution by length into 1:1 seams, the
// re-distribution after an outline edit, Ungroup, Delete, one undo step per action.
import assert from "node:assert/strict";
import { loadKernel } from "./package.mjs";
import { Atelier } from "../kernel.js";
import * as m from "../model.js";
import { makeTool } from "../tools.js";
import { groupsIn, membersOf, ungroupOps, groupSelection } from "../seamgroup.js";
import { fieldsFor, opsFor } from "../props.js";

const k = await loadKernel();
const params = Object.fromEntries(m.FABRIC_FIELDS.map((n) => [n, 1]));
const a = new Atelier(k);
a.apply(m.newDocumentOps({ slug: "x", label: "X", params }), "new");
// p1 100 x 50 (sides 0..100, 100..150, 150..250, 250..300), p2 150 x 50, p3 100 x 50
a.apply(m.addPattern(a.nodes(), { label: "P1", path: m.rectPath(0, 0, 100, 50), fabric: "f_x" }).ops, "p");
a.apply(m.addPattern(a.nodes(), { label: "P2", path: m.rectPath(200, 0, 150, 50), fabric: "f_x" }).ops, "p");
a.apply(m.addPattern(a.nodes(), { label: "P3", path: m.rectPath(400, 0, 100, 50), fabric: "f_x" }).ops, "p");

const ctx = () => ({ nodes: a.nodes(), drawings: new Map(a.drawings().map((d) => [d.id, d])) });
const sidesOf = (id) => a.drawing(id).sides;
// a click on side `side` of piece `id` a fraction `t` along it (t < 0.5: the range runs with the arc)
const hit = (id, side, t = 0.25) => { const s = sidesOf(id); return { kind: "edge", id, side, s: s[side] + t * (s[side + 1] - s[side]) }; };
// the tool's picks: A's then B's (each [id, side, t] or a free range [id, s1, s2]), Enter between and after
function sew(A, B) {
    const t = makeTool("sewmn", ctx());
    const pick = (p) => {
        if (p[0] === "free") {
            const [, id, s1, s2] = p, side = (s) => sidesOf(id).findIndex((v, i) => s >= v && s < sidesOf(id)[i + 1]);
            t.down([0, 0], { kind: "edge", id, s: s1, side: side(s1) }, { shift: true });
            return t.down([0, 0], { kind: "edge", id, s: s2, side: side(s2) }, { shift: true });
        }
        return t.down([0, 0], hit(...p), {});
    };
    for (const p of A) assert.ok(pick(p).overlay.lines.length > 0);
    t.key("Enter");
    for (const p of B) pick(p);
    const r = t.key("Enter");
    assert.ok(r.done && r.ops.length);
    a.apply(r.ops, "sew M:N");
    return r.select.ids;
}
const near = (x, y) => Math.abs(x - y) < 1e-6;
const row = (id) => { const n = a.nodes().find((x) => x.id === id); return [n.a, n.a_from, n.a_to, n.b, n.b_from, n.b_to, n.reversed]; };
const same = (got, want) => {
    assert.equal(got.length, want.length, `${JSON.stringify(got)} vs ${JSON.stringify(want)}`);
    got.forEach((v, i) => (typeof v === "number" ? assert.ok(near(v, want[i]), `${JSON.stringify(got)} vs ${JSON.stringify(want)}`) : assert.equal(v, want[i])));
};
const seamCount = () => a.nodes().filter((n) => n.kind === "garment.seam").length;
const head = () => a.head();

// 2 -> 1: P1's bottom and right onto P2's bottom, end to end
{
    const ids = sew([["p1", 0], ["p1", 1]], [["p2", 0]]);
    assert.equal(ids.length, 2);
    same(row(ids[0]), ["p1", 0, 100, "p2", 0, 100, false]);
    same(row(ids[1]), ["p1", 100, 150, "p2", 100, 150, false]);
    assert.equal(a.problems().length, 0);
    assert.equal(a.seams().length, 2, "the kernel draws both");
    assert.deepEqual(a.nodes().find((n) => n.id === "garment").seams, ids, "the garment lists both");
    const g = groupsIn(a.nodes());
    assert.equal(g.size, 1);
    const [{ group, members }] = g.values();
    assert.deepEqual(members.map((n) => n.id), ids);
    assert.deepEqual(group.a.map((r) => [r.pattern, r.anchor, r.dir]), [["p1", [0, 0, 1], 1], ["p1", [1, 0, 1], 1]]);
    // one undo takes the whole group back out
    assert.ok(a.undo());
    assert.equal(seamCount(), 0);
}
// 1 -> 3: P2's bottom (150) onto P1's bottom, right and top (250; the top picked near its end, so
// it runs against the arc and that member is reversed)
{
    const ids = sew([["p2", 0]], [["p1", 0], ["p1", 1], ["p1", 2, 0.75]]);
    assert.equal(ids.length, 3);
    same(row(ids[0]), ["p2", 0, 60, "p1", 0, 100, false]);
    same(row(ids[1]), ["p2", 60, 90, "p1", 100, 150, false]);
    same(row(ids[2]), ["p2", 90, 150, "p1", 150, 250, true]);
    assert.equal(a.seams().length, 3);
    a.undo();
}
// 2 -> 2, unequal: P1 bottom + right (150) onto P2 bottom + right (200): B's boundary lands at
// 112.5 on A, A's at 100: three seams (M + N - 1)
{
    const ids = sew([["p1", 0], ["p1", 1]], [["p2", 0], ["p2", 1]]);
    assert.equal(ids.length, 3);
    same(row(ids[0]), ["p1", 0, 100, "p2", 0, 400 / 3, false]);
    same(row(ids[1]), ["p1", 100, 112.5, "p2", 400 / 3, 150, false]);
    same(row(ids[2]), ["p1", 112.5, 150, "p2", 150, 200, false]);
    a.undo();
}
// a free range (Shift and two clicks): P1 from 280 back to 20 through arc 0 (the short way, 40 mm)
// onto P3's bottom
{
    const ids = sew([["free", "p1", 280, 20]], [["p3", 0]]);
    assert.equal(ids.length, 1);
    same(row(ids[0]), ["p1", 280, 20, "p3", 0, 100, false]);
    a.undo();
}

// an outline edit re-distributes in the same batch (one undo step): P1 bottom + right onto P3
// bottom + right, equal lengths, so their boundaries meet: two seams
{
    const ids = sew([["p1", 0], ["p1", 1]], [["p3", 0], ["p3", 1]]);
    assert.equal(ids.length, 2);
    same(row(ids[1]), ["p1", 100, 150, "p3", 100, 150, false]);
    // P1 twice the size: 200 + 100 onto 150, the boundaries still meet: as many seams, the ids kept
    const before = head();
    a.commit(m.setOutline(a.nodes(), "p1", m.rectPath(0, 0, 200, 100)), "edit", "p1");
    assert.deepEqual(membersOf(a.nodes(), ids[0]), ids, "the ids kept");
    same(row(ids[0]), ["p1", 0, 200, "p3", 0, 100, false]);
    same(row(ids[1]), ["p1", 200, 300, "p3", 100, 150, false]);
    assert.equal(a.problems().length, 0);
    // P1 120 wide instead: A's boundary at 120 of 170, B's at 100 * 170 / 150: three seams, new ids
    a.commit(m.setOutline(a.nodes(), "p1", m.rectPath(0, 0, 120, 50)), "edit", "p1");
    const three = [...groupsIn(a.nodes()).values()][0].members.map((n) => n.id);
    assert.equal(three.length, 3);
    same(row(three[0]), ["p1", 0, 340 / 3, "p3", 0, 100, false]);
    same(row(three[1]), ["p1", 340 / 3, 120, "p3", 100, 150 * 120 / 170, false]);
    same(row(three[2]), ["p1", 120, 170, "p3", 150 * 120 / 170, 150, false]);
    assert.equal(a.nodes().find((n) => n.id === "garment").seams.length, 3);
    // one undo per edit: back to two seams with their ids, then to the 100 x 50 piece
    a.undo();
    assert.deepEqual([...groupsIn(a.nodes()).values()][0].members.map((n) => n.id), ids);
    same(row(ids[1]), ["p1", 200, 300, "p3", 100, 150, false]);
    a.undo();
    assert.equal(head(), before);
    same(row(ids[1]), ["p1", 100, 150, "p3", 100, 150, false]);

    // selection: one member selects the group; the panel shows its ranges and Ungroup
    const sel = groupSelection({ kind: "seam", id: ids[1] }, a.nodes());
    assert.deepEqual(sel, { kind: "seam", id: ids[0], ids });
    const drawings = ctx().drawings;
    const fields = fieldsFor(sel, a.nodes(), drawings);
    assert.ok(fields.some((f) => f.key === "ungroup"));
    assert.ok(fields.some((f) => f.key === "range-A2" && f.value === "P1, 50.0 mm"));
    assert.ok(fields.some((f) => f.key === "lengthB" && f.value === "150.0 mm"));

    // Delete removes every member: one batch, one undo
    a.apply(opsFor(sel, a.nodes(), "remove", null), "remove seam group");
    assert.equal(seamCount(), 0);
    a.undo();
    assert.equal(seamCount(), 2);

    // Ungroup: plain 1:1 seams, no longer re-distributed (re-anchored on their own sides instead)
    a.apply(opsFor(sel, a.nodes(), "ungroup", null), "ungroup");
    assert.equal(groupsIn(a.nodes()).size, 0);
    assert.equal(membersOf(a.nodes(), ids[0]), null);
    a.commit(m.setOutline(a.nodes(), "p1", m.rectPath(0, 0, 100, 100)), "edit", "p1");
    same(row(ids[0]), ["p1", 0, 100, "p3", 0, 100, false]);
    same(row(ids[1]), ["p1", 100, 200, "p3", 100, 150, false]);
    a.undo();
    a.undo();
    assert.equal(groupsIn(a.nodes()).size, 1, "the ungroup undone");
    assert.deepEqual(ungroupOps(a.nodes(), []), []);
}

// a point added on a ranged side keeps the group whole: the range's anchor splits with its side
{
    const [id0] = [...groupsIn(a.nodes()).values()][0].members.map((n) => n.id);
    a.commit(a.insertPointOps("p1", 50), "point", "p1");
    const { group, members } = [...groupsIn(a.nodes()).values()][0];
    assert.deepEqual(group.a.map((r) => r.anchor), [[0, 0, 1, 1], [2, 0, 1]]);
    assert.equal(members.length, 2);
    assert.equal(members[0].id, id0);
    same(row(id0), ["p1", 0, 100, "p3", 0, 100, false]);
    a.undo();
}

// a removed piece takes the group's seams with it; undo brings the group back
{
    a.apply(m.removePattern(a.nodes(), "p3"), "remove piece");
    assert.equal(seamCount(), 0);
    a.undo();
    assert.equal(groupsIn(a.nodes()).size, 1);
}
console.log("seamgroup-kernel: ok");
