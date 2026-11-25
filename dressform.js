// Dress forms built from measurements with the wasm blacksmith kernel: a port of
// tools/dressform.py's geometry (torso loft, neck cap or head, frustum-and-ball arms), plus full
// legs and poses (form-pose.js says where every part goes). Takes the kernel module `k`, as
// Atelier(k) does. Every handle made here is freed here, a throw included.
import { gradeForm, girths as gradeGirths, validateMeasurements } from "./form-grade.js";
import {
    armSkeleton, legSkeleton, handSections, thighStubSections, headSections, upFrame, segmentFrame,
    normalisePose, validatePose, formLandmarks,
} from "./form-pose.js";

export const JOIN_TOL = 0.05;     // the script's (Python's) join tolerance
// mm. The script meshes at 0.4. mesh64 gives a ball 960 triangles at any tolerance and the torso
// 10-16 thousand, so none comes near the shipped f-M's 13960 (the app's STEP mesher): a custom
// f-M with legs is 58112 at 0.4 mm, 36656 at 1 mm, 31560 at 2 mm.
export const MESH_TOL = 1;
export const JOINS = "none";      // see buildForm

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** The kernel calls the builder makes, bound: f.loft_through(...) and so on. */
function calls(k) {
    const f = (n) => {
        const fn = k[`cadaclysm_blacksmith_${n}`];
        if (typeof fn !== "function") throw new Error(`this package lacks ${n}: npm run setup -- --pkg <a cadaclysm master build>`);
        return fn;
    };
    return {
        ellipse: f("profile_ellipse"), circle: f("profile_circle"), rect: f("profile_rect"), pfree: f("profile_free"),
        loftThrough: f("loft_through"), loft: f("loft"), extrude: f("extrude"), sphere: f("sphere"),
        translate: f("translate"), join: f("join"), mesh64: f("mesh64"), sfree: f("solid_free"),
    };
}

// ---- primitives: each returns one solid handle and frees what it made on the way ----

function loftSections(K, sections) {
    const profiles = [];
    try {
        for (const s of sections) profiles.push(K.ellipse(0, 0, s.a, s.b));
        return K.loftThrough(Uint32Array.from(profiles), Float64Array.from(sections.flatMap((s) => s.frame)));
    } finally { for (const p of profiles) K.pfree(p); }
}

function ball(K, c, r) {
    const s = K.sphere(r);
    try { return K.translate(s, c[0], c[1], c[2]); } finally { K.sfree(s); }
}

function frustum(K, p) {
    let a = 0, b = 0;
    try {
        a = K.circle(p.r0); b = K.circle(p.r1);
        return K.loft(a, Float64Array.from(segmentFrame(p.J, p.R, p.t0)), b, Float64Array.from(segmentFrame(p.J, p.R, p.t1)));
    } finally { if (a) K.pfree(a); if (b) K.pfree(b); }
}

function extrudeProfile(K, profile, frame, height) {
    try { return K.extrude(profile, Float64Array.from(frame), height); } finally { K.pfree(profile); }
}

function makePart(K, p) {
    switch (p.kind) {
        case "ball": return ball(K, p.c, p.r);
        case "frustum": return frustum(K, p);
        case "hand": return loftSections(K, handSections(p));
        case "block": return extrudeProfile(K, K.rect(p.w, p.l), p.frame, p.height);
        case "loft": return loftSections(K, p.sections);
        case "extrude": return extrudeProfile(K, K.circle(p.r), p.frame, p.height);
        default: throw new Error(`no part kind ${p.kind}`);
    }
}

/**
 * Make `parts` ([{name, kind, ...}]) and fold them with join. On the first refused join the rest
 * stay separate solids (the script's --separate-arms, automatic). With `join` false every part is
 * its own closed solid and nothing is refused. -> [{name, solid, parts}] (the
 * joined solid first), and `separate`: the names of the parts left on their own.
 */
function foldParts(K, label, parts, join = true) {
    const made = [];
    let out = 0;
    try {
        for (const p of parts) made.push({ name: p.name, h: makePart(K, p) });
        out = made[0].h; made[0].h = 0;
        const joined = [made[0].name];
        let i = 1;
        for (; join && i < made.length; i++) {
            let j;
            try { j = K.join(out, made[i].h, JOIN_TOL, null); } catch { break; }
            K.sfree(out); K.sfree(made[i].h); made[i].h = 0;
            out = j; joined.push(made[i].name);
        }
        const result = [{ name: label, solid: out, parts: joined }];
        out = 0;
        for (; i < made.length; i++) { result.push({ name: `${label}/${made[i].name}`, solid: made[i].h, parts: [made[i].name] }); made[i].h = 0; }
        return { solids: result, separate: join ? result.slice(1).map((r) => r.parts[0]) : [] };
    } finally {
        if (out) K.sfree(out);
        for (const m of made) if (m.h) K.sfree(m.h);
    }
}

// ---- the body and the limbs ----

/** The body's parts for grade g: torso, then hip balls (legs) or the script's thigh stubs, then the
 * neck cap (cap, stem, knob) or the neck ring and the head. No stand. */
