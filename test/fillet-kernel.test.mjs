// Fillet (spec §4) against the kernel: the corner becomes an arc (profile_fillet_corner); seams
// on the sides keep their anchors and are re-anchored inside the same batch; one undo; a radius
// that does not fit is refused and changes nothing.
import assert from "node:assert/strict";
import { loadKernel } from "./package.mjs";
import { Atelier } from "../kernel.js";
import * as m from "../model.js";

const k = await loadKernel();
const params = Object.fromEntries(m.FABRIC_FIELDS.map((n) => [n, 1]));
const near = (a, b, e = 1e-4) => assert.ok(Math.abs(a - b) < e, `${a} vs ${b}`);
const a = new Atelier(k);
a.reset(m.newDocumentOps({ slug: "x", label: "X", params }));
a.apply(m.addPattern(a.nodes(), { label: "A", path: m.rectPath(0, 0, 100, 50), fabric: "f_x" }).ops, "a");
a.apply(m.addPattern(a.nodes(), { label: "B", path: m.rectPath(200, 0, 100, 50), fabric: "f_x" }).ops, "b");
a.apply(m.addSeam(a.nodes(), { a: "p1", b: "p2", a_from: 100, a_to: 150, b_from: 250, b_to: 300, reversed: true, anchor: { a: [1, 0, 1], b: [3, 0, 1] } }).ops, "sew");

a.commit(a.filletOps("p1", 1, 10), "fillet", "p1");
const path = m.byId(a.nodes()).get("p1_outline").path;
assert.deepEqual(path.segments.map((s) => s.type), ["line", "arc", "line", "line", "line"]);
const s1 = m.byId(a.nodes()).get("s1");
assert.deepEqual(s1.meta.atelier.a, [2, 0, 1], "the seam's side moved past the arc");
near(s1.a_from, 90 + 5 * Math.PI); near(s1.a_to, 90 + 5 * Math.PI + 40);
assert.deepEqual(a.problems(), []);
// the picker's sides are the path's segments, the arc one of them: side i starts at path point i
// (the edit tool's lock reads hit.side as a segment index)
{
    const sides = a.sidesOf("p1"), pts = m.pathPoints(path);
    assert.equal(sides.length, pts.length + 1);
    a.withOutline("p1", (p) => pts.forEach((pt, i) => {
        const r = a.f("profile_point_at_length")(p, sides[i], 1e-6);
        near(r[0], pt[0], 1e-3); near(r[1], pt[1], 1e-3);
    }));
}
a.commit(a.filletOps("p2", 0, 5), "fillet", "p2");
assert.equal(m.byId(a.nodes()).get("p2_outline").path.segments.at(-1).type, "arc", "corner 0: the arc closes the loop");
assert.deepEqual(m.byId(a.nodes()).get("s1").meta.atelier.b, [3, 0, 1]);
assert.equal(a.undo(), true);
assert.equal(a.undo(), true);
assert.equal(m.byId(a.nodes()).get("p1_outline").path.segments.length, 4, "each fillet is one undo");
const before = a.save();
assert.throws(() => a.commit(a.filletOps("p1", 1, 80), "fillet", "p1"));
assert.equal(a.save(), before, "a radius that does not fit changes nothing");

// a piece with a hole, a per-side allowance and a notch: the hole stays, the arc takes its
// neighbour's width, the notch keeps its point
{
    const b = new Atelier(k);
    b.reset(m.newDocumentOps({ slug: "x", label: "X", params }));
    const add = m.addPattern(b.nodes(), { label: "H", path: { ...m.rectPath(0, 0, 100, 50), holes: [m.rectPath(40, 20, 10, 10)] }, fabric: "f_x", allowance: [1, 2, 3, 4] });
    add.ops.find((o) => o.node?.kind === "garment.pattern").node.notches = [{ at: 120, kind: "slit", depth: 6 }];
    b.apply(add.ops, "h");
    b.commit(b.filletOps("p1", 2, 10), "fillet", "p1");
    const n = m.byId(b.nodes());
    assert.deepEqual(n.get("p1_outline").path.holes, [m.rectPath(40, 20, 10, 10)], "the hole is kept");
    assert.deepEqual(n.get("p1").allowance, [1, 2, 2, 3, 4], "the arc takes the side before it's width");
    near(n.get("p1").notches[0].at, 100 + 20, 1e-3);        // (100, 20) on side 1, untouched by the corner at (100, 50)
    assert.deepEqual(b.problems(), []);
    // the free-form side is refused, as is a side the kernel would split
    const bez = { start: [0, 0], segments: [{ type: "line", to: [100, 0] }, { type: "nurbs", degree: 2, points: [[120, 25], [100, 50]], weights: [1, 1, 1], knots: [0, 0, 0, 1, 1, 1] },
        { type: "line", to: [0, 50] }, { type: "line", to: [0, 0] }] };
    b.apply(m.addPattern(b.nodes(), { label: "N", path: bez, fabric: "f_x" }).ops, "n");
    assert.deepEqual(b.problems(), []);
    assert.throws(() => b.filletOps("p2", 1, 5), /free-form/);
    assert.throws(() => b.filletOps("p2", 2, 5), /free-form/);
    assert.doesNotThrow(() => b.filletOps("p2", 3, 5));
    b.free();
}
a.free();
console.log("fillet-kernel: ok");
