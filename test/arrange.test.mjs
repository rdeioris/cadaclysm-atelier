import assert from "node:assert/strict";
import { SLOTS, slotFrame, frame12, polylineSegments, floorFrame, seamSegments, ItemMap, showSeams, isSelected, survivingSelection, ACCENT, bodyBounds, HOOD_SLOTS, hoodFrame, armFields, onFrame, slotFields, arrangeSlots } from "../arrange.js";
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
    assert.ok(isSelected({ kind: "pattern", id: "p1", ids: ["p1", "p2"] }, "pattern", "p2"));
    // a selection after a document change keeps only the pieces that still exist
    const has = (id) => id !== "p2";
    assert.deepEqual(survivingSelection({ kind: "pattern", id: "p1", ids: ["p1", "p2", "p3"] }, has), { kind: "pattern", id: "p1", ids: ["p1", "p3"] });
    assert.deepEqual(survivingSelection({ kind: "pattern", id: "p1", ids: ["p1", "p2"] }, has), { kind: "pattern", id: "p1" });
    assert.deepEqual(survivingSelection({ kind: "pattern", id: "p2", ids: ["p2", "p3"] }, has), { kind: "pattern", id: "p3" });
    assert.equal(survivingSelection({ kind: "pattern", id: "p2", ids: ["p2"] }, has), null);
    assert.equal(survivingSelection({ kind: "seam", id: "p2" }, has), null);
    const keep = { kind: "seam", id: "s1" };
    assert.equal(survivingSelection(keep, has), keep, "an intact selection is the same object");
    assert.equal(survivingSelection(null, has), null);
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
// ---- landmarks (assets/forms.json shape) ----
// f-M's own figures from assets/forms.json: its arms' `dir` are unit vectors (unrounded, as
// tools/dressform.py writes them), and the head is Task 1's follow-up head (chin 1520, crown 1745).
const LM = {
    body_top: 1531, hps_y: 1425,
    arms: [{ side: "left", shoulder: [182, 1352, -8], dir: [0.6669996117546515, -0.7407781162009287, 0.07974522228289], radius: 50 },
        { side: "right", shoulder: [-182, 1352, -8], dir: [-0.6669996117546515, -0.7407781162009287, 0.07974522228289], radius: 50 }],
    head: { centre: [0, 1630, 4], half: [75, 112.5, 95], top: 1745, chin_y: 1520 },
};
const at = (f, p) => [0, 1, 2].map((i) => f.origin[i] + p[0] * f.x[i] + p[1] * f.y[i]);
const near = (p, q, tol = 1e-6) => p.every((v, i) => Math.abs(v - q[i]) < tol);
{
    const headed = [-666.85, 0, -156, 666.85, 1745, 144];
    assert.deepEqual(bodyBounds(headed, LM), [-666.85, 0, -156, 666.85, 1531, 144], "the head does not count");
    assert.equal(bodyBounds(headed, null), headed);
    // front and back hang from the shoulder line: the piece's top at hps_y
    const pb = [-280, 220, 280, 580];
    const front = slotFields({ meta: {} }, "front", headed, pb, { landmarks: LM }).frame;
    assert.ok(Math.abs(at(front, [0, 580])[1] - 1425) < 1e-9, "front top on the shoulder line");
    const back = slotFields({ meta: {} }, "back", headed, pb, { landmarks: LM }).frame;
    assert.ok(Math.abs(at(back, [0, 580])[1] - 1425) < 1e-9, "back top on the shoulder line");
    // hood left: face edge (2D x min) forward at the neck, beside the head, facing +x
    const hb = [0, 0, 250, 340];
    const hl = hoodFrame(1, LM.head, LM.hps_y, hb);
    assert.ok(near(at(hl, [0, 0]), [75 + 40, 1425, 4 + 95 + 30]), `hood left corner ${at(hl, [0, 0])}`);
    assert.ok(at(hl, [250, 0])[2] < at(hl, [0, 0])[2], "2D x runs back");
    const n = [hl.x[1] * hl.y[2] - hl.x[2] * hl.y[1], hl.x[2] * hl.y[0] - hl.x[0] * hl.y[2], hl.x[0] * hl.y[1] - hl.x[1] * hl.y[0]];
    assert.ok(n[0] > 0.99, "faces out (+x)");
    // hood right (the mirrored half): its face edge is 2D x max, forward, on -x
    const hr = hoodFrame(-1, LM.head, LM.hps_y, [400, 0, 650, 340]);
    assert.ok(near(at(hr, [650, 0]), [-(75 + 40), 1425, 129]));
    assert.ok(at(hr, [400, 0])[2] < 129);
    assert.throws(() => slotFields({ meta: {} }, "hood_left", headed, hb, { landmarks: { ...LM, head: undefined } }), /no head/);
    assert.deepEqual(Object.keys(HOOD_SLOTS), ["hood_left", "hood_right"]);
    // a sleeve on an arm is wrapped: its hem (2D y min) 40 mm past its length down the arm
    // (the arm's dir is a true unit vector, so `along` is exact to 1e-6)
    const sb = [-198.25, -180, 198.25, 280];
    const f = armFields(LM.arms[0], sb);
    assert.equal(f.wrap.radius, 65);
    assert.deepEqual(f.wrap.origin, LM.arms[0].shoulder);
    const hem = at(f.frame, [0, -180]);
    const along = [0, 1, 2].reduce((s, i) => s + (hem[i] - LM.arms[0].shoulder[i]) * LM.arms[0].dir[i], 0);
    assert.ok(Math.abs(along - (460 + 40)) < 1e-6, `hem ${along} mm down the arm`);
    const viaSlot = slotFields({ meta: {} }, "left_arm", headed, sb, { landmarks: LM });
    assert.deepEqual(viaSlot.wrap, f.wrap);
    assert.equal(slotFields({ meta: {} }, "left_arm", headed, sb, {}).wrap, null, "no landmarks: the old flat slot");
    // on a piece: the host's frame and wrap, 8 mm out a layer
    const host = { id: "p1", layer: 0, frame: front, wrap: null };
    const on = slotFields({ layer: 1, meta: {} }, "on:p1", headed, [-180, 5, 180, 215], { host });
    assert.equal(on.meta.atelier.slot, "on:p1");
    const nrm = [0, 0, 1];
    assert.ok(near(on.frame.origin, front.origin.map((v, i) => v + 8 * nrm[i])), "8 mm out");
    assert.deepEqual(on.frame.x, front.x);
    assert.deepEqual(onFrame(front, 0), front);
    assert.ok(near(onFrame(front, 2).origin, front.origin.map((v, i) => v + 16 * nrm[i])), "16 mm out two layers");
    const wrapped = slotFields({ layer: 0, meta: {} }, "on:p2", headed, [0, -90, 220, -20], { host: { id: "p2", layer: 0, ...f } });
    assert.deepEqual(wrapped.wrap, f.wrap, "a cuff on a sleeve wraps with it");
    assert.throws(() => slotFields({ meta: {} }, "on:p9", headed, pb, { host: { id: "p9", frame: "xy" } }), /first/);
}
// Arrange fills the free named slots in the old order, then the hood slots on a form with a
// head; it never puts a piece on another, even one sewn to a placed piece (on:<id> is the
// user's pick only)
{
    const pat = (id, slot) => ({ id, kind: "garment.pattern", layer: 0, meta: slot ? { atelier: { slot } } : {}, ...(slot ? { frame: slotFrame(slot, [-666.85, 0, -156, 666.85, 1745, 144], [-280, 220, 280, 580]) } : {}) });
    const seam = (id, a, b) => ({ id, kind: "garment.seam", a, b });
    const ids = ["front", "back", "lside", "rside", "lsleeve", "rsleeve", "lhood", "rhood"];
    const nodes = [pat("front", "front"), ...ids.slice(1).map((id) => pat(id)),
        ...ids.slice(1).map((id, i) => seam(`s${i}`, id, "front")),
        { id: "garment", kind: "garment", patterns: ids, seams: ids.slice(1).map((_, i) => `s${i}`) }];
    const drawings = new Map(ids.map((id) => [id, { bounds: [-180, 0, 180, 300] }]));
    const headed = [-666.85, 0, -156, 666.85, 1745, 144];
    const got = arrangeSlots(nodes, drawings, { bounds: headed, landmarks: LM });
    assert.deepEqual(got.map((g) => [g.id, g.fields.meta.atelier.slot]), [["back", "back"], ["lside", "left_side"], ["rside", "right_side"],
        ["lsleeve", "left_arm"], ["rsleeve", "right_arm"], ["lhood", "hood_left"], ["rhood", "hood_right"]], "free slots, never on the front");
    const byId = new Map(got.map((g) => [g.id, g.fields]));
    assert.ok(Math.abs(at(byId.get("back").frame, [0, 300])[1] - 1425) < 1e-9, "the back hangs from the shoulder line");
    assert.equal(byId.get("lsleeve").wrap.radius, 65, "the sleeves wrap");
    assert.ok(near(byId.get("lhood").frame.origin, hoodFrame(1, LM.head, LM.hps_y, [-180, 0, 180, 300]).origin), "the hood beside the head");
    // no head: no hood slots, the hood halves stay on the floor
    const plain = arrangeSlots(nodes, drawings, { bounds: headed, landmarks: { ...LM, head: undefined } });
    assert.deepEqual(plain.map((g) => g.id), ["back", "lside", "rside", "lsleeve", "rsleeve"]);
    // no landmarks: the old fractions of the bounds, no wrap
    const old = arrangeSlots(nodes, drawings, { bounds: headed, landmarks: null });
    assert.deepEqual(old.map((g) => g.fields.frame), old.map((g) => slotFrame(g.fields.meta.atelier.slot, headed, [-180, 0, 180, 300])));
    assert.ok(old.every((g) => g.fields.wrap === null));
}
// without landmarks every named slot is the old one exactly
for (const s of Object.keys(SLOTS)) for (const ctx of [{}, { landmarks: null }]) {
    const b = [-666.85, 0, -156, 666.85, 1745, 144], pb = [-280, 220, 280, 580];
    const r = slotFields({ meta: {} }, s, b, pb, ctx);
    assert.deepEqual(r.frame, slotFrame(s, b, pb), `${s} unchanged`);
    assert.equal(r.wrap, null);
}
// on:<id> refusals in slotFields itself: not on itself, an unknown id named
{
    const pb = [-280, 220, 280, 580], b = [-666.85, 0, -156, 666.85, 1745, 144];
    const host = { id: "p1", layer: 0, frame: slotFrame("front", b, pb), wrap: null };
    assert.throws(() => slotFields({ id: "p1", meta: {} }, "on:p1", b, pb, { host }), /itself/);
    assert.throws(() => slotFields({ id: "p2", meta: {} }, "on:p7", b, pb, { host: undefined }), /no piece p7/);
    // an off-centre head: the hood follows its x
    const hb = [0, 0, 250, 340];
    const off = hoodFrame(1, { ...LM.head, centre: [20, 1630, 4] }, LM.hps_y, hb);
    assert.ok(near(at(off, [0, 0]), [20 + 75 + 40, 1425, 129]), `off-centre hood ${at(off, [0, 0])}`);
    // landmarks with one arm: a clear refusal for the other
    assert.throws(() => slotFields({ meta: {} }, "right_arm", b, pb, { landmarks: { ...LM, arms: [LM.arms[0]] } }), /no right arm/);
    // a piece on a wrapped piece: the wrap grows with it, so the arc length round the arm holds
    const sleeve = armFields(LM.arms[0], [-198.25, -180, 198.25, 280]);
    const cuff = slotFields({ layer: 2, meta: {} }, "on:s", b, [0, -90, 220, -20], { host: { id: "s", layer: 0, ...sleeve } });
    assert.equal(cuff.wrap.radius, 65 + 16);
    assert.deepEqual(cuff.wrap.origin, sleeve.wrap.origin);
    assert.equal(sleeve.wrap.radius, 65, "the host's wrap untouched");
}
console.log("ok - arrange: landmarks, hood slots, arm wrap, on a piece");
