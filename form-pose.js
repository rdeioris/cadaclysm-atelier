// Dress-form poses and proportions: rotations, the limb skeleton, joint limits, presets and the
// landmarks the slots read. Pure (no kernel). dressform.js builds the solids from what this says.
//
// A limb hangs from its joint; its rotation is R(α, φ) = Rz(s·α) · Rx(−φ) about the joint, with
// s = +1 the left (+x; the form faces +z) and −1 the right. Read intrinsically: abduct about the
// body's forward axis, then flex about the segment's own (abducted) x axis. Its direction is
// d = R·(0, −1, 0) = (s·cosφ·sinα, −cosφ·cosα, sinφ): α swings the limb out to its side, φ forward.
import { gradeForm, grade, HEAD, BUST, SHOULDER } from "./form-grade.js";

const RAD = Math.PI / 180;

/** R(α, φ) for side s, degrees in, as a row-major 3×3 (9 numbers). */
export function limbRotation(s, alphaDeg, phiDeg) {
    const b = s * alphaDeg * RAD, t = -phiDeg * RAD;
    const cb = Math.cos(b), sb = Math.sin(b), ct = Math.cos(t), st = Math.sin(t);
    // Rz(b) · Rx(t): Rx(t) = [[1,0,0],[0,ct,-st],[0,st,ct]], Rz(b) = [[cb,-sb,0],[sb,cb,0],[0,0,1]]
    return [cb, -sb * ct, sb * st,
        sb, cb * ct, -cb * st,
        0, st, ct];
}
export const rot = (R, v) => [
    R[0] * v[0] + R[1] * v[1] + R[2] * v[2],
    R[3] * v[0] + R[4] * v[1] + R[5] * v[2],
    R[6] * v[0] + R[7] * v[1] + R[8] * v[2],
];
export const add = (p, q) => [p[0] + q[0], p[1] + q[1], p[2] + q[2]];
export const scale = (p, s) => [p[0] * s, p[1] * s, p[2] * s];
/** The limb's direction for the angles (degrees): (s·cosφ·sinα, −cosφ·cosα, sinφ). */
export const limbDir = (s, a, f) => rot(limbRotation(s, a, f), [0, -1, 0]);

// The canonical limb frame: x = (1, 0, 0), y = (0, 0, 1), z = (0, −1, 0) (down the limb).
const LX = [1, 0, 0], LY = [0, 0, 1], LZ = [0, -1, 0];
/** The 12-number frame `t` mm down a segment from joint J under rotation R. */
export function segmentFrame(J, R, t) {
    return [...add(J, rot(R, [0, -t, 0])), ...rot(R, LX), ...rot(R, LY), ...rot(R, LZ)];
}

// ---- joints, limits and presets (estimated: a generous adult range, not measured) ----
// The script's rest arm is a pose: abducted 42°, flexed φ0 so d = unit([s·sin42°, −cos42°, 0.08]).
export const ARM_REST_FLEX = Math.asin(0.08 / Math.sqrt(Math.sin(42 * RAD) ** 2 + Math.cos(42 * RAD) ** 2 + 0.08 ** 2)) / RAD;
export const LIMITS = {   // degrees (estimated)
    arm: { abduction: [10, 170], flexion: [-50, 170], elbow: [0, 145] },
    leg: { abduction: [0, 45], flexion: [-20, 120], knee: [0, 140] },
};
const JOINT_NAME = { abduction: "raise", flexion: "swing", elbow: "elbow", knee: "knee" };
const LIMBS = [["left_arm", "arm", "left"], ["right_arm", "arm", "right"], ["left_leg", "leg", "left"], ["right_leg", "leg", "right"]];

const arms = (a, f, e) => ({ abduction: a, flexion: f, elbow: e });
const legs = (a, f, k) => ({ abduction: a, flexion: f, knee: k });
const both = (arm, leg) => ({ left_arm: arm, right_arm: { ...arm }, left_leg: leg, right_leg: { ...leg } });
export const PRESETS = {   // (estimated)
    Rest: both(arms(42, ARM_REST_FLEX, 0), legs(0, 0, 0)),
    "A-pose": both(arms(45, 0, 0), legs(5, 0, 0)),
    "T-pose": both(arms(90, 0, 0), legs(0, 0, 0)),
    Walk: { left_arm: arms(15, -20, 15), right_arm: arms(15, 20, 25), left_leg: legs(0, 20, 10), right_leg: legs(0, -15, 20) },
    "Sit-ish": both(arms(25, 25, 40), legs(8, 85, 85)),
};
export const REST = PRESETS.Rest;

/** The pose with every limb's angles present (Rest where missing); null is Rest. */
export function normalisePose(p) {
    const out = {};
    for (const [limb] of LIMBS) out[limb] = { ...REST[limb], ...(p?.[limb] ?? {}) };
    return out;
}

