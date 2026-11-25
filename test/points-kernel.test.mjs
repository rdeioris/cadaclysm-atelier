// Point editing (A1 task A4, spec §3) against the kernel: insert, remove and corner/curve on an
// outline and on an internal line, each one batch (one undo); seams keep their sides through an
// insert and its removal, per-side allowances follow the sides, notches keep their place, and a
// refusal changes nothing.
import assert from "node:assert/strict";
import { loadKernel } from "./package.mjs";
import { Atelier } from "../kernel.js";
import * as m from "../model.js";
import { makeTool, pointMenuOp } from "../tools.js";
import { isCurvePoint } from "../view2d.js";

const k = await loadKernel();
const params = Object.fromEntries(m.FABRIC_FIELDS.map((n) => [n, 1]));
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} vs ${b}`);
const outline = (a, id = "p1") => m.byId(a.nodes()).get(`${id}_outline`).path;
const piece = (a, id = "p1") => m.byId(a.nodes()).get(id);
const seam = (a) => m.byId(a.nodes()).get("s1");
const samePath = (p, q) => {
    assert.equal(p.segments.length, q.segments.length);
    p.start.forEach((v, i) => near(v, q.start[i], 1e-9));
    p.segments.forEach((s, j) => { assert.equal(s.type, q.segments[j].type); s.to.forEach((v, i) => near(v, q.segments[j].to[i], 1e-9)); });
};

const a = new Atelier(k);
a.reset(m.newDocumentOps({ slug: "x", label: "X", params }));
const add = m.addPattern(a.nodes(), { label: "A", path: m.rectPath(0, 0, 100, 50), fabric: "f_x", allowance: [1, 2, 3, 4] });
add.ops.find((o) => o.node?.kind === "garment.pattern").node.notches = [{ at: 40, kind: "slit", depth: 6 }, { at: 120, kind: "v", depth: 6 }];
a.apply(add.ops, "a");
a.apply(m.addPattern(a.nodes(), { label: "B", path: m.rectPath(200, 0, 100, 50), fabric: "f_x" }).ops, "b");
// a seam on A's right side (100..150), and one starting a third along it
a.apply(m.addSeam(a.nodes(), { a: "p1", b: "p2", a_from: 100, a_to: 150, b_from: 350, b_to: 400, reversed: true, anchor: { a: [1, 0, 1], b: [3, 0, 1] } }).ops, "sew");
const rect = outline(a);

// insert on the bottom side at 30: five sides, the seam's side moved up one, its arc lengths kept,
// the split side's allowance on both halves, the notches where they were
a.commit(a.pointOps({ id: "p1", op: "insert", s: 30 }), "point", "p1");
{
    const p = outline(a);
    assert.equal(p.segments.length, 5);
    assert.deepEqual(p.segments[0].to, [30, 0]);
    assert.deepEqual(seam(a).meta.atelier.a, [2, 0, 1], "the seam's side moved past the new point");
    near(seam(a).a_from, 100); near(seam(a).a_to, 150);
    assert.deepEqual(piece(a).allowance, [1, 1, 2, 3, 4]);
    assert.deepEqual(piece(a).notches.map((n) => n.at), [40, 120]);
    assert.deepEqual(a.problems(), []);
}
// insert on the seam's own side, mid way: the seam spans both halves, the same 100..150
a.commit(a.pointOps({ id: "p1", op: "insert", s: 125 }), "point", "p1");
{
    assert.equal(outline(a).segments.length, 6);
    assert.deepEqual(seam(a).meta.atelier.a, [2, 0, 1, 3]);
    near(seam(a).a_from, 100); near(seam(a).a_to, 150);
}
// remove both new points in one batch (highest first): the rectangle back, the seam on its side
a.commit(a.pointOps({ id: "p1", op: "remove", indices: [1, 3] }), "point", "p1");
{
    samePath(outline(a), rect);
    near(seam(a).a_from, 100); near(seam(a).a_to, 150);
    assert.equal(seam(a).meta.atelier.a[0], 1, "the seam is back on side 1");
    assert.deepEqual(piece(a).allowance, [1, 2, 3, 4]);
    assert.deepEqual(piece(a).notches.map((n) => Math.round(n.at * 1e6) / 1e6), [40, 120]);
    assert.deepEqual(a.problems(), []);
}
// each was one undo step
assert.equal(a.undo(), true);
assert.equal(outline(a).segments.length, 6);
assert.equal(a.undo(), true);
assert.equal(a.undo(), true);
samePath(outline(a), rect);
a.redo(); a.redo(); a.redo();
samePath(outline(a), rect);

// corner 1 made a curve point: its two sides become cubics with handles on one line through it;
// made a corner again it gives the rectangle back. The seam keeps side 1.
a.commit(a.pointOps({ id: "p1", op: "smooth", points: [{ index: 1, smooth: true }] }), "point", "p1");
{
    const p = outline(a);
    assert.deepEqual(p.segments.map((s) => s.type), ["bezier", "bezier", "line", "line"]);
    const [u, v] = [p.segments[0].c2, p.segments[1].c1], c = [100, 0];
    near((u[0] - c[0]) * (v[1] - c[1]) - (u[1] - c[1]) * (v[0] - c[0]), 0, 1e-6);
    assert.deepEqual(seam(a).meta.atelier.a, [1, 0, 1]);
    assert.equal(seam(a).a_from, a.sidesOf("p1")[1]);
    assert.deepEqual(a.problems(), []);
}
a.commit(a.pointOps({ id: "p1", op: "smooth", points: [{ index: 1, smooth: false }] }), "point", "p1");
samePath(outline(a), rect);
near(seam(a).a_from, 100); near(seam(a).a_to, 150);

// refusals change nothing and name the point: a triangle keeps three sides; an insert on a corner
{
    const before = a.save();
    assert.throws(() => a.commit(a.pointOps({ id: "p1", op: "remove", indices: [0, 1] }), "point", "p1"), /point 1: .*3/);
    assert.throws(() => a.commit(a.pointOps({ id: "p1", op: "insert", s: 100.004 }), "point", "p1"), /insert point/);
    assert.equal(a.save(), before, "nothing changed");
}
// point 0 removed: old point 1 starts the loop, the merged side last; the seam (old side 1) is side 0
a.commit(a.pointOps({ id: "p1", op: "insert", s: 280 }), "point", "p1");
assert.equal(outline(a).segments.length, 5);
a.commit(a.pointOps({ id: "p1", op: "remove", indices: [0] }), "point", "p1");
{
    const p = outline(a);
    assert.deepEqual(p.start, [100, 0]);
    assert.equal(p.segments.length, 4);
    assert.equal(seam(a).meta.atelier.a[0], 0);
    near(seam(a).a_from, 0); near(seam(a).a_to, 50);
    assert.deepEqual(a.problems(), []);
}

// an internal line: insert at a point, make it a curve point, back to a corner, remove it
{
    const line = m.openPath([[10, 10], [60, 10], [60, 40]]);
    a.apply(m.addInternal(a.nodes(), "p1", line), "line");
    const li = piece(a).internal.length - 1;
    a.commit(a.pointOps({ id: "p1", line: li, op: "insert", at: [30, 12] }), "point");
    let p = piece(a).internal[li].path;
    assert.equal(p.segments.length, 3);
    near(p.segments[0].to[0], 30, 0.05); near(p.segments[0].to[1], 10, 1e-9);
    a.commit(a.pointOps({ id: "p1", line: li, op: "smooth", points: [{ index: 2, smooth: true }] }), "point");
    assert.deepEqual(piece(a).internal[li].path.segments.map((s) => s.type), ["line", "bezier", "bezier"]);
    a.commit(a.pointOps({ id: "p1", line: li, op: "smooth", points: [{ index: 2, smooth: false }] }), "point");
    a.commit(a.pointOps({ id: "p1", line: li, op: "remove", indices: [1] }), "point");
    p = piece(a).internal[li].path;
    samePath(p, line);
    const before = a.save();
    assert.throws(() => a.commit(a.pointOps({ id: "p1", line: li, op: "remove", indices: [0] }), "point"), /point 1/);
    assert.equal(a.save(), before);
}
// a closed internal shape: a point inserted on it stays closed
{
    a.apply(m.addInternal(a.nodes(), "p1", m.rectPath(70, 20, 10, 10)), "square");
    const li = piece(a).internal.length - 1;
    a.commit(a.pointOps({ id: "p1", line: li, op: "insert", at: [75, 19] }), "point");
    const p = piece(a).internal[li].path;
    assert.equal(p.segments.length, 5);
    assert.ok(m.isClosedPath(p), "still closed");
}
a.free();

// the Edit tool's gestures as the kernel's batches: a double click on an edge inserts, the C key
// toggles the selected points, the menu's choice, Delete removes them
{
    const b = new Atelier(k);
    b.reset(m.newDocumentOps({ slug: "x", label: "X", params }));
    b.apply(m.addPattern(b.nodes(), { label: "A", path: m.rectPath(0, 0, 100, 50), fabric: "f_x" }).ops, "a");
    const sel = { kind: "pattern", id: "p1" };
    const tool = (extra = {}) => makeTool("edit", { nodes: b.nodes(), drawings: new Map(b.drawings().map((d) => [d.id, d])), selection: sel, request: async () => ({}), ...extra });
    const send = (r) => { assert.ok(r.point, JSON.stringify(r)); b.commit(b.pointOps(r.point), "point", r.point.line == null ? r.point.id : null); };
    let t = tool();
    const edge = { kind: "edge", id: "p1", s: 60, side: 0 };
    t.down([60, 0], edge, {}); assert.deepEqual(t.up([60, 0], edge, { detail: 1 }), {});
    t.down([60, 0], edge, {});
    send(t.up([60, 0], edge, { dblclick: true, detail: 2 }));
    assert.deepEqual(outline(b).segments[0].to, [60, 0]);
    // a click on point 1 (the new one) selects it; C makes it a curve point; C again a corner
    t = tool();
    t.down([60, 0], { kind: "point", id: "p1", index: 1 }, {});
    const picked = t.up([60, 0], { kind: "point", id: "p1", index: 1 }, {});
    assert.deepEqual(picked.pointSel, [1]);
    send(tool({ pointSel: picked.pointSel }).key("c"));
    assert.ok(isCurvePoint(outline(b), 1));
    send(tool({ pointSel: [1] }).key("C"));
    assert.ok(!isCurvePoint(outline(b), 1));
    // the menu's "Make curve point" on point 2 and "Make corner" back; Delete on points 1 to 3 of
    // the five: the third removal would leave two sides, so the batch is refused whole
    send({ point: pointMenuOp({ kind: "point", id: "p1", index: 2 }, true) });
    assert.ok(isCurvePoint(outline(b), 2));
    send({ point: pointMenuOp({ kind: "point", id: "p1", index: 2 }, false) });
    const before = b.save();
    const del = tool({ pointSel: [1, 2, 3] }).key("Delete");
    assert.deepEqual(del.point, { id: "p1", op: "remove", indices: [1, 2, 3] });
    assert.throws(() => send(del), /^Error: point 2: /);
    assert.equal(b.save(), before, "the refused batch changed nothing");
    send(tool({ pointSel: [1] }).key("Backspace"));
    samePath(outline(b), m.rectPath(0, 0, 100, 50));
    assert.deepEqual(tool().key("Delete"), {}, "nothing selected: no point op");
    b.free();
}
console.log("points-kernel: ok");
