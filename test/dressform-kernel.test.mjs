// The dress-form builder (dressform.js) with the wasm kernel: f-M against the shipped STEP, a
// custom form with legs standing closed on the floor, determinism, freed handles, poses and
// joint limits, and the build's timings. ATELIER_LONG=1 adds the joined builds (minutes each).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadKernel } from "./package.mjs";
import { buildForm, concatParts, positionsBox, MESH_TOL, FormCache, measureGirths, specKey } from "../dressform.js";
import { startFrom } from "../form-grade.js";
import { PRESETS } from "../form-pose.js";

const k = await loadKernel();
const LONG = process.env.ATELIER_LONG === "1";
const ms = (t) => Object.fromEntries(Object.entries(t).map(([a, b]) => [a, Math.round(b)]));

// a part's mesh is closed: weld equal positions, then every edge has exactly 2 triangles
function closedFlaws(p) {
    const id = new Map(), w = [];
    for (let i = 0; i < p.positions.length; i += 3) {
        const key = `${p.positions[i]},${p.positions[i + 1]},${p.positions[i + 2]}`;
        if (!id.has(key)) id.set(key, id.size);
        w.push(id.get(key));
    }
    const edges = new Map();
    for (let t = 0; t < p.indices.length; t += 3) {
        const v = [w[p.indices[t]], w[p.indices[t + 1]], w[p.indices[t + 2]]];
        if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) continue;   // a pole's zero-area sliver
        for (let e = 0; e < 3; e++) {
            const a = v[e], b = v[(e + 1) % 3], key = a < b ? `${a},${b}` : `${b},${a}`;
            edges.set(key, (edges.get(key) ?? 0) + 1);
        }
    }
    let bad = 0;
    for (const n of edges.values()) if (n !== 2) bad++;
    return bad;
}
function checkForm(r, what) {
    for (const p of r.parts) {
        assert.ok(p.indices.length > 0, `${what} ${p.name}: has triangles`);
        assert.ok(p.positions.every(Number.isFinite) && p.normals.every(Number.isFinite), `${what} ${p.name}: no NaN`);
        assert.equal(closedFlaws(p), 0, `${what} ${p.name}: closed`);
    }
}
const spec = (body, size, extra = {}) => ({ body, measurements: startFrom(body, size), ...extra });

// f-M (chart, no legs, Rest): its box above the thigh cut is the shipped f-M.stp's
const sc = k.open(new Uint8Array(readFileSync(new URL("../assets/f-M.stp", import.meta.url))), "step", undefined, "native");
const sv = sc.vertices(), so = sc.origin(), stp = [];
for (let i = 0; i < sv.length; i += 9) stp.push(sv[i] + so[0], sv[i + 1] + so[1], sv[i + 2] + so[2]);
const shippedTris = sc.indices().length / 3;
sc.free();
const stpBox = positionsBox(stp, 640);
const fM = buildForm(k, spec("female", "M", { legs: false }));
checkForm(fM, "f-M");
const fMBox = positionsBox(concatParts(fM.parts).positions, 640);
const boxOff = Math.max(...fMBox.map((v, i) => Math.abs(v - stpBox[i])));
assert.ok(boxOff < 3, `f-M box ${fMBox} vs f-M.stp ${stpBox}`);
console.log(`ok - f-M (no legs) within ${boxOff.toFixed(2)} mm of f-M.stp above the thigh cut`);

// a custom M with legs at Rest: closed parts, feet on the floor
const t0 = performance.now();
const cM = buildForm(k, spec("female", "M"));
const firstMs = performance.now() - t0;
checkForm(cM, "custom M");
const all = concatParts(cM.parts), box = positionsBox(all.positions);
assert.ok(Math.abs(box[1]) < 0.5, `feet at y ${box[1]}`);
for (const side of ["left", "right"]) {
    const foot = cM.parts.find((p) => p.name === `${side}_leg/foot`) ?? cM.parts.find((p) => p.name === `${side}_leg`);
    assert.ok(Math.abs(positionsBox(foot.positions)[1]) < 0.5, `${side} foot on the floor`);
}
// the crown would be the asked-for stature: the head's built top, with a head
const withHead = buildForm(k, { ...spec("female", "M"), head: true, measurements: { ...startFrom("female", "M"), height: 165 } });
const crown = positionsBox(concatParts(withHead.parts).positions)[4];
assert.ok(Math.abs(crown - 1650) < 1, `crown ${crown} for 165 cm`);
assert.ok(Math.abs(withHead.landmarks.head.top - 1650) < 1e-9);
console.log(`ok - custom M with legs: ${cM.parts.length} closed parts, ${all.indices.length / 3} triangles (f-M.stp ${shippedTris}, tol ${MESH_TOL}), feet at y ${box[1].toFixed(3)}, a 165 cm crown at ${crown.toFixed(3)}`);

// determinism: the same spec gives the same bytes
const again = concatParts(buildForm(k, spec("female", "M")).parts);
const bytes = (a) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
assert.deepEqual(bytes(again.positions), bytes(all.positions), "positions byte-identical");
assert.deepEqual(bytes(again.indices), bytes(all.indices), "indices byte-identical");
console.log("ok - two builds give byte-identical meshes");

