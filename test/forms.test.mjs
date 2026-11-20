// assets/forms.json against the STEP forms it names: the body top the slots scale with, the
// arms the sleeves wrap round, and the head the hood slots stand beside (tools/dressform.py).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadKernel } from "./package.mjs";
import { sceneBox } from "../arrange.js";

const k = await loadKernel();
const forms = JSON.parse(readFileSync(new URL("../assets/forms.json", import.meta.url), "utf8")).forms;
const byName = new Map(forms.map((f) => [f.name, f]));
for (const name of ["f-M", "f-M-head"]) assert.ok(byName.has(name), `forms.json lists ${name}`);
const boxOf = (file) => {
    const s = k.open(new Uint8Array(readFileSync(new URL(`../assets/${file}`, import.meta.url))), "step", undefined, "native");
    try { return sceneBox(s.vertices(), s.origin()); } finally { s.free(); }
};
const plain = byName.get("f-M"), headed = byName.get("f-M-head");
const pb = boxOf(plain.file), hb = boxOf(headed.file);
// f-M's body top is its bounds' top (the neck knob), so the slots keep their heights on it
assert.ok(Math.abs(pb[4] - plain.body_top) < 2, `f-M top ${pb[4]} vs body_top ${plain.body_top}`);
assert.equal(headed.body_top, plain.body_top, "the same body under the head");
assert.equal(plain.head, undefined, "f-M has no head");
// the head: the bounds' top, about the chart's height, centred on x, between neck and crown
const h = headed.head;
assert.ok(Math.abs(hb[4] - h.top) < 2, `f-M-head top ${hb[4]} vs head.top ${h.top}`);
assert.ok(Math.abs(h.top - 1680) < 15, `crown at ${h.top}, the chart says 1680`);
assert.ok(Math.abs(h.centre[0]) < 1e-9 && h.chin_y > plain.hps_y && h.chin_y < h.centre[1]);
assert.ok(h.half[0] > 60 && h.half[0] < 95 && h.half[2] > h.half[0], `head half-axes ${h.half}`);
// the same arms and stand: x and z bounds as f-M's
for (const i of [0, 2, 3, 5]) assert.ok(Math.abs(pb[i] - hb[i]) < 1, `bound ${i}: ${pb[i]} vs ${hb[i]}`);
// the arms the T-shirt sample wraps its sleeves round (tools/make-sample.mjs)
const left = plain.arms.find((a) => a.side === "left"), right = plain.arms.find((a) => a.side === "right");
assert.deepEqual(left.shoulder.map(Math.round), [182, 1352, -8]);
assert.deepEqual(right.shoulder.map(Math.round), [-182, 1352, -8]);
assert.ok(Math.abs(Math.hypot(...left.dir) - 1) < 1e-9 && left.dir[0] > 0 && left.dir[1] < 0);
assert.ok(Math.abs(left.radius - 50) < 1e-9);
assert.ok(plain.hps_y > 1400 && plain.hps_y < 1450, `shoulder line ${plain.hps_y}`);
console.log(`ok - forms: f-M top ${pb[4].toFixed(1)}, f-M-head crown ${hb[4].toFixed(1)}`);
