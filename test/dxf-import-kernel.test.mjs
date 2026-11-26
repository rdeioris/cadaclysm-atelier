// A2 spec §6 / plan B6: DXF import keeps internal lines and holes. A garment with an internal
// line, a fold and a hole goes out through the app's toDxf and back in through fromDxf; the
// imported piece has the same outline, hole and internal lines (kind and points).
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
const line = m.openPath([[20, 20], [60, 20], [60, 80]]);
const fold = m.openPath([[150, 10], [150, 90]]);

const a = fresh();
a.apply(m.addPattern(a.nodes(), { label: "Front", path: holed, fabric: "f_x", allowance: 10 }).ops, "front");
a.apply(m.addInternal(a.nodes(), "p1", line, "line"), "line");
a.apply(m.addInternal(a.nodes(), "p1", fold, "fold"), "fold");
assert.deepEqual(a.problems(), [], "the piece evaluates");

// imported into a fresh document, so the piece is p1 there too
const b = fresh();
const ops = b.fromDxf(a.toDxf(), "f_x");
const pattern = ops.find((o) => o.node?.kind === "garment.pattern").node;
const back = ops.find((o) => o.node?.kind === "profile.path").node.path;

const ring = (p) => m.pathPoints(p).map(([x, y]) => [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6]);
const sorted = (pts) => [...pts].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
assert.deepEqual(sorted(ring(back)), sorted(ring(outer)), "the outline comes back");
assert.equal((back.holes ?? []).length, 1, "the hole comes back");
assert.deepEqual(sorted(ring(back.holes[0])), sorted(ring(hole)), "the hole is the written one");

const internal = pattern.internal ?? [];
assert.equal(internal.length, 2, `two internal lines come back, got ${JSON.stringify(internal.map((l) => l.kind))}`);
// an open line may come back either way round: compare as a point set, in either direction
const same = (got, want) => {
    const g = ring(got), w = ring(want);
    return JSON.stringify(g) === JSON.stringify(w) || JSON.stringify(g) === JSON.stringify([...w].reverse());
};
for (const [want, kind] of [[line, "line"], [fold, "fold"]]) {
    const got = internal.find((l) => same(l.path, want));
    assert.ok(got, `the ${kind} comes back: ${JSON.stringify(internal)}`);
    assert.equal(got.kind, kind, `the ${kind} keeps its kind`);
    assert.deepEqual(Object.keys(got.path).sort(), ["segments", "start"], "an internal entry is a plain open path");
}

// the imported ops apply and evaluate: the piece draws with its hole and lines
b.apply(ops, "import");
assert.deepEqual(b.problems(), [], "the imported piece evaluates");
const d = b.drawing("p1");
assert.equal(d.holes.length, 1, "the imported piece draws its hole");
assert.equal(d.internal.length, 2, "the imported piece draws its internal lines");
console.log("dxf-import: ok -- outline, hole, internal line and fold survive toDxf -> fromDxf");
