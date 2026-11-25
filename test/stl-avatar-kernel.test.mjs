// STL avatars (spec §7): the reader opens an STL as a mesh scene, and its bounds and collider
// come out as a STEP's do -- a small ASCII STL exactly, and f-M written as an STL against f-M.stp.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadKernel } from "./package.mjs";
import { stlOf } from "./stl.mjs";
import { avatarFormat, sceneBox } from "../arrange.js";
import { avatarMesh } from "../drape.js";

const k = await loadKernel();
assert.equal(avatarFormat("form.STL"), "stl");
assert.equal(avatarFormat("form.stp"), "step");
assert.equal(avatarFormat("form.step"), "step");

const facet = (a, b, c) => `facet normal 0 0 0\n outer loop\n  vertex ${a}\n  vertex ${b}\n  vertex ${c}\n endloop\nendfacet\n`;
const ascii = `solid t\n${facet("0 0 0", "100 0 0", "0 200 0")}${facet("100 0 0", "100 200 50", "0 200 0")}endsolid t\n`;
let sc = k.open(new TextEncoder().encode(ascii), avatarFormat("t.stl"), undefined, "native");
assert.deepEqual(sceneBox(sc.vertices(), sc.origin()).map((x) => Math.round(x * 1e6) / 1e6), [0, 0, 0, 100, 200, 50]);
let col = avatarMesh(sc.vertices(), sc.origin(), sc.indices());
assert.equal(col.indices.length / 3, 2, "two triangles");
assert.equal(col.positions.length / 3, 4, "four shared vertices");
sc.free();
console.log("ok - an ASCII STL: its bounds, 2 triangles, 4 vertices");

const step = k.open(new Uint8Array(readFileSync(new URL("../assets/f-M.stp", import.meta.url))), "step", undefined, "native");
const stepBox = sceneBox(step.vertices(), step.origin()), stepTris = step.indices().length / 3;
const bytes = stlOf(step);
step.free();
sc = k.open(bytes, "stl", undefined, "native");
const box = sceneBox(sc.vertices(), sc.origin());
box.forEach((x, i) => assert.ok(Math.abs(x - stepBox[i]) < 0.01, `bound ${i}: ${x} vs ${stepBox[i]}`));
col = avatarMesh(sc.vertices(), sc.origin(), sc.indices());
assert.equal(col.indices.length / 3, stepTris, "the collider has every triangle");
assert.ok(col.positions.length / 3 >= 3 && col.positions.length / 3 <= 3 * stepTris);
for (let i = 0; i < col.indices.length; i++) assert.ok(col.indices[i] < col.positions.length / 3);
sc.free();
console.log(`ok - f-M as an STL: the STEP's bounds to 0.01 mm, ${stepTris} collider triangles, ${col.positions.length / 3} vertices`);
