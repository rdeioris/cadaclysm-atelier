// cloth.js against the real kernel: the sample T-shirt on the f-M form as a cloth, its phases,
// pins and drag, an outline edit re-meshing one pattern and keeping the others' drape, and a
// seam removal marking the cloth stale.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadKernel } from "./package.mjs";
import { Atelier } from "../kernel.js";
import { Drape } from "../cloth.js";
import { avatarMesh, splitByPattern, gather, statusOf } from "../drape.js";
import * as m from "../model.js";

const k = await loadKernel();
const asset = (n) => new URL(`../assets/${n}`, import.meta.url);
const scene = k.open(new Uint8Array(readFileSync(asset("f-M.stp"))), "step", undefined, "native");
const avatar = avatarMesh(scene.vertices(), scene.origin(), scene.indices());
scene.free();
assert.ok(avatar.indices.length > 300 && avatar.indices.length % 3 === 0, "the form is a triangle mesh");

const a = new Atelier(k);
a.load(readFileSync(asset("tshirt.json"), "utf8"));
const drape = new Drape(k, avatar);
assert.throws(() => drape.build(new Atelier(k).save()), /no garment/);
drape.build(a.save());
const st = () => statusOf(drape.status());
assert.equal(drape.phase, "sewing");
const t0 = performance.now();
let h;
for (let i = 0; i < 3; i++) h = drape.step();
const ms = (performance.now() - t0) / 3;
assert.equal(st().frame, 3);
assert.ok(st().seamPairs > 0 && st().vertices > 100, JSON.stringify(st()));
assert.equal(h.stop, false, h.text);
console.log(`  ${h.text}; ${ms.toFixed(0)} ms/frame`);

// topology: every pattern drawn, every triangle in one pattern
const topo = drape.topology();
assert.deepEqual([...topo.patterns].sort(), ["p1", "p2", "p3", "p4"]);
const split = splitByPattern(topo.triangles, topo.vertexPatterns);
assert.equal(split.size, 4);
assert.equal([...split.values()].reduce((s, g) => s + g.indices.length, 0), topo.triangles.length);

// pin a vertex: it stays where it was; unpin it
const pos0 = drape.positions();
assert.equal(drape.togglePin(0), true);
assert.deepEqual([...drape.pinPositions()], [...pos0.subarray(0, 3)]);
drape.step();
assert.deepEqual([...drape.positions().subarray(0, 3)], [...pos0.subarray(0, 3)], "a pinned vertex does not move");
// drag another one 50 mm along x: it moves that way
const v = 40, before = drape.positions().slice(3 * v, 3 * v + 3);
drape.drag(v, [before[0] + 50, before[1], before[2]]);
drape.step(); drape.step();
const after = drape.positions().slice(3 * v, 3 * v + 3);
assert.ok(after[0] - before[0] > 5, `dragged ${after[0] - before[0]} mm along x`);
drape.drag(v, null);

// an outline edit on the left sleeve (2 % bigger about its centre): re-meshed, the back keeps
// its drape bit for bit, the front's pin is found again
const backOf = () => { const t = drape.topology(); const p = t.patterns.indexOf("p2"); return Array.from(gather(drape.positions(), splitByPattern(t.triangles, t.vertexPatterns).get(p).verts)).sort((x, y) => x - y); };
const back = backOf();
const pinnedPattern = drape.topology().patterns[drape.topology().vertexPatterns[0]];
const b = a.drawing("p3").bounds, cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2, s = 1.02;
a.commit(m.setOutline(a.nodes(), "p3", a.transformed("p3", [s, 0, cx * (1 - s), 0, s, cy * (1 - s)])), "edit", "p3");
const r = drape.update(a.save());
assert.equal(r.kind, "remesh", JSON.stringify(r));
assert.ok(r.patterns.includes("p3"));
assert.equal(r.remeshed, true);
console.log(`  re-meshed ${r.patterns.join(", ")}; pinned on ${pinnedPattern}`);
if (!r.patterns.includes("p2")) assert.deepEqual(backOf(), back, "the back keeps its drape");
if (!r.patterns.includes(pinnedPattern)) assert.equal(drape.pins.size, 1, "the pin on an unchanged pattern stays");
drape.step();
assert.equal(statusOf(drape.status()).nonFinite, 0);

// the front moved 300 mm in 2D (the Move tool's own transform): nothing changes in 3D, not
// even during the preview; then a shape edit on the moved front re-meshes it cleanly
const posBefore = drape.positions();
const shift = m.setOutline(a.nodes(), "p1", a.transformed("p1", [1, 0, 300, 0, 1, 0]));
assert.equal(drape.update(a.save(), shift).kind, "same", "a 2D drag of a piece is no change");
a.commit(shift, "move", "p1");
const rm = drape.update(a.save());
assert.equal(rm.kind, "same", JSON.stringify(rm));
assert.deepEqual(drape.offsets.get("p1"), [300, 0]);
assert.deepEqual([...drape.positions()], [...posBefore], "the cloth did not move");
const fb = a.drawing("p1").bounds, fx = (fb[0] + fb[2]) / 2, fy = (fb[1] + fb[3]) / 2;
a.commit(m.setOutline(a.nodes(), "p1", a.transformed("p1", [1.02, 0, fx * -0.02, 0, 1.02, fy * -0.02])), "edit", "p1");
const frontOf = () => { const t = drape.topology(); const p = t.patterns.indexOf("p1"); const g = splitByPattern(t.triangles, t.vertexPatterns).get(p); return gather(drape.positions(), g.verts); };
const box = (xs) => { const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]; for (let i = 0; i < xs.length; i += 3) for (let k = 0; k < 3; k++) { b[k] = Math.min(b[k], xs[i + k]); b[k + 3] = Math.max(b[k + 3], xs[i + k]); } return b; };
const frontBox = box(frontOf());
const r1 = drape.update(a.save());
assert.equal(r1.kind, "remesh");
assert.deepEqual(r1.patterns, ["p1"]);
const newBox = box(frontOf());
const grow = Math.max(...newBox.map((v, i) => Math.abs(v - frontBox[i])));
assert.ok(grow < 30, `the re-meshed front stays where it hung (box moved ${grow.toFixed(1)} mm)`);
const tStep = performance.now(); drape.step();
assert.ok(performance.now() - tStep < 5000, "a step after the re-mesh is not blown up");
assert.equal(statusOf(drape.status()).nonFinite, 0);
console.log(`  2D move: nothing in 3D; edit after it: front box moved ${grow.toFixed(1)} mm`);

// a preview's ops on top of the saved text are what the cloth sees
const r2 = drape.update(a.save(), m.setPattern(a.nodes(), "p1", { label: "Front 2" }));
assert.equal(r2.kind, "same");

// removing a seam: stale, the cloth kept as it is
const seam = a.nodes().find((n) => n.kind === "garment.seam");
const g = m.byId(a.nodes()).get("garment");
a.apply([{ op: "remove", id: seam.id }, { op: "set", id: "garment", fields: { seams: g.seams.filter((x) => x !== seam.id) } }], "remove seam");
const r3 = drape.update(a.save());
assert.equal(r3.kind, "stale");
assert.equal(drape.stale, "the seams changed");
assert.ok(drape.live);

// a rebuild clears it
drape.build(a.save());
assert.equal(drape.stale, null);
assert.equal(statusOf(drape.status()).frame, 0);
drape.free();
assert.equal(drape.live, false);
console.log("cloth-kernel: ok");
