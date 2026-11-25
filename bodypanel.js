// The Body panel: "Custom form…" in the Form picker, the measurements and the pose of a dress
// form built from them (dressform.js), as props.js field descriptors (fieldRow draws them
// unchanged). Pure (no DOM, no kernel), so Node tests it. The page keeps one draft while the
// panel is open; Build and Apply write it to the document (meta atelier.form), and the worker
// builds what the document says.
import { SIZES, startFrom, RANGES, validateMeasurements } from "./form-grade.js";
import { PRESETS, LIMITS, REST, normalisePose, validatePose } from "./form-pose.js";
import { normaliseSpec } from "./dressform.js";

export const CUSTOM = "custom";
const MEASURES = [["bust", "Bust"], ["waist", "Waist"], ["hip", "Hip"], ["neck", "Neck"], ["shoulder", "Shoulder"], ["height", "Height"]];
const TIPS = {
    bust: "Girth round the fullest part of the chest.",
    waist: "Girth at the natural waist. The form's waist goes a little deeper as it grows (the belly rule), so its girth can read up to 1.5 % off.",
    hip: "Girth round the fullest part of the hips.",
    neck: "Girth at the base of the neck.",
    shoulder: "Across the back, shoulder point to shoulder point.",
    height: "Stature: floor to crown. The form stands on the floor; without a head, the crown is where the head would reach.",
};
const LIMB_LABELS = [["left_arm", "Left", "arm"], ["right_arm", "Right", "arm"], ["left_leg", "Left", "leg"], ["right_leg", "Right", "leg"]];
const JOINTS = {
    arm: [["abduction", "shoulder raise"], ["flexion", "shoulder swing"], ["elbow", "elbow"]],
    leg: [["abduction", "hip raise"], ["flexion", "hip swing"], ["knee", "knee"]],
};
const JOINT_TIPS = {
    abduction: "Out to the side from hanging straight down (0°).",
    flexion: "Forward (+) or back (−) from hanging straight down.",
    elbow: "Bend at the elbow: the forearm folds forward.",
    knee: "Bend at the knee: the shin folds back.",
};

/** The Form picker's options: the shipped forms first, then "Custom form…". */
export function formOptions(forms) {
    return [...(forms ?? []).map((f) => ({ value: f.name, label: f.label ?? f.name })), { value: CUSTOM, label: "Custom form…" }];
}

/** A draft from a saved spec (the built form's), or chart f-M at Rest. */
export function draftFrom(spec = null) {
    if (spec) { const s = normaliseSpec(spec); return { body: s.body, measurements: { ...s.measurements }, head: s.head, pose: s.pose, preset: presetOf(s.pose) }; }
    return { body: "female", measurements: startFrom("female", "M"), head: false, pose: normalisePose(null), preset: "Rest" };
}
/** The spec Build and Apply write (dressform.js normaliseSpec). */
export const specOf = (draft) => normaliseSpec(draft);

function presetOf(pose) {
    const key = JSON.stringify(normalisePose(pose));
    return Object.keys(PRESETS).find((p) => JSON.stringify(normalisePose(PRESETS[p])) === key) ?? "";
}

const cm = (v) => `${v.toFixed(1)} cm`;

/**
 * The Body section's fields: body, Start from, the six measurements (cm), head, Build, then the
 * built form's read-outs: each girth asked for and measured on the form, and its crown.
 */
export function bodyFields(draft, avatar = null) {
    const yesNo = [{ value: "false", label: "no" }, { value: "true", label: "yes" }];
    const out = [
        { key: "body", label: "Body", unit: "", type: "select", value: draft.body, options: [{ value: "female", label: "female" }, { value: "male", label: "male" }] },
        { key: "start", label: "Start from", unit: "", type: "select", value: "", options: SIZES.map((s) => ({ value: s, label: s })),
            tip: "Fill the measurements from the chart size (the shipped forms' chart)." },
        ...MEASURES.map(([key, label]) => ({ key, label, unit: "cm", type: "number", value: draft.measurements[key], tip: `${TIPS[key]} ${RANGES[key][0]} to ${RANGES[key][1]} cm.` })),
        { key: "head", label: "Head", unit: "", type: "select", value: draft.head ? "true" : "false", options: yesNo },
        { key: "build", label: "Build form", unit: "", type: "action", value: null },
    ];
    const g = avatar?.landmarks?.form ? avatar.landmarks.girths : null;
    if (g) for (const [key, label] of MEASURES.slice(0, 3)) {
        if (!g[key]) continue;
        out.push({ key: `measured_${key}`, label: `${label} on form`, unit: "", type: "readonly", value: `${cm(g[key].measured)} (asked ${g[key].asked.toFixed(1)})`, measured: true });
    }
    if (avatar?.landmarks?.form && Number.isFinite(avatar.landmarks.crown)) out.push({ key: "crown", label: "Crown", unit: "", type: "readonly", value: cm(avatar.landmarks.crown / 10), measured: true });
    return out;
}

