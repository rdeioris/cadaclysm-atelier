// The T-shirt sample drapes on a dress form built from measurements (dressform.js): the f chart's
// M typed as custom measurements, with legs, at Rest, then at A-pose (the limbs rebuilt from the
// cache). Each time the pieces are re-slotted on the form (reslot.js), the cloth is built from the
// re-arranged document and run SETTLE_FRAMES frames, with settle-kernel's health checks: no
// non-finite particle, every seam pair welded, the peak speed over the last 50 frames under
// 200 mm/s. Frame counts only, no clock. ATELIER_DRAPE_POSED=0 skips the A-pose half.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadKernel } from "./package.mjs";
import { Atelier } from "../kernel.js";
import { Drape } from "../cloth.js";
import { statusOf } from "../drape.js";
import { buildForm, concatParts, positionsBox, FormCache } from "../dressform.js";
import { chartMeasurements } from "../form-grade.js";
import { PRESETS } from "../form-pose.js";
import { reslotOps } from "../reslot.js";

const FRAMES = Number(process.env.SETTLE_FRAMES ?? 250), WINDOW = 50, BOUND = 200;
const k = await loadKernel();
const cache = new FormCache(8);
const tshirt = readFileSync(new URL("../assets/tshirt.json", import.meta.url), "utf8");
// the chart's M typed in as custom measurements (height: the stature, 174.5 cm for the female M)
const measurements = { ...chartMeasurements("female", "M"), height: 174.5 };

function drapeOn(what, pose) {
    const r = buildForm(k, { body: "female", measurements, pose }, cache);
    const all = concatParts(r.parts);
    const avatar = { bounds: positionsBox(all.positions), landmarks: r.landmarks };
    const a = new Atelier(k);
    a.load(tshirt);
    const re = reslotOps(a.nodes(), new Map(a.drawings().map((d) => [d.id, d])), avatar);
    assert.deepEqual(re.skipped, [], `${what}: every piece re-slotted`);
    if (re.ops.length) a.apply(re.ops, "re-arrange on the form");
    const drape = new Drape(k, { positions: all.positions, indices: all.indices });
    drape.build(a.save());
    const peaks = [];
    let peak = 0;
    for (let f = 1; f <= FRAMES; f++) {
        const h = drape.step();
        const s = statusOf(drape.status());
        assert.equal(s.nonFinite, 0, `${what} frame ${f}: ${h.text}`);
        peak = Math.max(peak, s.maxSpeed);
        if (f % WINDOW === 0) { peaks.push(Math.round(peak)); peak = 0; }
    }
    const s = statusOf(drape.status());
    console.log(`  ${what}: form ${all.indices.length / 3} triangles (cached ${r.cached.join(", ") || "none"}), ${re.moved.length} pieces re-slotted; ${FRAMES} frames, ${drape.phase}, seams ${s.welded}/${s.seamPairs}; peak mm/s per ${WINDOW} frames: ${peaks.join(", ")}`);
    assert.ok(s.seamPairs > 0, "the sample has seams");
    assert.equal(s.welded, s.seamPairs, `${what}: seams ${s.welded}/${s.seamPairs}`);
    assert.ok(peaks.at(-1) < BOUND, `${what}: peak speed over the last ${WINDOW} frames ${peaks.at(-1)} mm/s, want < ${BOUND}`);
    drape.free();
    a.free();
}

drapeOn("custom M at Rest", null);
console.log("ok - the T-shirt drapes on a custom M with legs");
if (process.env.ATELIER_DRAPE_POSED !== "0") {
    drapeOn("custom M at A-pose", PRESETS["A-pose"]);
    console.log("ok - the T-shirt drapes on the custom M at A-pose");
} else console.log("skip - the A-pose drape (ATELIER_DRAPE_POSED=0)");