export function bodyParts(g, { head = false, legs = true } = {}) {
    const parts = [{ name: "torso", kind: "loft", sections: g.sections.map(([y, a, b, zc]) => ({ frame: upFrame(0, y, zc), a, b })) }];
    for (const side of ["left", "right"]) {
        if (legs) { const sk = legSkeleton(g, side, { abduction: 0, flexion: 0, knee: 0 }); parts.push({ ...sk.parts[0], name: `${side} hip` }); }
        else parts.push({ name: `${side} thigh`, kind: "loft", sections: thighStubSections(g, side) });
    }
    const [y, a] = g.sections[g.sections.length - 1];
    parts.push({ name: "neck ring", kind: "extrude", r: a + 4, frame: upFrame(0, y - 1, -4), height: 9 });
    if (head) parts.push({ name: "head", kind: "loft", sections: headSections(g).sections });
    else parts.push({ name: "neck stem", kind: "extrude", r: 9, frame: upFrame(0, y + 7, -4), height: 24 },
        { name: "neck knob", kind: "ball", c: [0, y + 36, -4], r: 15 });
    return parts;
}

/** -> {solids: [{name, solid, parts}], separate: [part names]} */
export function buildBody(k, g, opts = {}) {
    return foldParts(calls(k), "body", bodyParts(g, opts), opts.joins !== "none");
}

/** kind "arm" or "leg"; angles {abduction, flexion, elbow | knee}. */
export function limbParts(g, side, kind, angles) {
    return kind === "arm" ? armSkeleton(g, side, angles).parts : legSkeleton(g, side, angles).parts;
}
export function buildLimb(k, g, side, kind, angles, { joins = "all" } = {}) {
    return foldParts(calls(k), `${side}_${kind}`, limbParts(g, side, kind, angles), joins === "all");
}

/** Each solid meshed (mesh64) and freed: [{name, positions: Float64Array, normals, indices}]. */
export function meshParts(k, solids, tol = MESH_TOL) {
    const K = calls(k), out = [];
    let i = 0;
    try {
        for (; i < solids.length; i++) {
            const s = solids[i], m = K.mesh64(s.solid, tol);
            out.push({ name: s.name, positions: Float64Array.from(m.positions), normals: Float64Array.from(m.normals), indices: Uint32Array.from(m.indices) });
            K.sfree(s.solid);
        }
    } finally { for (; i < solids.length; i++) K.sfree(solids[i].solid); }
    return out;
}

/** Free solids not meshed (a build that throws part-way). */
export function freeSolids(k, solids) { const K = calls(k); for (const s of solids) K.sfree(s.solid); }

/**
 * Build a form: spec = {body, measurements (cm; height = stature), head, legs = true, pose = null,
 * tol, joins}. -> {parts: meshes, landmarks, girths (cm, the graded sections'), timings (ms),
 * separate: {stage: [parts a refused join left on their own]}}.
 *
 * joins: "none" (the default) leaves every part its own closed solid: the collider is the union
 * of the meshes either way, and a join costs seconds (2-13 s each in wasm, about 23 of them: a
 * joined f-M takes minutes, as the script's 77 s natively), far over the 5 s a build may take.
 * "all" folds each part (body, each limb) with join, falling back per part as the script does.
 */
export function buildForm(k, spec) {
    const { body, measurements, head = false, legs = true, pose = null, tol = MESH_TOL, joins = JOINS } = spec;
    if (joins !== "none" && joins !== "all") throw new Error(`joins must be "none" or "all", not ${joins}`);
    const bad = validateMeasurements(measurements) ?? validatePose(pose);
    if (bad) throw new Error(bad);
    const g = gradeForm(body, measurements);
    const p = normalisePose(pose);
    const timings = {}, separate = {}, parts = [];
    const t0 = now();
    const stage = (name, make) => {
        const t = now(), r = make();
        timings[name] = now() - t;
        separate[name] = r.separate;
        const ms = now();
        parts.push(...meshParts(k, r.solids, tol));
        timings[`${name} mesh`] = now() - ms;
    };
    stage("body", () => buildBody(k, g, { head, legs, joins }));
    for (const side of ["left", "right"]) stage(`${side}_arm`, () => buildLimb(k, g, side, "arm", p[`${side}_arm`], { joins }));
    if (legs) for (const side of ["left", "right"]) stage(`${side}_leg`, () => buildLimb(k, g, side, "leg", p[`${side}_leg`], { joins }));
    timings.total = now() - t0;
    const landmarks = formLandmarks(g, { head, legs, pose });
    return { parts, landmarks, girths: gradeGirths(g), timings, separate, grade: g };
}

/** Every part's mesh in one {positions, normals, indices}: the View item and the collider. */
export function concatParts(parts) {
    let nv = 0, ni = 0;
    for (const p of parts) { nv += p.positions.length; ni += p.indices.length; }
    const positions = new Float64Array(nv), normals = new Float64Array(nv), indices = new Uint32Array(ni);
    let ov = 0, oi = 0;
    for (const p of parts) {
        positions.set(p.positions, ov); normals.set(p.normals, ov);
        const base = ov / 3;
        for (let i = 0; i < p.indices.length; i++) indices[oi + i] = p.indices[i] + base;
        ov += p.positions.length; oi += p.indices.length;
    }
    return { positions, normals, indices };
}

/** min xyz, max xyz of positions (3 a vertex), only those with y >= yMin. */
export function positionsBox(positions, yMin = -Infinity) {
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = 0; i + 2 < positions.length; i += 3) {
        if (positions[i + 1] < yMin) continue;
        for (let a = 0; a < 3; a++) { const v = positions[i + a]; if (v < b[a]) b[a] = v; if (v > b[a + 3]) b[a + 3] = v; }
    }
    return b;
}
