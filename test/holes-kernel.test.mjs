// Spec §5, "checks before building", pinned against the kernel (2026-11-20):
//   (a) garment_cut_line offsets only the outer outline: a hole gets no cut line from it, so the
//       app draws a hole's cut line from profile_offset (plan ruling 10). If (a) fails, the kernel
//       now offsets holes: stop, report, and drop the app's own hole cut lines.
//   (b) side indexing ignores holes: a holed piece has the sides of the same piece without one.
//   (c) the AAMA writer writes holes; (d) the AAMA reader keeps them (A2 spec §6, was dropped).
import assert from "node:assert/strict";
import { loadKernel } from "./package.mjs";
import { Atelier } from "../kernel.js";
import * as m from "../model.js";

const k = await loadKernel();
const params = Object.fromEntries(m.FABRIC_FIELDS.map((n) => [n, 1]));
const fresh = () => { const a = new Atelier(k); a.reset(m.newDocumentOps({ slug: "x", label: "X", params })); return a; };
const outer = m.rectPath(0, 0, 200, 100);
const hole = m.rectPath(80, 30, 40, 40);
const holed = { ...outer, holes: [{ start: hole.start, segments: hole.segments }] };

const a = fresh();
a.apply(m.addPattern(a.nodes(), { label: "Holed", path: holed, fabric: "f_x", allowance: 10 }).ops, "holed");
a.apply(m.addPattern(a.nodes(), { label: "Plain", path: outer, fabric: "f_x", allowance: 10 }).ops, "plain");
assert.deepEqual(a.problems(), [], "a pattern with a hole evaluates and draws");
const [dh, dp] = [a.drawing("p1"), a.drawing("p2")];

// (a)
assert.deepEqual(dh.cut, dp.cut, "(a) the holed piece's cut line is the plain piece's: garment_cut_line does not offset holes");
for (let i = 0; i + 1 < dh.cut.length; i += 2) {
    const [x, y] = [dh.cut[i], dh.cut[i + 1]];
    assert.ok(x <= 1e-9 || x >= 200 - 1e-9 || y <= 1e-9 || y >= 100 - 1e-9, `(a) cut point ${x},${y} lies on or outside the sew outline`);
}
// (b)
assert.deepEqual(dh.sides, dp.sides, "(b) the hole adds no side");
assert.equal(dh.sides.length, 5);

// (c) and (d): the holed piece alone, written and read back
const solo = fresh();
solo.apply(m.addPattern(solo.nodes(), { label: "Holed", path: holed, fabric: "f_x", allowance: 10 }).ops, "holed");
const plain = fresh();
plain.apply(m.addPattern(plain.nodes(), { label: "Holed", path: outer, fabric: "f_x", allowance: 10 }).ops, "plain");
const [dxfHoled, dxfPlain] = [solo.toDxf(), plain.toDxf()];
// the hole's corners (80,30)-(120,70) appear as numbers in the holed file and nowhere in the plain one
// (if the writer scales units, scale these four values the same way). DXF is group-code/value
// line pairs, and 30 (a Z) and 70 (flags) are group codes too: only the values count.
const numbers = (text) => text.split(/\r?\n/).filter((_, i) => i % 2 === 1).map(Number).filter(Number.isFinite);
const has = (text, v) => numbers(text).some((x) => Math.abs(x - v) < 1e-3);
for (const v of [80, 120, 30, 70]) {
    assert.ok(has(dxfHoled, v), `(c) the AAMA writer writes the hole: ${v} is in the file`);
    assert.ok(!has(dxfPlain, v), `(c) ${v} is the hole's alone`);
}
const back = solo.fromDxf(dxfHoled, "f_x").find((o) => o.node?.kind === "profile.path").node.path;
assert.equal((back.holes ?? []).length, 1, "(d) the AAMA reader keeps the hole (A2 spec §6)");
assert.deepEqual(m.pathPoints(back), m.pathPoints(outer), "(d) the imported outline is the written one");
const sortedPts = (p) => m.pathPoints(p).map(([x, y]) => [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6]).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
assert.deepEqual(sortedPts(back.holes[0]), sortedPts(hole), "(d) the imported hole is the written one");

// (e) Move and Mirror keep a piece's holes: the hole goes with the outline (kernel.js pathOf)
const ring = (p) => m.pathPoints(p).map(([x, y]) => [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6]);
const moved = solo.transformed("p1", [1, 0, 10, 0, 1, 5]);
assert.equal((moved.holes ?? []).length, 1, "(e) a moved piece keeps its hole");
assert.deepEqual(ring(moved.holes[0]), ring(hole).map(([x, y]) => [x + 10, y + 5]), "(e) the hole moved with the piece");
const mirrored = solo.mirrored("p1", [0, 0, 0, 1]);          // across the y axis: x -> -x
assert.equal((mirrored.holes ?? []).length, 1, "(e) a mirrored piece keeps its hole");
const sorted = (pts) => [...pts].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
assert.deepEqual(sorted(ring(mirrored.holes[0])), sorted(ring(hole).map(([x, y]) => [x === 0 ? 0 : -x, y])), "(e) the hole mirrored with the piece");
console.log("holes-kernel: ok -- (a) no hole cut line from the kernel, (b) sides ignore holes, (c) AAMA writes holes, (d) reads them back, (e) Move and Mirror keep holes");
