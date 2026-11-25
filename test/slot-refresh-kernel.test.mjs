// Slot frames refresh (spec §5) on the T-shirt sample: an outline edit re-centres a placed piece
// in the same undo step, live in a preview too; a new avatar re-places every placed piece in
// one undo step; a custom or unplaced piece is left alone; an "on:" piece follows its host.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadKernel } from "./package.mjs";
import { Atelier } from "../kernel.js";
import { arrangedPoint, onFrame, sceneBox, slotFields } from "../arrange.js";
import { translatePath } from "../drape.js";
import { gradeForm, startFrom } from "../form-grade.js";
import { formLandmarks, PRESETS } from "../form-pose.js";
import * as m from "../model.js";

const k = await loadKernel();
const a = new Atelier(k);
a.load(readFileSync(new URL("../assets/tshirt.json", import.meta.url), "utf8"));
const fM = JSON.parse(readFileSync(new URL("../assets/forms.json", import.meta.url), "utf8")).forms.find((f) => f.name === "f-M");
const sc = k.open(new Uint8Array(readFileSync(new URL("../assets/f-M.stp", import.meta.url))), "step", undefined, "native");
const fMAvatar = { bounds: sceneBox(sc.vertices(), sc.origin()), landmarks: fM };
sc.free();
const node = (label) => a.nodes().find((n) => n.label === label);
const bounds = (id) => a.drawings().find((d) => d.id === id).bounds;
const centre3d = (n) => { const b = bounds(n.id); return arrangedPoint(n.frame, n.wrap ?? null, (b[0] + b[2]) / 2, (b[1] + b[3]) / 2); };
const near = (p, q, tol, what) => p.forEach((v, i) => assert.ok(Math.abs(v - q[i]) < tol, `${what}: ${p} vs ${q}`));
const moveOps = (id, d) => m.setOutline(a.nodes(), id, translatePath(a.nodes().find((n) => n.id === `${id}_outline`).path, d));
const frames = () => JSON.stringify(a.nodes().filter((n) => n.kind === "garment.pattern").map((n) => [n.id, n.frame, n.wrap ?? null]));

// no avatar set: an edit leaves the frames as they are (the Node tests before A2)
const front0 = node("Front");
a.apply(moveOps(front0.id, [30, 0]), "move");
assert.deepEqual(node("Front").frame, front0.frame, "no avatar, no refresh");
a.undo();

// a new avatar: every placed piece re-placed in one commit, one undo takes it back
a.setAvatar(fMAvatar);
let before = frames();
let r = a.reslot();
assert.deepEqual(r.moved.map((id) => a.nodes().find((n) => n.id === id).label).sort(), ["Back", "Front"]);
assert.equal(a.reslot().ops.length, 0, "a second re-slot on the same form is a no-op");
assert.ok(a.undo());
assert.equal(frames(), before, "one undo step takes the re-arrange back");
a.redo();
const g = gradeForm("female", startFrom("female", "M"));
const lmT = formLandmarks(g, { legs: true, pose: PRESETS["T-pose"] });
a.setAvatar({ bounds: [-950, 0, -160, 950, 1531, 260], landmarks: lmT });
before = frames();
const historyBefore = a.head();
r = a.reslot();
assert.ok(r.moved.includes(node("Left sleeve").id) && r.moved.includes(node("Right sleeve").id), "the sleeves take the T-posed arms");
assert.deepEqual(node("Left sleeve").wrap.dir, lmT.arms.find((x) => x.side === "left").dir);
assert.ok(a.undo());
assert.equal(frames(), before, "the T-pose re-arrange is one undo step");
assert.equal(a.head(), historyBefore);
a.redo();
console.log(`ok - a new avatar re-places ${r.moved.length} pieces in one undo step`);

// an outline edit (a 2D move) re-centres the placed piece: its bounds centre stays on the slot
const front = node("Front"), at = centre3d(front), frontBounds = bounds(front.id);
a.apply(moveOps(front.id, [120, -40]), "move");
const moved = node("Front");
assert.notDeepEqual(moved.frame.origin, front.frame.origin, "the frame follows the move");
near(centre3d(moved), at, 1e-6, "the front's centre stays on its slot");
const want = slotFields(moved, "front", a.avatar.bounds, bounds(moved.id), { landmarks: lmT });
near(moved.frame.origin, want.frame.origin, 1e-9, "slotFields' frame");
assert.ok(a.undo());
assert.deepEqual(node("Front").frame, front.frame, "the move and its re-place are one undo step");
near(bounds(front.id), frontBounds, 1e-9, "and the outline is back");
console.log("ok - a 2D move re-centres the front on its slot, in the move's undo step");

// a sleeve's edit re-wraps it (armFields reads the pattern's bounds); live in a preview too
const sleeve = node("Left sleeve");
a.preview(moveOps(sleeve.id, [0, 60]));
const live = node("Left sleeve");
const wantS = slotFields(live, "left_arm", a.avatar.bounds, bounds(live.id), { landmarks: lmT });
near(live.frame.origin, wantS.frame.origin, 1e-9, "the sleeve re-placed in the preview");
a.endPreview(true);
near(node("Left sleeve").frame.origin, wantS.frame.origin, 1e-9, "and in the commit");
a.undo();
assert.deepEqual(node("Left sleeve").frame, sleeve.frame);
console.log("ok - a sleeve moved in 2D stays wrapped on its arm, live in the preview and committed");

