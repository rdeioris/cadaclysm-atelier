import assert from "node:assert/strict";
import { fromKes, PRESETS, presetParams, DISPLAY, presetNote, matchingPreset, bucklingMigration } from "../fabrics.js";
import { FABRIC_FIELDS } from "../model.js";
const close = (a, b, rel = 1e-9) => assert.ok(Math.abs(a - b) <= rel * Math.max(1, Math.abs(b)), `${a} vs ${b}`);

const kes = { EMT: [5, 10], G: 1, B: [0.1, 0.05], W: 20, T: 0.5, MIU: 0.2 };
const p = fromKes(kes);
assert.deepEqual(Object.keys(p).sort(), [...FABRIC_FIELDS].sort());
close(p.stretch_warp, (500 / 0.05) * 980.665);
close(p.stretch_weft, (500 / 0.10) * 980.665);
close(p.shear_left, (180 / Math.PI) * 980.665);
close(p.shear_right, p.shear_left);
close(p.bending_warp, 0.1 * 9.80665e4);
close(p.bending_weft, 0.05 * 9.80665e4);
close(p.bending_bias_left, (p.bending_warp + p.bending_weft) / 2);
// buckling stiffness is a ratio of the bending (the kernel: buckled k = bending x it), not g·mm²/s²
for (const dir of ["warp", "weft", "bias_left", "bias_right"]) close(p[`buckling_stiffness_${dir}`], 0.5);
close(p.buckling_ratio_weft, 0.5);
close(p.density, 20e-5);
close(p.thickness, 0.5);
close(p.friction, 0.2);
close(p.internal_damping, 0.1);

// unpublished values (null) take the documented app defaults: T 0.5 mm, MIU 0.2, G 0.8 gf/(cm*deg)
const d = fromKes({ ...kes, G: null, T: null, MIU: null });
close(d.thickness, 0.5);
close(d.friction, 0.2);
close(d.shear_left, 0.8 * (180 / Math.PI) * 980.665);
close(d.shear_right, d.shear_left);

assert.ok(PRESETS.length >= 5);
assert.ok(PRESETS.some((x) => x.slug === "cotton_jersey"));
for (const x of PRESETS) {
    assert.match(x.source, /\S{10,}/, `${x.slug} cites a source`);
    for (const f of FABRIC_FIELDS) assert.ok(Number.isFinite(presetParams(x.slug)[f]) && presetParams(x.slug)[f] >= 0, `${x.slug}.${f}`);
}
// labelling rule: every preset is either measured (a citation, no "estimat" anywhere) or an
// estimate that says so three times: estimated: true, "(estimated)" in the label, and a
// source starting "Estimated, not measured" that names the measured row it scales
for (const x of PRESETS) {
    if (x.estimated === true) {
        assert.match(x.label, /\(estimated\)$/, `${x.slug}: an estimate's label ends "(estimated)"`);
        assert.match(x.source, /^Estimated, not measured: /, `${x.slug}: an estimate's source says so first`);
        assert.match(presetNote(x), /^ESTIMATE, not measured/);
    } else {
        assert.equal(x.estimated, undefined, `${x.slug}: estimated is true or absent`);
        assert.doesNotMatch(x.label + x.source, /estimat/i, `${x.slug}: a measured preset never reads as an estimate`);
        assert.match(x.source, /(19|20)\d\d/, `${x.slug}: a measured source cites a year`);
        assert.match(presetNote(x), /^Measured \(KES-F\): /);
    }
}

// the estimated fleece: cotton_jersey scaled by w = 30/16.2, t = 1.5/0.61 (fabrics.js says why)
const fleece = PRESETS.find((x) => x.slug === "cotton_fleece");
const jersey = PRESETS.find((x) => x.slug === "cotton_jersey");
const denim = PRESETS.find((x) => x.slug === "denim");
assert.ok(fleece.estimated === true && fleece.label === "Cotton fleece (estimated)");
const w = 30 / 16.2, t = 1.5 / 0.61;
close(fleece.kes.B[0], jersey.kes.B[0] * w * t, 1e-3);
close(fleece.kes.B[1], jersey.kes.B[1] * w * t, 1e-3);
close(fleece.kes.G, jersey.kes.G * w, 1e-3);
close(fleece.kes.EMT[0], jersey.kes.EMT[0] / Math.sqrt(w), 1e-3);
close(fleece.kes.EMT[1], jersey.kes.EMT[1] / Math.sqrt(w), 1e-3);
assert.equal(fleece.kes.MIU, jersey.kes.MIU);
// app units: 300 g/m², 1.5 mm, bending 0.123 gf·cm²/cm, stretch at the 500 gf/cm limit over 6.882 %
const fp = presetParams("cotton_fleece"), jp = presetParams("cotton_jersey"), dp = presetParams("denim");
close(DISPLAY.density.toShown(fp.density), 300);
close(fp.thickness, 1.5);
close(fp.friction, 0.208);
close(fp.bending_warp, 0.1230 * 9.80665e4);
close(fp.bending_weft, fp.bending_warp);
close(fp.stretch_warp, (500 / 0.06882) * 980.665);
close(fp.shear_left, 1.463 * (180 / Math.PI) * 980.665);
// plausibility: stiffer than the jersey, softer and stretchier than the denim, heavier and thicker than both
for (const f of ["bending_warp", "stretch_warp", "shear_left"]) assert.ok(jp[f] < fp[f] && fp[f] < dp[f], `${f}: jersey < fleece < denim`);
assert.ok(fp.density > dp.density && fp.density > jp.density && fp.thickness > dp.thickness);
// the UI's source line: a fabric still carrying the fleece's values is found as the estimate
assert.equal(matchingPreset(fp).slug, "cotton_fleece");
assert.equal(matchingPreset(jp).slug, "cotton_jersey");
assert.equal(matchingPreset({ ...fp, density: 2e-4 }), undefined);

