// A piece's own mesh size (the pattern's particle_distance) against the real kernel: a finer
// sleeve builds more vertices, a live cloth re-meshes when it changes, and clearing it gives the
// garment default back.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadKernel } from "./package.mjs";
import { Atelier } from "../kernel.js";
import { Drape } from "../cloth.js";
import { statusOf } from "../drape.js";
import { DEFAULT_MESH } from "../props.js";
import * as m from "../model.js";

const k = await loadKernel();
// the app's constant is the kernel's default (cloth_default_options()[0])
assert.equal(DEFAULT_MESH, Array.from(k.cadaclysm_blacksmith_cloth_default_options())[0]);
const text = readFileSync(new URL("../assets/tshirt.json", import.meta.url), "utf8");
const vertices = (doc) => {
    const d = new Drape(k, null);
    try { d.build(doc); return statusOf(d.status()).vertices; } finally { d.free(); }
};

const a = new Atelier(k);
a.load(text);
const n0 = vertices(a.save());
a.apply(m.setPattern(a.nodes(), "p3", { particle_distance: 10 }), "mesh");
assert.equal(m.byId(a.nodes()).get("p3").particle_distance, 10);
const n1 = vertices(a.save());
assert.ok(n1 > n0 + 200, `a 10 mm left sleeve adds vertices: ${n0} -> ${n1}`);

// a live cloth: the edit re-meshes the sleeve (and the pieces whose seams it recounts)
const live = new Drape(k, null);
live.build(text);
const r = live.update(a.save());
assert.equal(r.kind, "remesh");
assert.ok(r.patterns.includes("p3"));
assert.equal(r.remeshed, true);
assert.ok(statusOf(live.status()).vertices > n0 + 200, "the live cloth re-meshed finer");

// more than 2x across a seam (the front at 30 mm sewn to the 10 mm sleeve) is refused with the
// kernel's message naming both pieces: a fresh build throws it, and a live cloth keeps its mesh
// and is marked stale with it (the worker shows that as the status)
a.apply(m.setPattern(a.nodes(), "p1", { particle_distance: 30 }), "mesh");
const refusal = /particle distance 30.*particle distance 10|particle distance 10.*particle distance 30/;
assert.throws(() => vertices(a.save()), (e) => refusal.test(e.message ?? String(e)) && /Front/.test(e.message) && /Left sleeve/.test(e.message));
const before = statusOf(live.status()).vertices;
assert.throws(() => live.update(a.save()), refusal);
assert.match(live.stale, /^re-mesh refused: .*ratio 3/);
assert.equal(statusOf(live.status()).vertices, before, "the refused edit leaves the cloth's mesh as it was");
a.apply(m.setPattern(a.nodes(), "p1", { particle_distance: null }), "mesh");

// empty: the node loses the field and the garment default comes back
a.apply(m.setPattern(a.nodes(), "p3", { particle_distance: null }), "mesh");
assert.equal("particle_distance" in m.byId(a.nodes()).get("p3"), false);
assert.equal(vertices(a.save()), n0);
live.free();
console.log(`ok - mesh: ${n0} vertices at 20 mm, ${n1} with a 10 mm left sleeve; front 30 mm on it refused`);
