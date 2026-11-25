// Dress-form poses and landmarks (form-pose.js): the script's landmarks at Rest, posed
// directions, joint limits, and the pose-independent box the slots scale with.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadKernel } from "./package.mjs";
import { SIZES, grade, chartMeasurements, startFrom, gradeForm } from "../form-grade.js";
import {
    formLandmarks, PRESETS, REST, LIMITS, ARM_REST_FLEX, validatePose, normalisePose, limbDir,
    legSkeleton, armSkeleton, limbRotation, rot, segmentFrame, handSections,
} from "../form-pose.js";
import { sceneBox, slotFields } from "../arrange.js";

const golden = JSON.parse(readFileSync(new URL("./fixtures/dressform-golden.json", import.meta.url), "utf8"));
const forms = JSON.parse(readFileSync(new URL("../assets/forms.json", import.meta.url), "utf8")).forms;
const RAD = Math.PI / 180;

// deep-equal with numbers to `tol`
function same(a, b, tol, path = "") {
    if (typeof a === "number" && typeof b === "number") { assert.ok(Math.abs(a - b) <= tol, `${path}: ${a} vs ${b}`); return; }
    if (Array.isArray(a)) { assert.ok(Array.isArray(b) && a.length === b.length, `${path}: length`); a.forEach((v, i) => same(v, b[i], tol, `${path}[${i}]`)); return; }
    if (a && typeof a === "object") {
        assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), `${path}: keys`);
        for (const key of Object.keys(a)) same(a[key], b[key], tol, `${path}.${key}`);
        return;
    }
    assert.equal(a, b, path);
}
const strip = (lm, extra = []) => Object.fromEntries(Object.entries(lm).filter(([key]) => !["name", "label", "file", ...extra].includes(key)));

// parity: the script's landmarks() for the 10 sizes, head off and on (no legs, no pose)
for (const gf of golden.forms) {
    const g = grade(gf.body, chartMeasurements(gf.body, gf.size));
    for (const [head, want] of [[false, gf.landmarks], [true, gf.landmarks_head]])
        same(strip(formLandmarks(g, { head }), ["slot_bounds"]), strip(want), 1e-9, `${gf.body}-${gf.size}${head ? "-head" : ""}`);
}
// and forms.json's entries, whatever it lists
const bodyOf = { f: "female", m: "male" };
for (const f of forms) {
    const [b, size] = f.name.split("-");
    const g = grade(bodyOf[b], chartMeasurements(bodyOf[b], size));
    same(strip(formLandmarks(g, { head: !!f.head }), ["slot_bounds"]), strip(f), 1e-9, f.name);
}
console.log(`ok - landmarks equal the script's for 10 sizes x head off/on, and forms.json's ${forms.length}`);

// Rest = script: the posed arm's dir at the Rest preset is forms.json's f-M dir
const fM = forms.find((f) => f.name === "f-M"), gM = grade("female", chartMeasurements("female", "M"));
const rest = formLandmarks(gM, { pose: REST });
for (const side of ["left", "right"]) same(rest.arms.find((a) => a.side === side).dir, fM.arms.find((a) => a.side === side).dir, 1e-12, `Rest ${side} dir`);
assert.ok(Math.abs(ARM_REST_FLEX - 4.574) < 1e-3, `φ0 ${ARM_REST_FLEX}`);
// the Rest hand's palm normal and width axis are the script's: n = unit(cross(d, z)) (left), unit(cross(z, d)) (right)
for (const side of ["left", "right"]) {
    const sk = armSkeleton(gM, side, REST[`${side}_arm`]), d = sk.df;
    const cr = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const n0 = sk.s > 0 ? cr(d, [0, 0, 1]) : cr([0, 0, 1], d), nl = Math.hypot(...n0), n = n0.map((v) => v / nl);
    const f = handSections(sk.parts[5])[0].frame;
    same(f.slice(6, 9), n, 1e-12, `${side} palm normal`);
    same(f.slice(9, 12), d, 1e-12, `${side} hand build direction`);
}
console.log("ok - Rest reproduces the script's arms and hands");

