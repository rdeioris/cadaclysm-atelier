// A seam saved without the app's anchor (an older or imported document) is anchored when the
// document is opened, as part of the base (no undo step): a fillet on its piece then moves its
// range with its side, as for a seam sewn in the app.
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
// no anchor: A's right side (100..150) to B's left side (250..300)
a.apply(m.addSeam(a.nodes(), { a: "p1", b: "p2", a_from: 100, a_to: 150, b_from: 250, b_to: 300, reversed: true }).ops, "sew");
const text = a.save();
a.free();
assert.equal(JSON.parse(text).nodes.find((n) => n.id === "s1").meta?.atelier, undefined, "saved without an anchor");

const b = new Atelier(k);
b.load(text);
{   // side, fraction from, fraction to (a side start found by bisection: compare to 1e-6)
    const got = m.byId(b.nodes()).get("s1").meta?.atelier;
    assert.ok(got?.a && got?.b, "anchored on open");
    for (const [end, want] of [["a", [1, 0, 1]], ["b", [3, 0, 1]]]) { assert.equal(got[end].length, 3); want.forEach((v, i) => near(got[end][i], v, 1e-6)); }
}
assert.equal(b.undo(), false, "the anchors are the base: no undo step");
assert.deepEqual(b.problems(), []);
b.commit(b.filletOps("p1", 1, 10), "fillet", "p1");
const s1 = m.byId(b.nodes()).get("s1");
near(s1.a_from, 90 + 5 * Math.PI); near(s1.a_to, 90 + 5 * Math.PI + 40);
b.free();
console.log("anchor-load-kernel: ok");