// handles: every one is freed, so builds after the first reach no higher handle numbers
const highest = [];
let round = 0;
const counting = new Proxy(k, {
    get(target, name) {
        const v = target[name];
        if (typeof v !== "function" || !/_(sphere|translate|join|loft|loft_through|extrude|profile_ellipse|profile_circle|profile_rect)$/.test(String(name))) return v;
        return (...args) => { const h = v(...args); highest[round] = Math.max(highest[round] ?? 0, h); return h; };
    },
});
for (; round < 4; round++) buildForm(counting, spec("male", "S", { pose: PRESETS.Walk, head: true }));
assert.ok(highest.slice(1).every((h) => h === highest[1]), `highest handles ${highest}`);
const probe = k.cadaclysm_blacksmith_sphere(1);
k.cadaclysm_blacksmith_solid_free(probe);
assert.ok(probe <= highest[1], `a fresh handle ${probe} after 4 builds (highest in a build ${highest[1]})`);
console.log(`ok - no handle leaks (highest handle per build ${highest.join(", ")}; a fresh one is ${probe})`);

// a refused pose: the builder throws validatePose's message, never clamps
assert.throws(() => buildForm(k, spec("female", "M", { pose: { left_leg: { knee: 141 } } })), /left knee must be from 0 to 140°/);
assert.throws(() => buildForm(k, spec("female", "M", { pose: { right_arm: { elbow: NaN } } })), /right elbow must be from 0 to 145°/);
assert.throws(() => buildForm(k, { body: "female", measurements: { ...startFrom("female", "M"), bust: 200 } }), /bust must be from 60 to 160 cm/);
console.log("ok - invalid poses and measurements are refused");

// poses build closed, at every preset; timings
for (const [name, pose] of Object.entries(PRESETS)) {
    const r = buildForm(k, spec("female", "M", { pose }));
    checkForm(r, name);
    if (name === "Rest" || name === "T-pose") console.log(`  timings f-M ${name}: ${JSON.stringify(ms(r.timings))}`);
}
console.log(`ok - every preset builds closed (first build ${Math.round(firstMs)} ms)`);

// the cache: a pose change rebuilds only the limbs that moved, and gives what a fresh build gives
const cache = new FormCache(8);
const restSpec = spec("female", "M", { pose: PRESETS.Rest });
const first = buildForm(k, restSpec, cache);
assert.deepEqual(first.cached, []);
const kneeSpec = spec("female", "M", { pose: { ...PRESETS.Rest, left_leg: { abduction: 0, flexion: 0, knee: 60 } } });
const t1 = performance.now();
const knee = buildForm(k, kneeSpec, cache);
const kneeMs = performance.now() - t1;
assert.deepEqual(knee.cached, ["body", "left_arm", "right_arm", "right_leg"], "only the left leg is rebuilt");
const fresh = buildForm(k, kneeSpec);
assert.deepEqual(bytes(concatParts(knee.parts).positions), bytes(concatParts(fresh.parts).positions), "cached = fresh");
assert.deepEqual(buildForm(k, restSpec, cache).cached, ["body", "left_arm", "right_arm", "left_leg", "right_leg"], "back to Rest: all cached");
assert.equal(specKey(restSpec), specKey({ ...restSpec, pose: null }), "Rest and no pose are one form");
console.log(`ok - the cache: a knee bend rebuilds one leg (${Math.round(kneeMs)} ms)`);

// the tape's girths on the built form (hull, at the landmark heights) are within 2 % of the asked-for
let worstGirth = 0;
for (const [body, m] of [["female", startFrom("female", "M")], ["male", startFrom("male", "XL")],
    ["female", { bust: 95, waist: 70, hip: 104, neck: 34, shoulder: 39, height: 165 }]]) {
    const r = buildForm(k, { body, measurements: m });
    const gi = measureGirths(k, r.parts.find((p) => p.name === "body"), r.grade, m);
    for (const [key, { asked, measured }] of Object.entries(gi)) {
        const off = Math.abs(measured - asked) / asked;
        worstGirth = Math.max(worstGirth, off);
        assert.ok(off < 0.02, `${body} ${key}: ${measured} cm for ${asked}`);
    }
}
console.log(`ok - measured girths within ${(100 * worstGirth).toFixed(2)} % of the asked-for (2 % allowed)`);

// joined builds: each part folds with join, or reports what stayed separate (minutes each)
if (LONG) {
    for (const [what, s] of [["f-XS Rest", spec("female", "XS")], ["m-XL Rest", spec("male", "XL")],
        ["f-M T-pose", spec("female", "M", { pose: PRESETS["T-pose"] })], ["f-M Sit-ish", spec("female", "M", { pose: PRESETS["Sit-ish"] })]]) {
        const r = buildForm(k, { ...s, joins: "all" });
        checkForm(r, what);
        const sep = Object.entries(r.separate).map(([stage, parts]) => `${stage}: ${parts.length ? parts.join(", ") : "joined"}`);
        console.log(`  joins ${what}: ${r.parts.length} solids; ${sep.join("; ")}; ${Math.round(r.timings.total / 1000)} s`);
    }
    console.log("ok - joined builds closed");
} else console.log("skip - joined builds (ATELIER_LONG=1)");
