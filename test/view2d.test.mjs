// The 2D window's mapping from its frame report, the nearest arc length, the edit handles and
// the pick decoding: M4a's camera-mapping checks carried over to the View's ortho camera.
import assert from "node:assert/strict";
import { pxToWorld, worldToPx, mmPerPx, isOrtho, arcAt, pointsOf, hitOf, unionBounds, notchNormals } from "../view2d.js";

// A top view centred on (cx, cy), half-height H, of a w x h viewport: what frameReport() gives.
function topView(cx, cy, H, w, h) {
    const a = w / h;
    return {
        rect: [500, 0, w, h], kind: "ortho", eye: [cx, cy, 100],
        view: Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -cx, -cy, -100, 1),
        projection: Float32Array.of(1 / (H * a), 0, 0, 0, 0, 1 / H, 0, 0, 0, 0, -0.001, 0, 0, 0, 0.5, 1),
    };
}
const near = (p, q, e = 1e-4) => assert.ok(Math.hypot(p[0] - q[0], p[1] - q[1]) < e, `${p} vs ${q}`);
const r = topView(50, 25, 100, 800, 600);
assert.ok(isOrtho(r));
near(pxToWorld(r, [400, 300]), [50, 25]);
near(pxToWorld(r, [400, 0]), [50, 125], 1e-3);
assert.ok(pxToWorld(r, [400, 100])[1] > pxToWorld(r, [400, 200])[1], "y up in the world is up on screen");
near(worldToPx(r, [10, 70]), [400 + (-40 / (100 * 800 / 600)) * 400, 300 - (45 / 100) * 300], 1e-3);
near(pxToWorld(r, worldToPx(r, [12.5, -3])), [12.5, -3], 1e-3);
assert.ok(Math.abs(mmPerPx(r) - 200 / 600) < 1e-6, "2H mm across h pixels (float32 projection)");
const zoomed = topView(50, 25, 50, 800, 600);
near(pxToWorld(zoomed, [400, 300]), pxToWorld(r, [400, 300]), 1e-6); // a zoom about the centre keeps it

// arc length along a 100 x 50 rectangle's 1 mm samples
const samples = [];
for (let s = 0; s < 300; s++) {
    const p = s < 100 ? [s, 0] : s < 150 ? [100, s - 100] : s < 250 ? [250 - s, 50] : [0, 300 - s];
    samples.push(s, p[0], p[1]);
}
const sides = [0, 100, 150, 250, 300];
const at = arcAt(samples, sides, [40.5, 0.2]);
assert.ok(Math.abs(at.s - 40.5) < 1e-9 && at.side === 0 && Math.abs(at.d - 0.2) < 1e-9);
assert.equal(arcAt(samples, sides, [100, 25]).side, 1);
assert.ok(Math.abs(arcAt(samples, sides, [0, 0.5]).s - 299.5) < 1e-9, "the closing stretch interpolates to the perimeter");

// edit handles: Bézier c1/c2, a conic's control, arc ends locked
const nodes = [{ id: "p1_outline", kind: "profile.path", path: { start: [0, 0], segments: [
    { type: "line", to: [100, 0] },
    { type: "bezier", c1: [110, 10], c2: [110, 40], to: [100, 50] },
    { type: "conic", control: [50, 80], to: [0, 50], weight: 0.7 },
    { type: "arc", to: [0, 0], centre: [0, 25], ccw: true }] } }];
const pts = pointsOf(nodes, "p1");
assert.deepEqual(pts.points, [[0, 0], [100, 0], [100, 50], [0, 50]]);
assert.deepEqual(pts.handles, [
    { index: 1, which: "c1", at: [110, 10], from: 1 },
    { index: 1, which: "c2", at: [110, 40], from: 2 },
    { index: 2, which: "control", at: [50, 80], from: 2, to: 3 }]);
assert.deepEqual(pts.locked, [3, 0], "an arc's two ends");