/** A message such as "left knee must be from 0 to 140°", or null. */
export function validatePose(p) {
    if (p == null) return null;
    const n = normalisePose(p);
    for (const [limb, kind, side] of LIMBS) for (const [joint, [lo, hi]] of Object.entries(LIMITS[kind])) {
        const v = n[limb][joint];
        if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) {
            const what = joint === "abduction" || joint === "flexion" ? `${kind === "arm" ? "shoulder" : "hip"} ${JOINT_NAME[joint]}` : JOINT_NAME[joint];
            return `${side} ${what} must be from ${lo} to ${hi}°`;
        }
    }
    return null;
}

// ---- the skeleton: where the parts go ----
const sideOf = (side) => (side === "left" ? 1 : -1);

/** The arm's parts for grade g and angles {abduction, flexion, elbow}: the script's arm(). */
export function armSkeleton(g, side, angles) {
    const s = sideOf(side), m = g.mRef;
    const t = Math.sqrt(g.f[BUST] / m.f[BUST]), L = g.h;
    const shX = (g.body === "female" ? 182 : 196) * g.f[SHOULDER] / m.f[SHOULDER];
    const Ru = limbRotation(s, angles.abduction, angles.flexion);
    const Rf = limbRotation(s, angles.abduction, angles.flexion + angles.elbow);
    const du = rot(Ru, [0, -1, 0]), df = rot(Rf, [0, -1, 0]);
    const sh = [s * shX, g.y(1352), -8];
    const el = add(sh, scale(du, 280 * L)), wr = add(el, scale(df, 245 * L));
    return {
        s, t, L, sh, el, wr, du, df, Ru, Rf, radius: 50 * t,
        parts: [
            { name: "shoulder", kind: "ball", c: sh, r: 50 * t },
            { name: "upper arm", kind: "frustum", J: sh, R: Ru, t0: 40 * t, t1: 280 * L - 30 * t, r0: 44 * t, r1: 35 * t },
            { name: "elbow", kind: "ball", c: el, r: 38 * t },
            { name: "forearm", kind: "frustum", J: el, R: Rf, t0: 30 * t, t1: 245 * L - 22 * t, r0: 33 * t, r1: 26 * t },
            { name: "wrist", kind: "ball", c: wr, r: 28 * t },
            { name: "hand", kind: "hand", w0: add(wr, scale(df, 18 * t)), R: Rf, s, L, t },
        ],
    };
}

/** The mitten's 5 sections (the script's hand()): [{frame (12), a, b}], palm toward the body. */
export function handSections(part) {
    const { w0, R, s, L, t } = part;
    const d = rot(R, [0, -1, 0]), n = rot(R, [-s, 0, 0]), wdir = rot(R, [0, 0, s]);
    return [[0, 26, 18], [40, 40, 17], [95, 42, 14], [150, 34, 11], [175, 18, 8]].map(([u, hw, ht]) => ({
        frame: [...add(w0, scale(d, u * L)), ...wdir, ...n, ...d], a: hw * t, b: ht * t,
    }));
}

// Legs (new; proportions estimated): they scale with k = f.hip / M's (girth) and h (height).
export function legSkeleton(g, side, angles) {
    const s = sideOf(side), m = g.mRef, h = g.h;
    const k = g.f.hip / m.f.hip;
    const H = [s * 84 * k, g.y(770), -6];
    const drop = H[1] - 72 * h, Lt = 0.52 * drop, Ls = 0.48 * drop;
    const Rt = limbRotation(s, angles.abduction, angles.flexion);
    const Rs = limbRotation(s, angles.abduction, angles.flexion - angles.knee);
    const dt = rot(Rt, [0, -1, 0]), ds = rot(Rs, [0, -1, 0]);
    const K = add(H, scale(dt, Lt)), A = add(K, scale(ds, Ls));
    const footLen = (g.body === "female" ? 240 : 265) * h;
    // the foot block: rest frame at floor level 60h ahead of the ankle, axes as up_frame, built
    // 60h up; posed rigidly with the shin about the ankle
    const off = rot(Rs, [0, -72 * h, 60 * h]);
    const foot = { name: "foot", kind: "block", w: 90 * k, l: footLen, height: 60 * h,
        frame: [...add(A, off), ...rot(Rs, [1, 0, 0]), ...rot(Rs, [0, 0, -1]), ...rot(Rs, [0, 1, 0])] };
    return {
        s, k, H, K, A, dt, ds, Rt, Rs, radius: 88 * k, Lt, Ls,
        parts: [
            { name: "hip", kind: "ball", c: H, r: 88 * k },
            { name: "thigh", kind: "frustum", J: H, R: Rt, t0: 40 * k, t1: Lt - 30 * k, r0: 80 * k, r1: 50 * k },
            { name: "knee", kind: "ball", c: K, r: 54 * k },
            { name: "shin", kind: "frustum", J: K, R: Rs, t0: 30 * k, t1: Ls - 22 * k, r0: 48 * k, r1: 32 * k },
            { name: "ankle", kind: "ball", c: A, r: 34 * k },
            foot,
        ],
    };
}

