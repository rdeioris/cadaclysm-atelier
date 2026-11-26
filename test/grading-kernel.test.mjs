// Grading (A3 spec §8) against the real kernel: a size switch is one batch that grades every
// piece's outline from its base and rules, moves internal lines by the affine fit and notches by
// their side fraction, keeps seams on their sides and re-distributes M:N groups; a drag in a
// graded size sets rules, an edit in the base moves the base, point ops shift the rules,
// Distribute, Proportional and a base change; linked and unfolded pieces; save and open.
import assert from "node:assert/strict";
import { loadKernel } from "./package.mjs";
import { Atelier } from "../kernel.js";
import * as m from "../model.js";
import * as G from "../grading.js";
import { movePoint } from "../tools.js";
import { sewGroupOps, membersOf } from "../seamgroup.js";

const k = await loadKernel();
const params = Object.fromEntries(m.FABRIC_FIELDS.map((n) => [n, 1]));
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} vs ${b}`);
const nearPts = (ps, qs, e = 1e-6) => { assert.equal(ps.length, qs.length, `${JSON.stringify(ps)} vs ${JSON.stringify(qs)}`); ps.forEach((p, i) => { near(p[0], qs[i][0], e); near(p[1], qs[i][1], e); }); };
const node = (a, id) => m.byId(a.nodes()).get(id);
const outline = (a, id) => node(a, `${id}_outline`).path;
const verts = (a, id) => G.vertices(outline(a, id));
const table = (a) => a.grading();
const grade = (a, id) => G.gradeOf(node(a, id));
const seam = (a, id) => node(a, id);
const flat = (path) => JSON.stringify([path.start, path.segments], (_, v) => (typeof v === "number" ? Math.round(v * 1e6) / 1e6 + 0 : v));
const sizes = (a, action) => { const r = a.sizesOps(action); a.commit(r.ops, "sizes", r.ids); };
const gradeOp = (a, action) => { const r = a.gradeOps(action); a.commit(r.ops, "grade", r.ids); };
// a drag of outline points `indices` of piece `id` by d, committed as the edit tool does
const drag = (a, id, indices, d) => { const p = JSON.parse(JSON.stringify(outline(a, id))); for (const i of indices) movePoint(p, i, d); return a.commit(m.setOutline(a.nodes(), id, p), "edit", id); };

const a = new Atelier(k);
a.reset(m.newDocumentOps({ slug: "x", label: "X", params }));
{
    const add = m.addPattern(a.nodes(), { label: "A", path: m.rectPath(0, 0, 100, 50), fabric: "f_x" });
    const pn = add.ops.find((o) => o.node?.kind === "garment.pattern").node;
    pn.notches = [{ at: 40, kind: "slit", depth: 6 }];
    pn.internal = [{ kind: "line", path: m.openPath([[20, 10], [80, 40]]) }];
    pn.meta = { form: "kept" };              // another lane's meta survives
    a.apply(add.ops, "a");
}
a.apply(m.addPattern(a.nodes(), { label: "B", path: m.rectPath(200, 0, 100, 50), fabric: "f_x" }).ops, "b");
// A's right side (100..150) sewn to B's left side (350..400)
a.apply(m.addSeam(a.nodes(), { a: "p1", b: "p2", a_from: 100, a_to: 150, b_from: 350, b_to: 400, reversed: true, anchor: { a: [1, 0, 1], b: [3, 0, 1] } }).ops, "sew");
const rect = outline(a, "p1");

// ---- the size table: M the base, S before it, L and XL after; each one batch ----
sizes(a, { op: "add", name: "M" });
sizes(a, { op: "add", name: "S", at: 0 });
sizes(a, { op: "add", name: "L" });
sizes(a, { op: "add", name: "XL" });
assert.deepEqual(table(a), { sizes: ["S", "M", "L", "XL"], base: "M", current: "M" });
assert.equal(a.undo(), true);
assert.deepEqual(table(a).sizes, ["S", "M", "L"]);
a.redo();
assert.deepEqual(table(a).sizes, ["S", "M", "L", "XL"]);

// ---- A's right side graded +10 mm a size: rules set in M change no outline ----
for (const v of [1, 2]) for (const [s, dx] of [["S", -10], ["L", 10], ["XL", 20]]) gradeOp(a, { op: "rule", id: "p1", vertex: v, size: s, d: [dx, 0] });
assert.equal(flat(outline(a, "p1")), flat(rect), "rules in the base size leave the outline");
assert.deepEqual(grade(a, "p1").rules, { 1: { S: [-10, 0], L: [10, 0], XL: [20, 0] }, 2: { S: [-10, 0], L: [10, 0], XL: [20, 0] } });
assert.equal(node(a, "p1").meta.form, "kept");
assert.throws(() => a.gradeOps({ op: "rule", id: "p1", vertex: 1, size: "M", d: [1, 0] }), /base size's rule/);

// ---- switch to L: the right side moves, the seam stays on it, the notch at its fraction, the
// internal line by the affine fit (here exactly x' = 1.1 x); one undo step ----
{
    const head = a.head();
    a.switchSize("L");
    assert.equal(table(a).current, "L");
    nearPts(verts(a, "p1"), [[0, 0], [110, 0], [110, 50], [0, 50]]);
    near(seam(a, "s1").a_from, 110); near(seam(a, "s1").a_to, 160);
    assert.deepEqual(seam(a, "s1").meta.atelier.a, [1, 0, 1]);
    near(node(a, "p1").notches[0].at, 44);
    nearPts(G.vertices({ start: node(a, "p1").internal[0].path.start, segments: [...node(a, "p1").internal[0].path.segments, { type: "line", to: [0, 0] }] }).slice(0, 2), [[22, 10], [88, 40]]);
    assert.deepEqual(grade(a, "p1").rules[1].L, [10, 0], "the switch keeps the rules");
    assert.equal(flat(grade(a, "p1").base), flat(rect));
    assert.deepEqual(a.problems(), []);
    assert.equal(a.undo(), true);
    assert.equal(table(a).current, "M");
    assert.equal(flat(outline(a, "p1")), flat(rect));
    near(seam(a, "s1").a_from, 100); near(seam(a, "s1").a_to, 150);
    near(node(a, "p1").notches[0].at, 40);
    nearPts([node(a, "p1").internal[0].path.start, node(a, "p1").internal[0].path.segments[0].to], [[20, 10], [80, 40]]);
    assert.equal(a.head(), head, "one undo step");
    a.redo();
    assert.equal(table(a).current, "L");
    // XL, S and back to M: the same arithmetic, no drift
    a.switchSize("XL"); nearPts(verts(a, "p1"), [[0, 0], [120, 0], [120, 50], [0, 50]]); near(node(a, "p1").notches[0].at, 48);
    a.switchSize("S"); nearPts(verts(a, "p1"), [[0, 0], [90, 0], [90, 50], [0, 50]]); near(seam(a, "s1").a_to, 140);
    a.switchSize("M");
    assert.equal(flat(outline(a, "p1")), flat(rect));
    near(node(a, "p1").notches[0].at, 40, 1e-9);
    nearPts([node(a, "p1").internal[0].path.start, node(a, "p1").internal[0].path.segments[0].to], [[20, 10], [80, 40]], 1e-9);
    assert.throws(() => a.switchSize("XXL"), /no size XXL/);
}

// ---- a drag in L sets that vertex's rule; back in M the outline is unchanged ----
a.switchSize("L");
drag(a, "p1", [2], [5, 5]);
assert.deepEqual(grade(a, "p1").rules[2], { S: [-10, 0], L: [15, 5], XL: [20, 0] });
nearPts(verts(a, "p1"), [[0, 0], [110, 0], [115, 55], [0, 50]]);
a.switchSize("M");
assert.equal(flat(outline(a, "p1")), flat(rect), "M is the base, unchanged");
a.switchSize("L");
nearPts(verts(a, "p1"), [[0, 0], [110, 0], [115, 55], [0, 50]]);

// ---- in L the shape edits are refused: point ops, fillet, cut, a point more by hand ----
{
    const msg = /edit the shape in the base size \(M\)/;
    assert.throws(() => a.pointOps({ id: "p1", op: "insert", s: 30 }), msg);
    assert.throws(() => a.pointOps({ id: "p1", op: "smooth", points: [{ index: 1, smooth: true }] }), msg);
    assert.throws(() => a.filletOps("p1", 1, 5), msg);
    assert.throws(() => a.cutOps("p1", m.openPath([[50, -10], [50, 70]])), msg);
    const head = a.head(), p = outline(a, "p1");
    const more = { start: p.start, segments: [{ type: "line", to: [30, 0] }, ...p.segments] };
    assert.throws(() => a.commit(m.setOutline(a.nodes(), "p1", more), "edit", "p1"), msg);
    assert.equal(a.head(), head, "a refusal changes nothing");
    // an internal line's point stays editable
    a.commit(a.pointOps({ id: "p1", line: 0, op: "insert", at: [55, 25] }), "point", null);
    assert.equal(node(a, "p1").internal[0].path.segments.length, 2);
    a.undo();
}

// ---- an edit in M moves the base, and L follows ----
a.switchSize("M");
drag(a, "p1", [3], [0, 10]);
nearPts(G.vertices(grade(a, "p1").base), [[0, 0], [100, 0], [100, 50], [0, 60]]);
a.switchSize("L");
nearPts(verts(a, "p1"), [[0, 0], [110, 0], [115, 55], [0, 60]]);
a.switchSize("M");

// ---- a point inserted in M shifts the rule indices (the new one between its neighbours) ----
a.commit(a.pointOps({ id: "p1", op: "insert", s: 125 }), "point", "p1");      // half way up the right side
{
    const r = grade(a, "p1").rules;
    assert.deepEqual(Object.keys(r), ["1", "2", "3"]);
    assert.deepEqual(r[2].S, [-10, 0]); nearPts([r[2].L, r[2].XL], [[12.5, 2.5], [20, 0]]);
    assert.deepEqual(r[3], { S: [-10, 0], L: [15, 5], XL: [20, 0] });
    assert.equal(grade(a, "p1").base.segments.length, 5);
    a.switchSize("L");
    nearPts(verts(a, "p1"), [[0, 0], [110, 0], [112.5, 27.5], [115, 55], [0, 60]]);
    near(seam(a, "s1").a_from, 110, 1e-6);
    a.switchSize("M");
    a.commit(a.pointOps({ id: "p1", op: "remove", indices: [2] }), "point", "p1");
    assert.deepEqual(Object.keys(grade(a, "p1").rules), ["1", "2"]);
    assert.deepEqual(grade(a, "p1").rules[2].L, [15, 5]);
}

// ---- Distribute and Proportional ----
a.apply(m.addPattern(a.nodes(), { label: "C", path: m.rectPath(0, 200, 100, 50), fabric: "f_x" }).ops, "c");
for (const s of [75, 50, 25]) a.commit(a.pointOps({ id: "p3", op: "insert", s }), "point", "p3");
assert.equal(outline(a, "p3").segments.length, 7);
gradeOp(a, { op: "rule", id: "p3", vertex: 4, size: "L", d: [8, 0] });
gradeOp(a, { op: "rule", id: "p3", vertex: 4, size: "XL", d: [16, 0] });
gradeOp(a, { op: "distribute", id: "p3", from: 0, to: 4 });
{
    const r = grade(a, "p3").rules;
    [[1, 2], [2, 4], [3, 6]].forEach(([v, dx]) => { near(r[v].L[0], dx); near(r[v].XL[0], 2 * dx); near(r[v].L[1], 0); });
}
gradeOp(a, { op: "proportional", ids: ["p3"], dw: 20, dh: 10 });
a.switchSize("L");
{
    const vs = verts(a, "p3"), xs = vs.map((p) => p[0]), ys = vs.map((p) => p[1]);
    near(Math.max(...xs) - Math.min(...xs), 120); near(Math.max(...ys) - Math.min(...ys), 60);
    nearPts([vs[0], vs[2]], [[-10, 195], [50, 195]]);
}
a.switchSize("XL");
{ const xs = verts(a, "p3").map((p) => p[0]); near(Math.max(...xs) - Math.min(...xs), 140); }
a.switchSize("S");
{ const xs = verts(a, "p3").map((p) => p[0]); near(Math.max(...xs) - Math.min(...xs), 80); }

// ---- a base change re-expresses the rules; the outline in the current size stays ----
{
    const before = flat(outline(a, "p1")), rulesM = grade(a, "p1").rules;
    sizes(a, { op: "base", name: "L" });
    assert.equal(table(a).base, "L");
    assert.equal(flat(outline(a, "p1")), before, "S is still drawn");
    const r = grade(a, "p1").rules;
    assert.deepEqual(r[2], { S: [-25, -5], M: [-15, -5], XL: [5, -5] });
    nearPts(G.vertices(grade(a, "p1").base), [[0, 0], [110, 0], [115, 55], [0, 60]]);
    a.switchSize("L");
    nearPts(verts(a, "p1"), [[0, 0], [110, 0], [115, 55], [0, 60]]);
    sizes(a, { op: "base", name: "M" });
    assert.deepEqual(grade(a, "p1").rules, rulesM);
    nearPts(G.vertices(grade(a, "p1").base), [[0, 0], [100, 0], [100, 50], [0, 60]]);
    // rename and remove
    sizes(a, { op: "rename", from: "XL", to: "XXL" });
    assert.deepEqual(table(a).sizes, ["S", "M", "L", "XXL"]);
    assert.deepEqual(grade(a, "p1").rules[1].XXL, [20, 0]);
    sizes(a, { op: "remove", name: "L" });
    assert.deepEqual(table(a), { sizes: ["S", "M", "XXL"], base: "M", current: "M" }, "the current size removed: back to the base");
    nearPts(verts(a, "p1"), [[0, 0], [100, 0], [100, 50], [0, 60]]);
    assert.equal(grade(a, "p1").rules[2].L, undefined);
    a.undo(); a.undo();
    assert.deepEqual(table(a), { sizes: ["S", "M", "L", "XL"], base: "M", current: "L" });
    nearPts(verts(a, "p1"), [[0, 0], [110, 0], [115, 55], [0, 60]]);
    a.switchSize("M");
}

// ---- a linked pair grades with its half: the partner is the mirror in every size ----
const axis = [-50, 0, -50, 100];
const isMirror = (from, to) => assert.equal(flat(outline(a, to)), flat(a.withPath(outline(a, from), (p) => a.pathOf(a.f("profile_mirror")(p, axis[0], axis[1], axis[2] - axis[0], axis[3] - axis[1])))));
a.apply(m.addPattern(a.nodes(), { label: "D", path: m.rectPath(0, 400, 100, 50), fabric: "f_x" }).ops, "d");
{
    const r = m.linkedCopyOps(a.nodes(), "p4", a.mirroredPiece("p4", axis), axis);
    a.commit(r.ops, "sym");
    const D = flat(outline(a, "p4")), D2 = flat(outline(a, r.id));
    gradeOp(a, { op: "rule", id: "p4", vertex: 1, size: "L", d: [10, 0] });
    a.switchSize("L");
    isMirror("p4", r.id);
    near(verts(a, "p4")[1][0], 110);
    // a drag of the partner in L rebuilds the half, both get the rule
    drag(a, r.id, [0], [0, -5]);
    isMirror(r.id, "p4");
    assert.ok(grade(a, "p4").rules && grade(a, r.id).rules);
    a.switchSize("M");
    assert.equal(flat(outline(a, "p4")), D); assert.equal(flat(outline(a, r.id)), D2);
    a.switchSize("L");
    isMirror("p4", r.id);
    a.switchSize("M");
}

// ---- an unfolded piece grades with its half: the whole stays symmetric ----
a.apply(m.addPattern(a.nodes(), { label: "E", path: m.rectPath(0, 600, 50, 80), fabric: "f_x" }).ops, "e");
{
    const r = a.unfoldOps("p6", 3);                   // the left side (0,680)->(0,600) the fold
    a.commit(r.ops, "unfold", "p6");
    const W = flat(outline(a, "p6")), vs = verts(a, "p6");
    const k = vs.findIndex((p) => Math.abs(p[0] - 50) < 1e-9 && Math.abs(p[1] - 600) < 1e-9);
    assert.ok(k >= 0);
    gradeOp(a, { op: "rule", id: "p6", vertex: k, size: "L", d: [10, 0] });
    a.switchSize("L");
    const ws = verts(a, "p6");
    assert.ok(ws.some((p) => Math.abs(p[0] - 60) < 1e-6 && Math.abs(p[1] - 600) < 1e-6), JSON.stringify(ws));
    assert.ok(ws.some((p) => Math.abs(p[0] + 60) < 1e-6 && Math.abs(p[1] - 600) < 1e-6), "the mirrored point moved with it");
    assert.deepEqual(a.problems(), []);
    a.switchSize("M");
    assert.equal(flat(outline(a, "p6")), W);
}

// ---- an M:N group re-distributes per size ----
{
    a.apply(m.addPattern(a.nodes(), { label: "F", path: m.rectPath(0, 800, 100, 50), fabric: "f_x" }).ops, "f");
    a.apply(m.addPattern(a.nodes(), { label: "H", path: m.rectPath(200, 800, 300, 50), fabric: "f_x" }).ops, "h");
    const sidesOf = (id) => a.drawing(id).sides;
    // F's bottom and right onto H's bottom
    const g = sewGroupOps(a.nodes(), sidesOf, [{ id: "p7", anchor: [0, 0, 1], dir: 1 }, { id: "p7", anchor: [1, 0, 1], dir: 1 }], [{ id: "p8", anchor: [0, 0, 1], dir: 1 }]);
    a.apply(g.ops, "sew M:N");
    const split = () => { const ids = membersOf(a.nodes(), g.ids[0]).map((n) => n.id ?? n); return ids.map((id) => seam(a, id)).map((s) => s.b_to - s.b_from); };
    near(split()[0], 200); near(split()[1], 100);
    gradeOp(a, { op: "rule", id: "p7", vertex: 1, size: "L", d: [50, 0] });
    gradeOp(a, { op: "rule", id: "p7", vertex: 2, size: "L", d: [50, 0] });
    a.switchSize("L");
    // F's bottom 150 and right 50 of 200: H's 300 split 225 / 75
    near(split()[0], 225); near(split()[1], 75);
    a.switchSize("M");
    near(split()[0], 200); near(split()[1], 100);
}

// ---- a piece turned and moved whole in L is placed in every size: its rules turn with it ----
{
    a.switchSize("L");
    const T = [0, -1, 1000, 1, 0, 0], at = (p) => G.applyAffine(T, p);      // a quarter turn, then 1000 along x
    const base = G.vertices(grade(a, "p1").base), rules = grade(a, "p1").rules, L = verts(a, "p1");
    const line = [node(a, "p1").internal[0].path.start, node(a, "p1").internal[0].path.segments[0].to];
    a.commit(m.pieceOps(a.nodes(), "p1", a.transformedPiece("p1", T)), "move", "p1");
    nearPts(verts(a, "p1"), L.map(at));
    nearPts([node(a, "p1").internal[0].path.start, node(a, "p1").internal[0].path.segments[0].to], line.map(at));          // the internal line moved once
    nearPts(G.vertices(grade(a, "p1").base), base.map(at));
    nearPts([grade(a, "p1").rules[2].L, grade(a, "p1").rules[1].XL], [[-rules[2].L[1], rules[2].L[0]], [-rules[1].XL[1], rules[1].XL[0]]]);
    a.switchSize("M");
    nearPts(verts(a, "p1"), base.map(at));
    a.undo(); a.undo();
    nearPts(verts(a, "p1"), L);
    a.switchSize("M");
}

// ---- in L a handle moved on its own is refused; its vertex dragged (handles with it) is a rule ----
{
    a.apply(m.addPattern(a.nodes(), { label: "K", path: m.rectPath(0, 1000, 100, 50), fabric: "f_x" }).ops, "k");
    a.commit(a.pointOps({ id: "p9", op: "smooth", points: [{ index: 1, smooth: true }] }), "point", "p9");
    a.switchSize("L");
    const p = JSON.parse(JSON.stringify(outline(a, "p9")));
    p.segments[0].c2 = [p.segments[0].c2[0] + 3, p.segments[0].c2[1]];
    const head = a.head();
    assert.throws(() => a.commit(m.setOutline(a.nodes(), "p9", p), "edit", "p9"), /edit the shape in the base size \(M\)/);
    assert.equal(a.head(), head);
    drag(a, "p9", [1], [4, 0]);
    assert.deepEqual(grade(a, "p9").rules, { 1: { L: [4, 0] } });
    a.switchSize("M");
    assert.equal(outline(a, "p9").segments[0].c2[0] + 0, grade(a, "p9").base.segments[0].c2[0]);
}

// ---- save, then open: the table and the grades round-trip ----
{
    a.switchSize("L");
    const text = a.save();
    const b = new Atelier(k);
    b.load(text);
    assert.deepEqual(b.grading(), table(a));
    for (const id of ["p1", "p3", "p4", "p6"]) assert.deepEqual(G.gradeOf(node(b, id)), grade(a, id));
    assert.equal(flat(outline(b, "p1")), flat(outline(a, "p1")));
    b.switchSize("M");
    assert.equal(flat(outline(b, "p1")), flat(outline(a, "p1") && grade(a, "p1").base));
    assert.deepEqual(b.problems(), []);
    b.free();
}
a.free();
console.log("grading-kernel: ok");
