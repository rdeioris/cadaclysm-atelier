// Re-slot (reslot.js) on the T-shirt sample: placed pieces back on their slots for the avatar now
// shown -- a no-op on the same form, sleeves turning with a posed arm, the body slots held by
// slot_bounds whatever the pose, and an "on:" piece following its host.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadKernel } from "./package.mjs";
import { Atelier } from "../kernel.js";
import { reslotOps } from "../reslot.js";
import { sceneBox } from "../arrange.js";
import { gradeForm, startFrom } from "../form-grade.js";
import { formLandmarks, PRESETS } from "../form-pose.js";

const k = await loadKernel();
const a = new Atelier(k);
a.load(readFileSync(new URL("../assets/tshirt.json", import.meta.url), "utf8"));
const fM = JSON.parse(readFileSync(new URL("../assets/forms.json", import.meta.url), "utf8")).forms.find((f) => f.name === "f-M");
const sc = k.open(new Uint8Array(readFileSync(new URL("../assets/f-M.stp", import.meta.url))), "step", undefined, "native");
const stpBox = sceneBox(sc.vertices(), sc.origin());
sc.free();
const drawings = () => new Map(a.drawings().map((d) => [d.id, d]));
const byLabel = (label) => a.nodes().find((n) => n.label === label);
const sleeve = byLabel("Left sleeve"), front = byLabel("Front");

// f-M with its landmarks: the sleeves are already there; the sample's front and back were placed
// before landmarks (no shoulder line), so they move up to hang from it: 2.32 mm
let r = reslotOps(a.nodes(), drawings(), { bounds: stpBox, landmarks: fM });
assert.deepEqual(r.skipped, []);
assert.deepEqual(r.moved.map((id) => a.nodes().find((n) => n.id === id).label).sort(), ["Back", "Front"]);
const dy = r.ops.find((o) => o.id === front.id).fields.frame.origin[1] - front.frame.origin[1];
assert.ok(Math.abs(dy) < 3, `front moves ${dy} mm`);
a.apply(r.ops, "re-arrange on the form");
r = reslotOps(a.nodes(), drawings(), { bounds: stpBox, landmarks: fM });
assert.deepEqual(r.ops, [], "a second re-slot on the same form is a no-op");
console.log(`ok - re-slot on f-M: the sleeves stay, the front and back move ${dy.toFixed(2)} mm to the shoulder line, then a no-op`);

// a custom f-M with legs: the same slots as the shipped f-M's, to 5 mm (slot_bounds)
const g = gradeForm("female", startFrom("female", "M"));
const legsBox = [-700, 0, -160, 700, 1531, 260];
const lmRest = formLandmarks(g, { legs: true, pose: PRESETS.Rest });
r = reslotOps(a.nodes(), drawings(), { bounds: legsBox, landmarks: lmRest });
for (const op of r.ops) {
    const n = a.nodes().find((x) => x.id === op.id);
    const off = Math.hypot(...op.fields.frame.origin.map((v, i) => v - n.frame.origin[i]));
    assert.ok(off < 5, `${n.label} moves ${off} mm on the custom f-M`);
}
console.log(`ok - re-slot on a custom f-M with legs: ${r.moved.length} pieces moved (each by under 5 mm)`);

// T-pose: the sleeves wrap the new arm direction; the front and back are where Rest puts them
const lmT = formLandmarks(g, { legs: true, pose: PRESETS["T-pose"] });
const rRest = reslotOps(a.nodes(), drawings(), { bounds: legsBox, landmarks: lmRest });
const tBox = [-950, 0, -160, 950, 1531, 260];      // the T-pose's own bounds: wider, slot_bounds ignores them
const rT = reslotOps(a.nodes(), drawings(), { bounds: tBox, landmarks: lmT });
const fieldsOf = (res, id) => res.ops.find((o) => o.id === id)?.fields ?? a.nodes().find((n) => n.id === id);
const sl = fieldsOf(rT, sleeve.id);
assert.deepEqual(sl.wrap.dir, lmT.arms.find((x) => x.side === "left").dir, "the left sleeve wraps the T-posed arm");
assert.ok(Math.abs(sl.wrap.dir[1]) < 1e-12, "a T-posed arm is level");
for (const label of ["Front", "Back"]) {
    const id = byLabel(label).id, fr = fieldsOf(rT, id).frame, fRest = fieldsOf(rRest, id).frame;
    fr.origin.forEach((v, i) => assert.ok(Math.abs(v - fRest.origin[i]) < 1e-9, `${label} frame at T-pose`));
}
console.log("ok - T-pose: the sleeves take the new arm, the front and back stay");

// an "on:" piece follows its host's new frame
const pocketOps = a.nodes().filter((n) => n.label === "Front").map((n) => n);
const host = pocketOps[0];
a.apply([{ op: "set", id: sleeve.id, fields: { meta: { ...sleeve.meta, atelier: { ...sleeve.meta.atelier, slot: `on:${host.id}` } }, layer: 1 } }], "on");
r = reslotOps(a.nodes(), drawings(), { bounds: tBox, landmarks: lmT });
const hostNow = fieldsOf(r, host.id).frame, onNow = fieldsOf(r, sleeve.id);
const n = [hostNow.x[1] * hostNow.y[2] - hostNow.x[2] * hostNow.y[1], hostNow.x[2] * hostNow.y[0] - hostNow.x[0] * hostNow.y[2], hostNow.x[0] * hostNow.y[1] - hostNow.x[1] * hostNow.y[0]];
onNow.frame.origin.forEach((v, i) => assert.ok(Math.abs(v - (hostNow.origin[i] + 8 * n[i])) < 1e-9, "on its host, a layer out"));
assert.equal(onNow.wrap ?? null, null);
console.log("ok - an on: piece follows its host");
