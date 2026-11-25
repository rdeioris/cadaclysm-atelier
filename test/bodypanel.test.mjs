// The Body panel (bodypanel.js): "Custom form…" in the Form picker, the measurement and pose
// fields, their validation, Start from and the presets, and the spec Build writes.
import assert from "node:assert/strict";
import { formOptions, draftFrom, bodyFields, poseFields, bodyCommit, validateBody, specOf, isBodyKey, CUSTOM } from "../bodypanel.js";
import { startFrom, chartMeasurements, RANGES } from "../form-grade.js";
import { PRESETS, LIMITS, normalisePose, validatePose } from "../form-pose.js";
import { fieldsFor } from "../props.js";

// the Form picker: the shipped forms first, then Custom
const forms = [{ name: "f-M", label: "f-M" }, { name: "f-M-head", label: "f-M with head" }];
assert.deepEqual(formOptions(forms), [{ value: "f-M", label: "f-M" }, { value: "f-M-head", label: "f-M with head" }, { value: CUSTOM, label: "Custom form…" }]);
assert.deepEqual(formOptions([]), [{ value: CUSTOM, label: "Custom form…" }]);

// an empty draft: chart f-M at Rest
const d0 = draftFrom();
assert.equal(d0.body, "female");
assert.deepEqual(d0.measurements, startFrom("female", "M"));
assert.equal(d0.measurements.height, 174.5, "Height is the stature: f-M's crown");
assert.equal(d0.head, false);
assert.equal(d0.preset, "Rest");
const bf = bodyFields(d0);
assert.deepEqual(bf.map((f) => f.key), ["body", "start", "bust", "waist", "hip", "neck", "shoulder", "height", "head", "build"]);
assert.ok(bf.filter((f) => f.unit === "cm").every((f) => f.type === "number" && f.tip.includes(`${RANGES[f.key][0]} to ${RANGES[f.key][1]} cm`)));
assert.equal(bf.find((f) => f.key === "build").type, "action");
const pf = poseFields(d0);
assert.equal(pf.length, 14);
assert.deepEqual(pf.slice(1, 7).map((f) => f.label), ["Left shoulder raise", "Left shoulder swing", "Left elbow", "Right shoulder raise", "Right shoulder swing", "Right elbow"]);
assert.deepEqual(pf.slice(7, 13).map((f) => f.label), ["Left hip raise", "Left hip swing", "Left knee", "Right hip raise", "Right hip swing", "Right knee"]);
assert.ok(pf.slice(1, 13).every((f) => f.unit === "°" && /\d+° to \d+°/.test(f.tip)));
assert.equal(pf.find((f) => f.key === "left_leg.knee").tip.includes("0° to 140°"), true);
assert.equal(pf[0].value, "Rest");
assert.ok([...bf, ...pf].every((f) => f.key === "measured" || isBodyKey(f.key)), "every panel key is the panel's");
assert.ok(!["name", "form", "bounds", "load"].some(isBodyKey), "the avatar's own keys are not");
console.log("ok - Form options and the empty draft's fields");

// Start from: the chart's measurements, height as the stature; body switch keeps the numbers
let r = bodyCommit(d0, "start", "XL");
assert.deepEqual(r.draft.measurements, startFrom("female", "XL"));
assert.equal(r.error, undefined);
r = bodyCommit(r.draft, "body", "male");
assert.equal(r.draft.body, "male");
r = bodyCommit(r.draft, "start", "M");
assert.deepEqual(r.draft.measurements, startFrom("male", "M"));
assert.equal(r.draft.measurements.bust, chartMeasurements("male", "M").bust);
assert.equal(bodyCommit(d0, "start", "XXL").error, "no size XXL");
console.log("ok - Start from fills the chart size");

// each measurement's validation message, the draft kept
for (const [k, [lo, hi]] of Object.entries(RANGES)) {
    const msg = `${k} must be from ${lo} to ${hi} cm`;
    for (const raw of [String(lo - 1), String(hi + 1), "", "abc"]) {
        const x = bodyCommit(d0, k, raw);
        assert.equal(x.error, msg, `${k} ${raw}`);
        assert.equal(x.draft, d0, "the draft is kept");
    }
    assert.equal(validateBody(k, lo), null);
    const ok = bodyCommit(d0, k, String(hi));
    assert.equal(ok.draft.measurements[k], hi);
}
assert.equal(bodyCommit(d0, "head", "true").draft.head, true);
console.log("ok - measurement validation");