/** The script's thigh() stubs (legs off): 4 elliptic sections [{frame, a, b}]. */
export function thighStubSections(g, side) {
    const s = sideOf(side), k = g.f.hip / g.mRef.f.hip;
    return [[640, 74, 96], [720, 86, 92], [800, 96, 86], [860, 92, 78]].map(([y, r, x]) => ({
        frame: upFrame(s * x * k, g.y(y), -6), a: r * k, b: r * k * 0.96,
    }));
}

/** A horizontal section plane at height y: profile x along world X, profile y along −Z, built along +Y. */
export const upFrame = (x, y, z) => [x, y, z, 1, 0, 0, 0, 0, -1, 0, 1, 0];

/** The head's sections [{frame, a, b}] and its scale: the script's head() and head_scale(). */
export function headSections(g) {
    const y0 = g.sections[g.sections.length - 1][0];
    const hy = g.h, k = Math.sqrt(g.f.neck / g.mRef.f.neck);
    return { hy, k, y0, sections: HEAD.map(([dy, a, b, zc]) => ({ frame: upFrame(0, y0 + dy * hy, zc * k), a: a * k, b: b * k })) };
}

// ---- landmarks ----
const r4 = (v) => Number(v.toFixed(4));
const STAND = [-150, 0, -156, 150, 12, 144];   // the shipped forms' stand footprint (their bounds include it)

/**
 * The forms.json entry for a grade g (tools/dressform.py's landmarks()), plus `legs`, `pose`,
 * `file: null` and `slot_bounds` (a pose-independent box the slot fractions scale with).
 */
export function formLandmarks(g, { name = null, label = null, head = false, legs = false, pose = null } = {}) {
    const y0 = g.sections[g.sections.length - 1][0];
    const p = pose == null ? null : normalisePose(pose);
    const armsOut = [], restArms = [];
    for (const side of ["left", "right"]) {
        const sk = armSkeleton(g, side, p ? p[`${side}_arm`] : REST[`${side}_arm`]);
        // the script's dir unposed: unit([s·sin42°, −cos42°, 0.08]); posed, the upper arm's d
        const dir = p ? sk.du : unitV([sk.s * Math.sin(42 * RAD), -Math.cos(42 * RAD), 0.08]);
        armsOut.push({ side, shoulder: sk.sh.map(r4), dir, radius: r4(sk.radius) });
        restArms.push(p ? armSkeleton(g, side, REST[`${side}_arm`]) : sk);
    }
    const out = { name, label, file: null, body_top: r4(y0 + 51), hps_y: r4(g.sections[11][0]), arms: armsOut };
    if (head) {
        const { hy, k } = headSections(g);
        const top = y0 + HEAD[HEAD.length - 1][0] * hy, chin = y0 + HEAD[2][0] * hy;
        out.head = {
            centre: [0, r4(y0 + HEAD[4][0] * hy), r4(HEAD[4][3] * k)],
            half: [r4(HEAD[4][1] * k), r4((top - chin) / 2), r4(HEAD[4][2] * k)],
            top: r4(top), chin_y: r4(chin),
        };
    }
    if (legs) out.legs = ["left", "right"].map((side) => {
        const sk = legSkeleton(g, side, p ? p[`${side}_leg`] : REST[`${side}_leg`]);
        return { side, hip: sk.H.map(r4), dir: sk.dt, radius: r4(sk.radius) };
    });
    if (p || legs) out.pose = p ?? normalisePose(null);
    out.slot_bounds = slotBounds(g, restArms);
    return out;
}

const unitV = (v) => scale(v, 1 / Math.hypot(...v));

/** The torso sections' ellipse boxes up to the neck knob's top, the Rest arms' joint balls and their
 * mitten sections, and the stand footprint: the same for every pose. */
export function slotBounds(g, restArms) {
    const b = [...STAND];
    const grow = (c, r) => { for (let i = 0; i < 3; i++) { b[i] = Math.min(b[i], c[i] - r); b[i + 3] = Math.max(b[i + 3], c[i] + r); } };
    for (const [y, a, bb, zc] of g.sections) {
        b[0] = Math.min(b[0], -a); b[3] = Math.max(b[3], a);
        b[1] = Math.min(b[1], y); b[4] = Math.max(b[4], y);
        b[2] = Math.min(b[2], zc - bb); b[5] = Math.max(b[5], zc + bb);
    }
    b[4] = Math.max(b[4], g.sections[g.sections.length - 1][0] + 51);   // the neck knob's top (body_top)
    for (const sk of restArms) {
        grow(sk.sh, 50 * sk.t); grow(sk.el, 38 * sk.t); grow(sk.wr, 28 * sk.t);
        for (const { frame: f, a, b: hb } of handSections(sk.parts[5]))   // the mitten's sections' ellipse boxes
            for (let i = 0; i < 3; i++) {
                const e = Math.hypot(a * f[3 + i], hb * f[6 + i]);
                b[i] = Math.min(b[i], f[i] - e); b[i + 3] = Math.max(b[i + 3], f[i] + e);
            }
    }
    return b;
}

/** The grade a form spec asks for: {body, measurements (height = stature, cm)}. */
export const gradeOf = (spec) => gradeForm(spec.body, spec.measurements);
export { grade };