/** The Pose section's fields: a preset, the 12 angles (degrees), and Apply. */
export function poseFields(draft) {
    const out = [{ key: "preset", label: "Pose", unit: "", type: "select", value: draft.preset ?? "", options: Object.keys(PRESETS).map((p) => ({ value: p, label: p })),
        tip: "Fill the angles from a preset; Apply builds the form in the pose." }];
    for (const [limb, side, kind] of LIMB_LABELS) for (const [joint, name] of JOINTS[kind]) {
        const [lo, hi] = LIMITS[kind][joint];
        out.push({ key: `${limb}.${joint}`, label: `${side} ${name}`, unit: "°", type: "number", value: round3(draft.pose[limb][joint]),
            tip: `${JOINT_TIPS[joint]} ${lo}° to ${hi}° (estimated limits).` });
    }
    out.push({ key: "apply", label: "Apply pose", unit: "", type: "action", value: null });
    return out;
}
const round3 = (v) => Math.round(v * 1000) / 1000;

/** True for a key the Body panel owns (the avatar's other fields are name, form, bounds, load). */
export const isBodyKey = (key) => ["body", "start", "head", "build", "preset", "apply"].includes(key) || MEASURES.some(([k]) => k === key) || key.includes(".");

/** A message when `value` cannot go into field `key`, else null. */
export function validateBody(key, value) {
    if (RANGES[key]) return validateMeasurements({ ...startFrom("female", "M"), [key]: value });
    if (key.includes(".")) {
        const [limb, joint] = key.split(".");
        return validatePose({ [limb]: { [joint]: value } });
    }
    return null;
}

/**
 * A Body-panel edit: key, the text the field held. -> {draft, error, build}: the new draft (the
 * old one on an error), the message to show, and the spec to write when Build or Apply was hit.
 */
export function bodyCommit(draft, key, raw) {
    const d = { ...draft, measurements: { ...draft.measurements }, pose: normalisePose(draft.pose) };
    const num = () => (String(raw).trim() === "" ? NaN : Number(raw));
    if (key === "body") { if (raw !== "female" && raw !== "male") return { draft, error: `no body ${raw}` }; d.body = raw; return { draft: d }; }
    if (key === "start") {
        if (!SIZES.includes(raw)) return { draft, error: `no size ${raw}` };
        d.measurements = startFrom(d.body, raw);
        return { draft: d };
    }
    if (key === "head") { d.head = raw === true || raw === "true"; return { draft: d }; }
    if (key === "preset") {
        if (!PRESETS[raw]) return { draft, error: `no pose ${raw}` };
        d.pose = normalisePose(PRESETS[raw]); d.preset = raw;
        return { draft: d };
    }
    if (RANGES[key]) {
        const v = num(), error = validateBody(key, v);
        if (error) return { draft, error };
        d.measurements[key] = v;
        return { draft: d };
    }
    if (key.includes(".")) {
        const [limb, joint] = key.split(".");
        if (!d.pose[limb] || !(joint in d.pose[limb])) return { draft, error: `no joint ${key}` };
        const v = num(), error = validateBody(key, v);
        if (error) return { draft, error };
        d.pose[limb] = { ...d.pose[limb], [joint]: v };
        d.preset = presetOf(d.pose);
        return { draft: d };
    }
    if (key === "build" || key === "apply") {
        const error = validateMeasurements(d.measurements) ?? validatePose(d.pose);
        if (error) return { draft, error };
        return { draft: d, build: specOf(d) };
    }
    return { draft, error: `nothing to edit for ${key}` };
}

export { REST };
