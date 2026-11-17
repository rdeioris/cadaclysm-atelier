import assert from "node:assert/strict";
import { SLOTS, slotFrame, frame12, polylineSegments, floorFrame, seamSegments, ItemMap } from "../arrange.js";
const avatar = [-200, 0, -150, 200, 1700, 150];   // min xyz, max xyz (y up, facing +z)
const piece = [0, 0, 400, 600];
const f = slotFrame("front", avatar, piece);
assert.ok(f.origin[2] > avatar[5], "the front slot stands in front of the avatar");
assert.deepEqual(f.y, [0, 1, 0], "2D up is world up");
const b = slotFrame("back", avatar, piece);
assert.ok(b.origin[2] < avatar[2]);
assert.ok(b.x[0] < 0, "the back panel faces backwards, so its x runs the other way");
for (const k of Object.keys(SLOTS)) {
    const s = slotFrame(k, avatar, piece);
    const dot = s.x[0] * s.y[0] + s.x[1] * s.y[1] + s.x[2] * s.y[2];
    assert.ok(Math.abs(dot) < 1e-12, `${k}: axes orthogonal`);
}
// centred: the piece's centre lands on the slot point
const c = slotFrame("front", avatar, [100, 200, 300, 400]);
const centre = [200, 300];
const world = [0, 1, 2].map((i) => c.origin[i] + centre[0] * c.x[i] + centre[1] * c.y[i]);
const slotPoint = [0, 1, 2].map((i) => avatar[i] + SLOTS.front.origin[i] * (avatar[i + 3] - avatar[i]));
assert.ok(world.every((v, i) => Math.abs(v - slotPoint[i]) < 1e-9));

// worker helpers: z = x cross y, the floor default, segments through a frame
assert.deepEqual(Array.from(frame12(b)).slice(9), [0, 0, -1], "back: z = (-x) cross y = -z");
assert.deepEqual(Array.from(frame12(undefined)), [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
assert.equal(frame12([1, 2, 3, 1, 0, 0, 0, 1, 0, 0, 0, 1]).length, 12);
const fl = floorFrame(avatar);
// two pieces 300 mm apart in 2D stay 300 mm apart on the floor
const place = (x, y) => [0, 1, 2].map((i) => fl.origin[i] + x * fl.x[i] + y * fl.y[i]);
const p1 = place(0, 0), p2 = place(300, 0), p3 = place(0, 200);
assert.equal(p2[0] - p1[0], 300); assert.equal(p1[2] - p3[2], 200); assert.equal(p1[1], p2[1]);
assert.ok(p1[0] > avatar[3]);
assert.ok(fl.origin[0] > avatar[3], "floor pieces lie beside the avatar");
assert.deepEqual(Array.from(frame12(fl)).slice(9).map((v) => v + 0), [0, 1, 0], "floor frame faces up");
const seg = polylineSegments([0, 0, 10, 0], { origin: [1, 2, 3], x: [0, 0, 1], y: [0, 1, 0] });
assert.deepEqual(seg, [1, 2, 3, 1, 2, 13]);
const im = new ItemMap(); im.set(7, { kind: "pattern", id: "p1" });
assert.deepEqual(im.resolve(7), { kind: "pattern", id: "p1" }); assert.equal(im.resolve(9), null);
const ss = seamSegments({ points_a: [0, 0, 0, 10], points_b: [0, 0, 0, 10], reversed: true }, { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0] }, { origin: [0, 0, 5], x: [1, 0, 0], y: [0, 1, 0] });
assert.deepEqual(ss.slice(0, 12), [0, 0, 0, 0, 10, 0, 0, 0, 5, 0, 10, 5], "both ranges as lines");
assert.deepEqual(ss.slice(12, 18), [0, 0, 0, 0, 10, 5], "reversed: first of a meets last of b");
console.log("arrange: ok");
