// The sample T-shirt settles: the app's drape path (Atelier.load -> Drape on the CPU, the f-M
// form as collider, the kernel's default cloth options) run for FRAMES frames, the peak speed
// the cloth reports over the last WINDOW frames below BOUND mm/s. Frame counts only, no clock.
// A fabric whose buckled hinges are far stiffer than its unbuckled ones (buckling_stiffness
// read as an absolute stiffness instead of a ratio of bending) snaps back every substep and
// never settles: 10-13k mm/s peaks for ever. First: an old-style document opens with the ratio.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadKernel } from "./package.mjs";
import { Atelier } from "../kernel.js";
import { Drape } from "../cloth.js";
import { avatarMesh, statusOf } from "../drape.js";

const FRAMES = Number(process.env.SETTLE_FRAMES ?? 250), WINDOW = 50, BOUND = 200;

const k = await loadKernel();
const asset = (n) => new URL(`../assets/${n}`, import.meta.url);
const scene = k.open(new Uint8Array(readFileSync(asset("f-M.stp"))), "step", undefined, "native");
const avatar = avatarMesh(scene.vertices(), scene.origin(), scene.indices());
scene.free();

// an old-style document (buckling_stiffness saved as 0.5 x bending, g·mm²/s², as the app wrote it
// before the ratio) opens with the ratio: part of the base, no undo step; opening it again changes nothing
const DIRS = ["warp", "weft", "bias_left", "bias_right"];
const fabricOf = (at) => at.nodes().find((n) => n.kind === "garment.fabric");
{
    const o = new Atelier(k);
    o.load(readFileSync(asset("tshirt.json"), "utf8"));
    const f = fabricOf(o);
    const fields = Object.fromEntries(DIRS.map((d) => [`buckling_stiffness_${d}`, 0.5 * f[`bending_${d}`]]));
    k.cadaclysm_blacksmith_document_apply(o.d, JSON.stringify({ op: "batch", ops: [{ op: "set", id: f.id, fields }] }), null);
    const oldText = o.save();
    assert.ok(JSON.parse(oldText).nodes.some((n) => n.kind === "garment.fabric" && n.buckling_stiffness_warp > 1000), "an old-style document");
    const b = new Atelier(k);
    b.load(oldText);
    for (const d of DIRS) assert.ok(Math.abs(fabricOf(b)[`buckling_stiffness_${d}`] - 0.5) < 1e-12, `${d}: ${fabricOf(b)[`buckling_stiffness_${d}`]}`);
    assert.equal(b.undo(), false, "the migration is no undo step");
    const again = b.save(), c = new Atelier(k);
    c.load(again);
    assert.deepEqual(fabricOf(c), fabricOf(b), "loading a migrated document again changes nothing");
    for (const x of [o, b, c]) x.free();
}

const a = new Atelier(k);
a.load(readFileSync(asset("tshirt.json"), "utf8"));
const drape = new Drape(k, avatar);
drape.build(a.save());
const peaks = [];
let peak = 0;
for (let f = 1; f <= FRAMES; f++) {
    const h = drape.step();
    const s = statusOf(drape.status());
    assert.equal(s.nonFinite, 0, h.text);
    peak = Math.max(peak, s.maxSpeed);
    if (f % WINDOW === 0) { peaks.push(Math.round(peak)); peak = 0; }
}
const s = statusOf(drape.status());
console.log(`  ${drape.phase}, seams ${s.welded}/${s.seamPairs}; peak mm/s per ${WINDOW} frames: ${peaks.join(", ")}`);
assert.equal(drape.phase, "draping");
// every seam pair welded (116 for the sample): before the kernel's sewing fix for three-piece
// junctions (cadaclysm e41f6871de) 2 of them stayed open once the cloth was calm (the old
// stiff hinges had kicked them shut)
assert.ok(s.seamPairs > 0, "the sample has seams");
assert.equal(s.welded, s.seamPairs, `seams ${s.welded}/${s.seamPairs}`);
assert.ok(peaks.at(-1) < BOUND, `peak speed over the last ${WINDOW} frames ${peaks.at(-1)} mm/s, want < ${BOUND}: the cloth does not settle`);
drape.free();
a.free();
