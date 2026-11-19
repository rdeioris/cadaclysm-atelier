import assert from "node:assert/strict";
import { SLOTS, slotFrame, frame12, polylineSegments, floorFrame, seamSegments, ItemMap, showSeams, isSelected, ACCENT } from "../arrange.js";
import { seamColour } from "../sewing.js";
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
// the side and arm slots stand just outside the avatar's x bounds -- for the test box and for
// f-M, whose bounds take in its arms -- never metres away; the arms beyond the sides
for (const box of [avatar, [-666.85, 0, -156, 666.85, 1531, 144]]) {
    const w = box[3] - box[0];
    for (const k of ["left_side", "left_arm"]) {
        const x = slotFrame(k, box, piece).origin[0];
        assert.ok(x > box[3] && x <= box[3] + 0.25 * w, `${k} just right of the bounds: ${x}`);
    }
    for (const k of ["right_side", "right_arm"]) {
        const x = slotFrame(k, box, piece).origin[0];
        assert.ok(x < box[0] && x >= box[0] - 0.25 * w, `${k} just left of the bounds: ${x}`);
    }
    assert.ok(slotFrame("left_arm", box, piece).origin[0] > slotFrame("left_side", box, piece).origin[0], "left arm beyond the left side");
    assert.ok(slotFrame("right_arm", box, piece).origin[0] < slotFrame("right_side", box, piece).origin[0], "right arm beyond the right side");
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
// I6: one lines item per seam, in its 2D colour (the accent when selected), each its own pick target
{
    const calls = [];
    const viewer = { showLines: (segs, colour) => { calls.push(colour); return 100 + calls.length; } };
    const fr = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0] };
    const seams = ["s1", "s2", "s3"].map((id) => ({ id, a: "p1", b: "p2", points_a: [0, 0, 0, 10], points_b: [5, 0, 5, 10], reversed: false }));
    const frames = new Map([["p1", fr], ["p2", fr]]);
    const { shown, error } = showSeams(viewer, seams, frames, { kind: "seam", id: "s2" });
    assert.equal(error, null);
    assert.deepEqual(shown.map((s) => [s.item, s.id, s.colour]), [[101, "s1", seamColour(0)], [102, "s2", seamColour(1)], [103, "s3", seamColour(2)]]);
    assert.deepEqual(calls, [seamColour(0), ACCENT, seamColour(2)]);
    assert.equal(isSelected({ kind: "seam", id: "s2" }, "seam", "s2"), true);
    assert.equal(isSelected({ kind: "pattern", id: "s2" }, "seam", "s2"), false);
    assert.equal(isSelected(null, "seam", "s2"), false);
    const map = new ItemMap();
    for (const s of shown) map.set(s.item, { kind: "seam", id: s.id });
    assert.deepEqual(map.resolve(103), { kind: "seam", id: "s3" });
}
console.log("arrange: ok");

// a sleeve wrapped round a limb: y runs up the limb, the origin `radius` off the axis, `dist` down it
{
    const { limbFields, sceneBox } = await import("../arrange.js");
    const dir = [Math.sin(0.7), -Math.cos(0.7), 0];
    const r = limbFields([100, 1300, 0], dir, 60, 200, [0, 0, 300, 200]);
    assert.deepEqual(r.wrap, { origin: [100, 1300, 0], dir: r.wrap.dir, radius: 60 });
    assert.ok(r.frame.y.every((v, i) => Math.abs(v + dir[i]) < 1e-12), "y up the limb");
    const o = r.frame.origin.map((v, i) => v - [100, 1300, 0][i]);
    const along = o[0] * dir[0] + o[1] * dir[1] + o[2] * dir[2];
    assert.ok(Math.abs(along - 200) < 1e-9, `the hem ${along} down the limb`);
    const radial = Math.hypot(...o.map((v, i) => v - along * dir[i]));
    assert.ok(Math.abs(radial - 60) < 1e-9, "the origin on the cylinder");
    assert.ok(Math.abs(r.frame.x.reduce((s, v, i) => s + v * dir[i], 0)) < 1e-12, "x round the limb");
    // nine floats a vertex: only the positions count
    assert.deepEqual(sceneBox([1, 2, 3, 9, 9, 9, 9, 9, 9, -1, 0, 5, 0, 0, 0, 0, 0, 0], [10, 0, 0]), [9, 0, 3, 11, 2, 5]);
}