// pose turns: A-pose and T-pose dirs are the formula's; 45° apart
const dirFor = (s, a, p) => [s * Math.sin(a * RAD) * Math.cos(p * RAD), -Math.cos(a * RAD) * Math.cos(p * RAD), Math.sin(p * RAD)];
const angle = (u, v) => Math.acos(Math.min(1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2])) / RAD;
const lmA = formLandmarks(gM, { pose: PRESETS["A-pose"], legs: true }), lmT = formLandmarks(gM, { pose: PRESETS["T-pose"], legs: true });
for (const [i, s] of [[0, 1], [1, -1]]) {
    same(lmA.arms[i].dir, dirFor(s, 45, 0), 1e-9, "A-pose dir");
    same(lmT.arms[i].dir, dirFor(s, 90, 0), 1e-9, "T-pose dir");
    assert.ok(Math.abs(angle(lmA.arms[i].dir, lmT.arms[i].dir) - 45) < 1e-9);
}
const legPose = normalisePose({ left_leg: { abduction: 30, flexion: 60, knee: 0 }, right_leg: { abduction: 30, flexion: 60, knee: 0 } });
const lmL = formLandmarks(gM, { pose: legPose, legs: true });
for (const [i, s] of [[0, 1], [1, -1]]) {
    same(lmL.legs[i].dir, dirFor(s, 30, 60), 1e-9, "leg dir");
    assert.ok(Math.abs(angle(lmL.legs[i].dir, [0, -1, 0]) - Math.acos(Math.cos(30 * RAD) * Math.cos(60 * RAD)) / RAD) < 1e-9);
}
// the knee bends backward, the elbow forward
const bent = legSkeleton(gM, "left", { abduction: 0, flexion: 0, knee: 60 });
assert.ok(bent.ds[2] < 0 && Math.abs(angle(bent.ds, [0, -1, 0]) - 60) < 1e-9, "the shin swings back");
const elbow = armSkeleton(gM, "left", { abduction: 42, flexion: 0, elbow: 90 });
assert.ok(elbow.df[2] > 0.99, "the forearm swings forward");
assert.equal(lmA.pose.left_leg.abduction, 5);
assert.deepEqual(Object.keys(lmA.legs[0]), ["side", "hip", "dir", "radius"]);
assert.equal(lmA.file, null);
// segment frames are right-handed and square in any pose
for (const R of [limbRotation(1, 37, 120), limbRotation(-1, 170, -50)]) {
    const f = segmentFrame([1, 2, 3], R, 50), x = f.slice(3, 6), y = f.slice(6, 9), z = f.slice(9, 12);
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    assert.ok(Math.abs(dot(x, y)) < 1e-12 && Math.abs(dot(y, z)) < 1e-12 && Math.abs(dot(x, z)) < 1e-12);
    same(z, rot(R, [0, -1, 0]), 1e-15, "z down the limb");
}
console.log("ok - poses turn the arms and legs by the asked-for angles");

// limits: each one plus or minus 1°, and NaN; presets pass
for (const [name, p] of Object.entries(PRESETS)) assert.equal(validatePose(p), null, name);
assert.equal(validatePose(null), null);
const sideName = { left_arm: "left", right_arm: "right", left_leg: "left", right_leg: "right" };
let refused = 0;
for (const limb of Object.keys(sideName)) {
    const kind = limb.endsWith("arm") ? "arm" : "leg";
    for (const [joint, [lo, hi]] of Object.entries(LIMITS[kind])) {
        const what = joint === "abduction" ? `${kind === "arm" ? "shoulder" : "hip"} raise` : joint === "flexion" ? `${kind === "arm" ? "shoulder" : "hip"} swing` : joint;
        const msg = `${sideName[limb]} ${what} must be from ${lo} to ${hi}°`;
        for (const v of [lo - 1, hi + 1, NaN]) { assert.equal(validatePose({ [limb]: { [joint]: v } }), msg); refused++; }
        for (const v of [lo, hi]) assert.equal(validatePose({ [limb]: { [joint]: v } }), null);
    }
}
assert.equal(validatePose({ left_leg: { knee: 141 } }), "left knee must be from 0 to 140°");
console.log(`ok - joint limits (${refused} refusals)`);

// slot_bounds: f-M's within 5 mm of f-M.stp's box; one box for every pose
const k = await loadKernel();
const sc = k.open(new Uint8Array(readFileSync(new URL("../assets/f-M.stp", import.meta.url))), "step", undefined, "native");
const stpBox = sceneBox(sc.vertices(), sc.origin());
sc.free();
const sb = formLandmarks(gM, {}).slot_bounds;
sb.forEach((v, i) => assert.ok(Math.abs(v - stpBox[i]) < 5, `slot_bounds[${i}] ${v} vs f-M.stp ${stpBox[i]}`));
const gC = gradeForm("female", startFrom("female", "M"));
const boxes = ["Rest", "T-pose", "Sit-ish"].map((p) => formLandmarks(gC, { legs: true, pose: PRESETS[p] }).slot_bounds);
for (const b of boxes.slice(1)) assert.deepEqual(b, boxes[0], "slot_bounds does not move with the pose");
console.log(`ok - slot_bounds within ${Math.max(...sb.map((v, i) => Math.abs(v - stpBox[i]))).toFixed(2)} mm of f-M.stp, the same in every pose`);

// slots on the custom form: the front lands where it does on f-M.stp with forms.json's landmarks
const piece = { id: "front", kind: "garment.pattern" }, pb = [0, 0, 500, 700];
const shipped = slotFields(piece, "front", stpBox, pb, { landmarks: fM }).frame.origin;
const lmC = formLandmarks(gC, { legs: true, pose: REST });
const legsBox = [-700, 0, -160, 700, 1531, 260];     // a built box with legs and feet: slot_bounds stands in for it
const custom = slotFields(piece, "front", legsBox, pb, { landmarks: lmC }).frame.origin;
const off = Math.hypot(...custom.map((v, i) => v - shipped[i]));
assert.ok(off < 5, `front slot ${off} mm off`);
console.log(`ok - the front slot on the custom f-M is ${off.toFixed(2)} mm from f-M.stp's`);
