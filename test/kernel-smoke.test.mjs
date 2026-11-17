import assert from "node:assert/strict";
import { loadKernel } from "./package.mjs";
const k = await loadKernel();
const f = (n) => k[`cadaclysm_blacksmith_${n}`];
const d = f("document_new")("mm");
const add = (node) => f("document_apply")(d, JSON.stringify({ op: "add", node }));
add({ id: "p1_outline", kind: "profile.path", path: { start: [0, 0], segments: [
    { type: "line", to: [100, 0] }, { type: "line", to: [100, 50] }, { type: "line", to: [0, 50] }, { type: "line", to: [0, 0] }] } });
const fields = ["stretch_warp","stretch_weft","shear_left","shear_right","bending_warp","bending_weft","bending_bias_left","bending_bias_right",
    "buckling_ratio_warp","buckling_ratio_weft","buckling_ratio_bias_left","buckling_ratio_bias_right","buckling_stiffness_warp",
    "buckling_stiffness_weft","buckling_stiffness_bias_left","buckling_stiffness_bias_right","density","thickness","friction","internal_damping"];
add({ id: "f_x", kind: "garment.fabric", label: "x", ...Object.fromEntries(fields.map((n) => [n, 1])) });
add({ id: "p1", kind: "garment.pattern", label: "Front", outline: "p1_outline", fabric: "f_x" });
add({ id: "garment", kind: "garment.garment", patterns: ["p1"], seams: [] });
f("document_evaluate")(d, false);
const g = f("document_result_garment")(d, "garment");
assert.equal(f("garment_patterns")(g).length, 1);
f("garment_free")(g);
f("document_free")(d);
console.log("kernel-smoke: ok");
