// The form saved with the document (meta atelier.form, kernel.js formMeta / formMetaOp): one undo
// step, through save and load, other atelier meta kept, none on the sample.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadKernel } from "./package.mjs";
import { Atelier } from "../kernel.js";
import { normaliseSpec, specKey } from "../dressform.js";
import { startFrom } from "../form-grade.js";
import { PRESETS } from "../form-pose.js";

const k = await loadKernel();
const a = new Atelier(k);
const tshirt = readFileSync(new URL("../assets/tshirt.json", import.meta.url), "utf8");
a.load(tshirt);
assert.equal(a.formMeta(), null, "the sample has no form");
assert.deepEqual(a.formMetaOp(null), { op: "meta", app: "atelier", value: null });

const spec = normaliseSpec({ body: "female", measurements: startFrom("female", "S"), head: true, pose: { ...PRESETS["A-pose"], left_leg: { abduction: 5, flexion: 0, knee: 60 } } });
const nodesBefore = JSON.stringify(a.nodes());
a.apply([a.formMetaOp(spec)], "build form");
assert.deepEqual(a.formMeta(), spec);
assert.equal(JSON.stringify(a.nodes()), nodesBefore, "the meta op touches no node");
// save and load: the form comes back, its key unchanged
const saved = a.save();
const b = new Atelier(k);
b.load(saved);
assert.deepEqual(b.formMeta(), spec);
assert.equal(specKey(b.formMeta()), specKey(spec));
console.log("ok - the form round-trips through save and load");

// the meta op is one undo step
assert.equal(a.undo(), true);
assert.equal(a.formMeta(), null, "undo removes it");
a.redo();
assert.deepEqual(a.formMeta(), spec, "redo puts it back");
console.log("ok - Build is one undo step");

// another atelier meta key survives formMetaOp, both ways
a.apply([{ op: "meta", app: "atelier", value: { ...a.atelierMeta(), note: "keep me" } }], "note");
const spec2 = normaliseSpec({ ...spec, pose: PRESETS["T-pose"] });
a.apply([a.formMetaOp(spec2)], "apply pose");
assert.equal(a.atelierMeta().note, "keep me");
assert.deepEqual(a.formMeta(), spec2);
a.apply([a.formMetaOp(null)], "shipped form");
assert.deepEqual(a.atelierMeta(), { note: "keep me" }, "null removes form only");
a.apply([{ op: "meta", app: "atelier", value: null }], "clear");
a.apply([a.formMetaOp(spec)], "build form");
a.apply([a.formMetaOp(null)], "shipped form");
assert.equal(k.cadaclysm_blacksmith_document_meta(a.d, "atelier"), undefined, "nothing left: the meta is dropped");
console.log("ok - other atelier meta is kept; null drops an empty meta");

// load's fabric migration and seam anchoring keep the meta
const doc = JSON.parse(saved);
for (const n of doc.nodes) if (n.kind === "garment.fabric") n.buckling_stiffness_warp = 1e9;   // the old absolute form: migrated
const c = new Atelier(k);
c.load(JSON.stringify(doc));
assert.ok(c.nodes().filter((n) => n.kind === "garment.fabric").every((n) => n.buckling_stiffness_warp < 1e9), "migrated");
assert.deepEqual(c.formMeta(), spec, "migrated on load, the form kept");
console.log("ok - load's migrations keep the form");
