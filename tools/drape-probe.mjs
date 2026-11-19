// Steps a garment's cloth in Node and prints its health every few frames: a quick look at
// whether a garment sews and drapes, and how long a step takes, without the page.
//
//     node tools/drape-probe.mjs [garment.json] [frames] [every]     # default: the sample, 90, 5
import { readFileSync } from "node:fs";
import { loadKernel } from "../test/package.mjs";
import { Drape } from "../cloth.js";
import { avatarMesh, statusOf } from "../drape.js";

const [file, frames = "90", every = "5"] = process.argv.slice(2);
const k = await loadKernel();
const scene = k.open(new Uint8Array(readFileSync(new URL("../assets/f-M.stp", import.meta.url))), "step", undefined, "native");
const drape = new Drape(k, process.env.NOAVATAR ? null : avatarMesh(scene.vertices(), scene.origin(), scene.indices()));
scene.free();
const text = readFileSync(file || new URL("../assets/tshirt.json", import.meta.url), "utf8");
drape.build(text);
for (let f = 1; f <= Number(frames); f++) {
    const t0 = performance.now();
    const h = drape.step();
    const ms = performance.now() - t0;
    if (f % Number(every) === 0 || h.warn || ms > 2000) {
        const p = drape.positions();
        const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
        for (let i = 0; i < p.length; i += 3) for (let a = 0; a < 3; a++) { b[a] = Math.min(b[a], p[i + a]); b[a + 3] = Math.max(b[a + 3], p[i + a]); }
        console.log(`${h.text} · ${ms.toFixed(0)} ms · box ${b.map((v) => Math.round(v)).join(" ")}`);
    }
    if (h.stop && !process.env.NOSTOP) break;
}
console.log(JSON.stringify(statusOf(drape.status())));
