// The dress-form grading port (form-grade.js) against tools/dressform.py: a golden written once
// by the script (tools/dressform-golden.py), so a transcription slip shows here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
    SIZES, chartMeasurements, grade, girths, validateMeasurements, RANGES,
    crownMm, solveH, chartStature, startFrom, gradeForm,
} from "../form-grade.js";

const golden = JSON.parse(readFileSync(new URL("./fixtures/dressform-golden.json", import.meta.url), "utf8"));
const near = (a, b, what) => {
    const tol = Math.abs(b) > 1000 ? 1e-12 * Math.abs(b) : 1e-9;
    assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);
};
assert.equal(golden.forms.length, 10);
let worst = 0, worstWaist = 0;
for (const gf of golden.forms) {
    const tag = `${gf.body}-${gf.size}`;
    const g = grade(gf.body, chartMeasurements(gf.body, gf.size));
    for (const k of Object.keys(gf.f)) { near(g.f[k], gf.f[k], `${tag} f.${k}`); worst = Math.max(worst, Math.abs(g.f[k] - gf.f[k])); }
    near(g.h, gf.h, `${tag} h`);
    near(g.belly, gf.belly, `${tag} belly`);
    assert.equal(g.sections.length, gf.sections.length);
    g.sections.forEach((s, i) => s.forEach((v, j) => {
        near(v, gf.sections[i][j], `${tag} section ${i}[${j}]`);
        worst = Math.max(worst, Math.abs(v - gf.sections[i][j]));
    }));
    const gi = girths(g);
    for (const k of Object.keys(gf.girths)) {
        near(gi[k], gf.girths[k], `${tag} girth ${k}`);
        // the belly rule moves the waist's girth off the chart (the script's a/sqrt(wb), b*sqrt(wb)
        // keeps the area, not Ramanujan's perimeter): the other three are exact
        const want = chartMeasurements(gf.body, gf.size)[k];
        if (k === "waist") { worstWaist = Math.max(worstWaist, Math.abs(gi[k] - want) / want); assert.ok(Math.abs(gi[k] - want) / want < 0.015, `${tag} waist ${gi[k]}`); }
        else near(gi[k], want, `${tag} girth ${k} is the chart's`);
    }
}
console.log(`ok - 10 chart sizes equal the script's grading (worst ${worst.toExponential(2)}); waist girth off the chart by up to ${(100 * worstWaist).toFixed(2)} % (the belly rule)`);

// a custom set: its landmark girths are the asked-for ones, its sections rise
const custom = { bust: 95, waist: 70, hip: 104, neck: 34, shoulder: 39, height: 165 };
for (const body of ["female", "male"]) {
    const g = grade(body, custom), gi = girths(g);
    for (const k of ["bust", "hip", "neck"]) near(gi[k], custom[k], `${body} custom ${k}`);
    assert.ok(Math.abs(gi.waist - custom.waist) / custom.waist < 0.015, `${body} custom waist ${gi.waist}`);
    for (let i = 1; i < g.sections.length; i++) assert.ok(g.sections[i][0] > g.sections[i - 1][0], `${body} section ${i} above ${i - 1}`);
    assert.equal(g.mRef.h, 1);
}
console.log("ok - custom measurements: girths as asked (waist within 1.5 %, the belly rule), sections monotone");

// validation: each bound one step outside, and NaN
const ok = startFrom("female", "M");
assert.equal(validateMeasurements(ok), null);
for (const [k, [lo, hi]] of Object.entries(RANGES)) {
    const msg = `${k} must be from ${lo} to ${hi} cm`;
    assert.equal(validateMeasurements({ ...ok, [k]: lo - 0.1 }), msg);
    assert.equal(validateMeasurements({ ...ok, [k]: hi + 0.1 }), msg);
    assert.equal(validateMeasurements({ ...ok, [k]: NaN }), msg);
    assert.equal(validateMeasurements({ ...ok, [k]: lo }), null);
    assert.equal(validateMeasurements({ ...ok, [k]: hi }), null);
}
assert.equal(validateMeasurements({ ...ok, bust: 59.9 }), "bust must be from 60 to 160 cm");
console.log("ok - measurement ranges");

// stature: the panel's Height is floor to crown. f-M's crown is 174.5 cm (forms.json f-M-head)
assert.equal(chartStature("female", "M"), 174.5);
let worstStature = 0;
for (const body of ["female", "male"]) for (const size of SIZES) {
    // Start from a chart size: the script's h exactly, so the shipped form's sections exactly
    const m = startFrom(body, size), g = gradeForm(body, m), gs = grade(body, chartMeasurements(body, size));
    assert.equal(g.h, gs.h, `${body}-${size}: h`);
    assert.deepEqual(g.sections, gs.sections, `${body}-${size}: sections`);
    assert.ok(Math.abs(solveH(body, m.height) - gs.h) < 1e-15, `${body}-${size}: the search finds the chart h`);
}
for (const body of ["female", "male"]) for (let s = 140; s <= 210; s += 0.7) {
    const h = solveH(body, s), e = Math.abs(crownMm(body, h) - s * 10);
    worstStature = Math.max(worstStature, e);
    assert.ok(e < 1e-9, `${body} ${s} cm: crown off by ${e} mm`);
}
console.log(`ok - stature solve: chart sizes exact, 140-210 cm within ${worstStature.toExponential(2)} mm`);
