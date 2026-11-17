import assert from "node:assert/strict";
import { Camera, hitTest, pointInRing, draw, pointsOf } from "../view2d.js";

const cam = new Camera(800, 600);
cam.fit([0, 0, 100, 50], 40);
const [sx, sy] = cam.toScreen([0, 0]);
const [wx, wy] = cam.toWorld([sx, sy]);
assert.ok(Math.abs(wx) < 1e-9 && Math.abs(wy) < 1e-9);
assert.ok(cam.toScreen([0, 50])[1] < cam.toScreen([0, 0])[1], "y up in the world is up on screen");
const before = cam.toWorld([400, 300]);
cam.zoomAt([400, 300], 2);
const after = cam.toWorld([400, 300]);
assert.ok(Math.hypot(before[0] - after[0], before[1] - after[1]) < 1e-9, "zoom keeps the point under the cursor");

assert.equal(pointInRing([0, 0, 10, 0, 10, 10, 0, 10], [5, 5]), true);
assert.equal(pointInRing([0, 0, 10, 0, 10, 10, 0, 10], [15, 5]), false);

const ring = [0, 0, 100, 0, 100, 50, 0, 50, 0, 0];
const samples = [];
for (let s = 0; s < 300; s++) {
    const p = s < 100 ? [s, 0] : s < 150 ? [100, s - 100] : s < 250 ? [250 - s, 50] : [0, 300 - s];
    samples.push(s, p[0], p[1]);
}
const drawing = { id: "p1", sew: ring, cut: ring, samples, sides: [0, 100, 150, 250, 300], notches: [], internal: [], grain: [50, 10, 50, 40], bounds: [0, 0, 100, 50] };
const nodes = [{ id: "p1_outline", kind: "profile.path", path: { start: [0, 0], segments: [
    { type: "line", to: [100, 0] }, { type: "bezier", c1: [110, 10], c2: [110, 40], to: [100, 50] }, { type: "line", to: [0, 50] }, { type: "line", to: [0, 0] }] } }];
const pts = pointsOf(nodes, "p1");
assert.deepEqual(pts.points, [[0, 0], [100, 0], [100, 50], [0, 50]]);
assert.deepEqual(pts.handles, [{ index: 1, c1: [110, 10], c2: [110, 40] }]);

const c2 = new Camera(800, 600); c2.fit([0, 0, 100, 50], 40);
const tol = 8;
assert.deepEqual(hitTest([drawing], [], [100, 0], tol, c2, nodes, "p1"), { kind: "point", id: "p1", index: 1 });
assert.deepEqual(hitTest([drawing], [], [110, 10], tol, c2, nodes, "p1"), { kind: "handle", id: "p1", index: 1, which: "c1" });
const e = hitTest([drawing], [], [40, 0.2], tol, c2, nodes, null);
assert.equal(e.kind, "edge"); assert.equal(e.id, "p1"); assert.equal(e.side, 0); assert.equal(e.s, 40);
assert.deepEqual(hitTest([drawing], [], [50, 25], tol, c2, nodes, null), { kind: "pattern", id: "p1" });
assert.equal(hitTest([drawing], [], [500, 500], tol, c2, nodes, null), null);

const calls = [];
const ctx2 = { canvas: { width: 800, height: 600 } };
const ctx = new Proxy({}, { get: (_, k) => (k in ctx2 ? ctx2[k] : (...a) => calls.push([k, ...a])), set: (_, k, v) => { ctx2[k] = v; return true; } });
draw(ctx, c2, { drawings: [drawing], seams: [], selection: { kind: "pattern", id: "p1" }, hover: null, nodes, overlay: null });
assert.ok(calls.filter((c) => c[0] === "stroke").length >= 3);
console.log("view2d: ok");
