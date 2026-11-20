// What the 2D scene draws, from the kernel: the outline as exact Béziers, each hole's Béziers,
// ring and cut line, internal lines (closed or open), the fill triangulated with its holes.
import assert from "node:assert/strict";
import { loadKernel } from "./package.mjs";
import { Atelier, forPage } from "../kernel.js";
import * as m from "../model.js";

const k = await loadKernel();
const params = Object.fromEntries(m.FABRIC_FIELDS.map((n) => [n, 1]));
const a = new Atelier(k);
a.reset(m.newDocumentOps({ slug: "x", label: "X", params }));
const outer = m.rectPath(0, 0, 200, 100), hole = m.rectPath(80, 30, 40, 40);
const add = m.addPattern(a.nodes(), { label: "Holed", path: { ...outer, holes: [{ start: hole.start, segments: hole.segments }] }, fabric: "f_x", allowance: 10 });
add.ops.find((o) => o.node?.kind === "garment.pattern").node.internal = [
    { kind: "line", path: m.rectPath(20, 20, 30, 30) },
    { kind: "fold", path: { start: [150, 10], segments: [{ type: "line", to: [150, 90] }] } }];
a.apply(add.ops, "holed");
const d = a.drawing("p1");

assert.equal(d.beziers.length, 4 * 16, "four straight sides, one rational cubic each");
assert.deepEqual([d.beziers[0], d.beziers[1], d.beziers[2], d.beziers[3]], [0, 0, 0, 1], "starts at the outline's start, z 0, weight 1");
assert.equal(d.holes.length, 1);
assert.equal(d.holes[0].beziers.length, 64);
assert.equal(d.holes[0].cut.length, 1, "the hole's cut line: one ring");
for (let i = 0; i + 1 < d.holes[0].cut[0].length; i += 2) {
    const [x, y] = [d.holes[0].cut[0][i], d.holes[0].cut[0][i + 1]];
    assert.ok(x > 89.99 && x < 110.01 && y > 39.99 && y < 60.01, `hole cut point ${x},${y}: the hole shrunk by the 10 mm allowance`);
}
assert.deepEqual(d.internal.map((l) => [l.kind, l.closed, l.beziers.length]), [["line", true, 64], ["fold", false, 16]]);
assert.ok(d.fill.indices.length >= 3 * 8, "a rectangle with a square hole needs 8 triangles or more");
for (let i = 2; i < d.fill.positions.length; i += 3) assert.equal(d.fill.positions[i], 0, "the fill is built at z = 0 (scene2d lifts it to its band)");
for (let t = 0; t < d.fill.indices.length; t += 3) {
    const c = [0, 1].map((ax) => (d.fill.positions[3 * d.fill.indices[t] + ax] + d.fill.positions[3 * d.fill.indices[t + 1] + ax] + d.fill.positions[3 * d.fill.indices[t + 2] + ax]) / 3);
    assert.ok(!(c[0] > 80 && c[0] < 120 && c[1] > 30 && c[1] < 70), `triangle ${t / 3} lies in the hole`);
}
const page = forPage(d);
assert.equal(page.beziers, undefined); assert.equal(page.fill, undefined); assert.equal(page.holes[0].beziers, undefined);
assert.deepEqual(page.sides, d.sides);
const sig = d.sig;
a.apply(m.setPattern(a.nodes(), "p1", { grain: [1, 0] }), "grain");
assert.notEqual(a.drawing("p1").sig, sig, "the signature follows the piece");
a.free();
console.log("drawing-kernel: ok");