// pick decoding
const drawings = new Map([["p1", { id: "p1", samples, sides }]]);
const pick = (point, node = 0) => ({ item: 9, node, face: 0, point: [...point, 0], segment: 0, distancePx: 1 });
assert.deepEqual(hitOf({ kind: "points", id: "p1" }, pick([100, 0], 1), drawings), { kind: "point", id: "p1", index: 1 });
assert.deepEqual(hitOf({ kind: "handles", id: "p1", handles: pts.handles }, pick([110, 40], 1), drawings), { kind: "handle", id: "p1", index: 1, which: "c2" });
const e = hitOf({ kind: "sew", id: "p1" }, pick([40, 0]), drawings);
assert.equal(e.kind, "edge"); assert.equal(e.side, 0); assert.ok(Math.abs(e.s - 40) < 1e-9); assert.equal(e.seam, undefined);
assert.equal(hitOf({ kind: "seam", id: "s1", pattern: "p1" }, pick([100, 25]), drawings).seam, "s1");
assert.deepEqual(hitOf({ kind: "fill", id: "p1" }, pick([50, 25]), drawings), { kind: "pattern", id: "p1" });
assert.deepEqual(hitOf({ kind: "internal", id: "p1", index: 2 }, pick([5, 5]), drawings), { kind: "internal", id: "p1", index: 2 });
assert.deepEqual(hitOf({ kind: "hole", id: "p1", index: 0 }, pick([5, 5]), drawings), { kind: "hole", id: "p1", index: 0 });
// a pick on a tangent line grabs the handle that tangent belongs to (the nearest tangent to the point)
const tan = { kind: "tangents", id: "p1", handles: pts.handles, points: pts.points };
assert.deepEqual(hitOf(tan, pick([105, 5]), drawings), { kind: "handle", id: "p1", index: 1, which: "c1" });
assert.deepEqual(hitOf(tan, pick([105, 45]), drawings), { kind: "handle", id: "p1", index: 1, which: "c2" });
assert.deepEqual(hitOf(tan, pick([75, 65]), drawings), { kind: "handle", id: "p1", index: 2, which: "control" }, "a conic's tangent from its start");
assert.deepEqual(hitOf(tan, pick([25, 65]), drawings), { kind: "handle", id: "p1", index: 2, which: "control" }, "and from its end");
assert.equal(hitOf({ kind: "tangents", id: "p1" }, pick([105, 5]), drawings), null, "no handles known: no hit");
assert.equal(hitOf(null, pick([0, 0]), drawings), null);
assert.deepEqual(unionBounds([{ bounds: [0, 0, 10, 10] }, { bounds: [-5, 2, 3, 20] }]), [-5, 0, 10, 20]);
assert.equal(unionBounds([]), null);
// notch normals point out of the piece, whichever way its outline runs
const sq = (ccw) => { const r = [[0, 0], [100, 0], [100, 50], [0, 50]]; const o = ccw ? r : r.reverse(); const out = [];
    let s = 0; o.forEach((p, i) => { const q = o[(i + 1) % 4], l = Math.hypot(q[0] - p[0], q[1] - p[1]);
        for (let k = 0; k < 10; k++) out.push(s + (l * k) / 10, p[0] + ((q[0] - p[0]) * k) / 10, p[1] + ((q[1] - p[1]) * k) / 10); s += l; }); return out; };
for (const ccw of [true, false]) {
    const d = { samples: sq(ccw), sew: ccw ? [0, 0, 100, 0, 100, 50, 0, 50, 0, 0] : [0, 0, 0, 50, 100, 50, 100, 0, 0, 0], notches: [[0, 25, 0], [50, 0, 0], [100, 25, 0]] };
    const n = notchNormals(d).map((v) => v.map((x) => Math.round(x * 1000) / 1000 + 0));
    assert.deepEqual(n, [[-1, 0], [0, -1], [1, 0]], `outward on a ${ccw ? "ccw" : "cw"} outline: ${JSON.stringify(n)}`);
}
console.log("view2d: ok");
