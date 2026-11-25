// The form worker: dress forms built from measurements (dressform.js) on a kernel instance of its
// own, so a build of a second or more never stalls the View or the 2D window (the atelier
// worker draws both). The atelier worker starts it and sends `build`; it answers `built` with
// one mesh per part, the landmarks and the measured girths. Builds are cached (FormCache): a
// pose change rebuilds only the limbs that moved. Latest wins on the atelier worker's side.
import { load } from "./pkg/index.js";
import { buildForm, FormCache, measureGirths } from "./dressform.js";
import { crownMm } from "./form-grade.js";

const ready = (async () => {
    const module = await load();
    try {
        const r = await fetch(new URL("./cadaclysm.lic", import.meta.url));
        if (r.ok) module.license(await r.text());
    } catch { /* no licence beside the page */ }
    return module;
})();

const cache = new FormCache(8);
const copy = (p) => ({ name: p.name, positions: p.positions.slice(), normals: p.normals.slice(), indices: p.indices.slice() });

self.onmessage = async ({ data }) => {
    if (data.kind !== "build") return;
    const { ask, spec, key } = data;
    try {
        const k = await ready;
        const t0 = performance.now();
        const r = buildForm(k, { ...spec, legs: true }, cache);
        const body = r.parts.find((p) => p.name === "body");
        const girths = measureGirths(k, body, r.grade, spec.measurements);
        const parts = r.parts.map(copy);
        const separate = Object.entries(r.separate).filter(([, v]) => v.length).map(([s, v]) => `${s}: ${v.join(", ")}`);
        const timings = { ...r.timings, girths: performance.now() - t0 - r.timings.total, worker: performance.now() - t0 };
        self.postMessage({
            kind: "built", ask, key, landmarks: { ...r.landmarks, crown: crownMm(spec.body, r.grade.h) },
            parts, girths, timings, separate, cached: r.cached,
        }, parts.flatMap((p) => [p.positions.buffer, p.normals.buffer, p.indices.buffer]));
    } catch (e) {
        self.postMessage({ kind: "buildError", ask, key, text: String(e && e.message ? e.message : e) });
    }
};