// the heavyweight fleece: the same rules at w = 45/16.2, t = 2.5/0.61, heavier and stiffer than the fleece
{
    const heavy = PRESETS.find((x) => x.slug === "cotton_fleece_heavy");
    assert.ok(heavy.estimated === true && heavy.label === "Heavyweight cotton fleece (estimated)");
    const w = 45 / 16.2, t = 2.5 / 0.61;
    close(heavy.kes.B[0], jersey.kes.B[0] * w * t, 1e-3);
    close(heavy.kes.G, jersey.kes.G * w, 1e-3);
    close(heavy.kes.EMT[0], jersey.kes.EMT[0] / Math.sqrt(w), 1e-3);
    const hp = presetParams("cotton_fleece_heavy");
    close(DISPLAY.density.toShown(hp.density), 450);
    close(hp.thickness, 2.5);
    for (const f of ["bending_warp", "shear_left", "stretch_warp"]) assert.ok(fp[f] < hp[f], `${f}: fleece < heavyweight`);
    assert.ok(hp.density > fp.density && hp.thickness > fp.thickness, "heavier and thicker than the fleece");
    assert.equal(matchingPreset(hp).slug, "cotton_fleece_heavy");
}

// display: density shown in g/m², round trip exact
close(DISPLAY.density.toShown(2e-4), 200);
close(DISPLAY.density.fromShown(DISPLAY.density.toShown(3.3e-4)), 3.3e-4);
assert.equal(Object.keys(DISPLAY).length, 20);
assert.equal(DISPLAY.buckling_stiffness_warp.unit, "× bending");
assert.deepEqual(DISPLAY.buckling_stiffness_bias_left.range, [0, 1]);
assert.deepEqual(DISPLAY.buckling_ratio_weft.range, [0, 1]);
assert.equal(DISPLAY.bending_warp.unit, "g·mm²/s²");
for (const x of PRESETS) for (const dir of ["warp", "weft", "bias_left", "bias_right"]) {
    const v = presetParams(x.slug)[`buckling_stiffness_${dir}`];
    assert.ok(v >= 0 && v <= 1, `${x.slug}: buckling_stiffness_${dir} ${v} is a ratio`);
}

// migration: a fabric saved with the old absolute form (0.5 x bending) gets the ratio back
{
    const old = { id: "f_j", kind: "garment.fabric", ...jp };
    for (const dir of ["warp", "weft", "bias_left", "bias_right"]) old[`buckling_stiffness_${dir}`] = 0.5 * jp[`bending_${dir}`];
    const ops = bucklingMigration([old, { id: "garment", kind: "garment.garment" }, { id: "f_new", kind: "garment.fabric", ...fp }]);
    assert.equal(ops.length, 1, "only the old fabric changes");
    assert.equal(ops[0].id, "f_j");
    assert.deepEqual(Object.keys(ops[0].fields).sort(), ["buckling_stiffness_bias_left", "buckling_stiffness_bias_right", "buckling_stiffness_warp", "buckling_stiffness_weft"]);
    for (const v of Object.values(ops[0].fields)) close(v, 0.5);
    const migrated = { ...old, ...ops[0].fields };
    assert.deepEqual(bucklingMigration([migrated]), [], "idempotent");
    assert.equal(matchingPreset(migrated).slug, "cotton_jersey", "a migrated app fabric is its preset again");
    // one direction old, the others current: only that one; above 2 x bending: clamped to 1; no bending: 0.5
    const mixed = { ...jp, id: "f_m", kind: "garment.fabric", buckling_stiffness_weft: 4 * jp.bending_weft, buckling_stiffness_warp: 3, bending_warp: 0 };
    assert.deepEqual(bucklingMigration([mixed]), [{ op: "set", id: "f_m", fields: { buckling_stiffness_warp: 0.5, buckling_stiffness_weft: 1 } }]);
    assert.deepEqual(bucklingMigration([{ ...mixed, buckling_stiffness_warp: 0.5, buckling_stiffness_weft: 1 }]), []);
}
console.log("fabrics: ok");