// a custom slot is not re-placed: it keeps its frame's axes, anchored at its bounds centre (a
// piece grown on one side keeps its centre's 3D point); one with no slot is left alone
const growOps = (id, dx) => {
    const b = bounds(id), mid = (b[0] + b[2]) / 2;
    const grow = (x) => {
        if (Array.isArray(x) && x.length === 2 && typeof x[0] === "number" && typeof x[1] === "number") return x[0] > mid ? [x[0] + dx, x[1]] : x;
        if (Array.isArray(x)) return x.map(grow);
        if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, grow(v)]));
        return x;
    };
    return m.setOutline(a.nodes(), id, grow(a.nodes().find((n) => n.id === `${id}_outline`).path));
};
const axes = (f) => JSON.stringify([f.x, f.y]);
const back = node("Back");
a.apply(m.setPattern(a.nodes(), back.id, { meta: { ...back.meta, atelier: { ...back.meta.atelier, slot: "custom" } } }), "custom");
const backAt = centre3d(node("Back")), backBounds = bounds(back.id);
a.apply(growOps(back.id, 80), "grow");
assert.ok(Math.abs(bounds(back.id)[2] - backBounds[2] - 80) < 1e-6, "the back grew 80 mm on its right");
assert.equal(axes(node("Back").frame), axes(back.frame), "a custom slot keeps its frame's axes");
assert.notDeepEqual(node("Back").frame.origin, back.frame.origin, "and shifts its origin");
near(centre3d(node("Back")), backAt, 1e-6, "the grown back's bounds centre stays at its 3D point");
assert.ok(a.undo());
assert.deepEqual(node("Back").frame, back.frame, "one undo takes the grow and the anchor back");
near(bounds(back.id), backBounds, 1e-9, "and the outline");
// a 2D move of a custom piece leaves it where it stands in 3D, live in a preview too
a.preview(moveOps(back.id, [60, -20]));
near(centre3d(node("Back")), backAt, 1e-6, "the moved back's centre stays put in the preview");
a.endPreview(true);
near(centre3d(node("Back")), backAt, 1e-6, "and in the commit");
a.undo(); a.undo();
assert.deepEqual(node("Back").frame, back.frame);
// a wrapped custom piece keeps its wrap: grown across the limb and along it, its centre stays
const sl = node("Left sleeve");
a.apply(m.setPattern(a.nodes(), sl.id, { meta: { ...sl.meta, atelier: { ...sl.meta.atelier, slot: "custom" } } }), "custom");
const slAt = centre3d(node("Left sleeve"));
assert.ok(sl.wrap?.radius > 0, "the sleeve is wrapped");
a.apply(growOps(sl.id, 70), "grow");
a.apply(moveOps(sl.id, [0, 45]), "move");
assert.deepEqual(node("Left sleeve").wrap, sl.wrap, "a wrapped custom piece keeps its wrap");
near(centre3d(node("Left sleeve")), slAt, 1e-6, "the grown sleeve's centre stays on its 3D point");
a.undo(); a.undo(); a.undo();
assert.deepEqual(node("Left sleeve").frame, sl.frame);
console.log("ok - a custom piece grown or moved in 2D stays anchored at its bounds centre, one undo step");
const rs = node("Right sleeve"), rsAtelier = { ...rs.meta.atelier };
delete rsAtelier.slot;
a.apply(m.setPattern(a.nodes(), rs.id, { meta: { ...rs.meta, atelier: rsAtelier } }), "no slot");
a.apply(moveOps(rs.id, [0, 50]), "move");
assert.deepEqual(node("Right sleeve").frame, rs.frame, "a piece with no slot keeps its frame");
a.undo(); a.undo();
console.log("ok - a custom slot and a piece with no slot are left alone");

// an "on:" piece follows its host when the host is re-placed
const host = node("Front"), guest = node("Left sleeve");
a.apply(m.setPattern(a.nodes(), guest.id, {
    layer: 1, wrap: null, frame: onFrame(host.frame, 1),
    meta: { ...guest.meta, atelier: { ...guest.meta.atelier, slot: `on:${host.id}` } },
}), "on");
a.apply(moveOps(host.id, [-70, 25]), "move host");
const hostNow = node("Front"), guestNow = node("Left sleeve");
assert.notDeepEqual(hostNow.frame.origin, host.frame.origin);
near(guestNow.frame.origin, onFrame(hostNow.frame, 1).origin, 1e-9, "the guest a layer out from its host's new frame");
assert.equal(guestNow.wrap ?? null, null);
a.undo();
near(node("Left sleeve").frame.origin, onFrame(host.frame, 1).origin, 1e-9, "one undo puts both back");
console.log("ok - an on: piece follows its re-placed host, in the same undo step");
a.free();