// pose: a preset fills exactly the 12 angles; an angle out of range is refused with its message
for (const [name, p] of Object.entries(PRESETS)) {
    assert.equal(validatePose(p), null, name);
    const x = bodyCommit(d0, "preset", name);
    assert.deepEqual(x.draft.pose, normalisePose(p));
    assert.equal(x.draft.preset, name);
    const angles = poseFields(x.draft).filter((f) => f.unit === "°");
    assert.equal(angles.length, 12);
    for (const f of angles) { const [limb, joint] = f.key.split("."); assert.ok(Math.abs(f.value - normalisePose(p)[limb][joint]) < 1e-3, f.key); }
}
let p = bodyCommit(d0, "preset", "A-pose").draft;
p = bodyCommit(p, "left_leg.knee", "60").draft;
assert.equal(p.pose.left_leg.knee, 60);
assert.equal(p.preset, "", "an edited angle is no preset");
assert.equal(bodyCommit(p, "left_leg.knee", "141").error, "left knee must be from 0 to 140°");
assert.equal(bodyCommit(p, "right_arm.abduction", "9").error, "right shoulder raise must be from 10 to 170°");
assert.equal(bodyCommit(p, "left_leg.flexion", "").error, "left hip swing must be from -20 to 120°");
assert.equal(bodyCommit(p, "left_leg.knee", "141").draft, p);
for (const [kind, joints] of Object.entries(LIMITS)) for (const [joint, [lo, hi]] of Object.entries(joints)) {
    assert.ok(validateBody(`left_${kind}.${joint}`, lo - 1));
    assert.equal(validateBody(`left_${kind}.${joint}`, hi), null);
}
console.log("ok - presets and joint limits");

// Build / Apply: the spec the document saves
const built = bodyCommit(p, "build", "");
assert.equal(built.error, undefined);
assert.deepEqual(built.build, specOf(p));
assert.deepEqual(Object.keys(built.build), ["v", "body", "measurements", "head", "pose"]);
assert.equal(built.build.v, 1);
assert.equal(built.build.pose.left_leg.knee, 60);
assert.deepEqual(bodyCommit(p, "apply", "").build, built.build);
assert.deepEqual(draftFrom(built.build).pose, p.pose, "a saved spec gives the draft back");
const badDraft = { ...p, measurements: { ...p.measurements, bust: 10 } };
assert.equal(bodyCommit(badDraft, "build", "").error, "bust must be from 60 to 160 cm");
console.log("ok - Build writes the normalised spec");

// the read-outs: the built form's measured girths beside the asked-for ones, and its crown
const avatar = {
    name: "custom form", bounds: [0, 0, 0, 1, 1, 1], forms, draft: p,
    landmarks: { form: built.build, crown: 1745, girths: { bust: { asked: 92, measured: 91.62 }, waist: { asked: 74, measured: 73.4 }, hip: { asked: 100, measured: 99.8 } } },
};
const ro = bodyFields(p, avatar).filter((f) => f.measured);
assert.deepEqual(ro.map((f) => f.value), ["91.6 cm (asked 92.0)", "73.4 cm (asked 74.0)", "99.8 cm (asked 100.0)", "174.5 cm"]);
// props.js: the Form select shows Custom, then the Body and Pose fields follow Size
const all = fieldsFor({ kind: "avatar", id: "avatar" }, [], new Map(), avatar);
assert.equal(all.find((f) => f.key === "form").value, CUSTOM);
assert.deepEqual(all.slice(0, 4).map((f) => f.key), ["name", "form", "bounds", "body"]);
assert.equal(all.length, 4 + 10 + 4 + 14, "name, form, size, load + body + read-outs + pose");
const plain = fieldsFor({ kind: "avatar", id: "avatar" }, [], new Map(), { name: "f-M", bounds: [0, 0, 0, 1, 1, 1], forms, landmarks: null });
assert.deepEqual(plain.map((f) => f.key), ["name", "form", "bounds", "load"], "a shipped form: no Body panel");
console.log("ok - read-outs and the props.js hook");
