import assert from "node:assert/strict";
import { fromKes, PRESETS, presetParams, DISPLAY } from "../fabrics.js";
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
close(p.buckling_stiffness_warp, 0.5 * p.bending_warp);
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
// display: density shown in g/m², round trip exact
close(DISPLAY.density.toShown(2e-4), 200);
close(DISPLAY.density.fromShown(DISPLAY.density.toShown(3.3e-4)), 3.3e-4);
assert.equal(Object.keys(DISPLAY).length, 20);
console.log("fabrics: ok");
