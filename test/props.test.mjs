import assert from "node:assert/strict";
import { fieldsFor, opsFor, validate } from "../props.js";
import { presetParams, PRESETS } from "../fabrics.js";
import * as m from "../model.js";
const params = presetParams("cotton_jersey");
let nodes = m.newDocumentOps({ slug: "cotton_jersey", label: "Cotton jersey", params }).map((o) => o.node);
nodes.push({ id: "p1", kind: "garment.pattern", label: "Front", fabric: "f_cotton_jersey", layer: 0, allowance: [10], grain: [0, 1] });
const drawings = new Map([["p1", { sides: [0, 100, 150, 250, 300], bounds: [0, 0, 100, 50] }]]);

const pf = fieldsFor({ kind: "pattern", id: "p1" }, nodes, drawings);
assert.deepEqual(pf.map((f) => f.key), ["label", "fabric", "layer", "allowance", "grain", "slot"]);
assert.deepEqual(pf.find((f) => f.key === "fabric").options.map((o) => o.value), ["f_cotton_jersey"]);
assert.deepEqual(opsFor({ kind: "pattern", id: "p1" }, nodes, "label", "Back"), [{ op: "set", id: "p1", fields: { label: "Back" } }]);
const slotOps = opsFor({ kind: "pattern", id: "p1" }, nodes, "slot", "front", { avatarBounds: [-200, 0, -150, 200, 1700, 150], drawings });
assert.ok(slotOps[0].fields.frame.origin && slotOps[0].fields.meta.atelier.slot === "front");

const ff = fieldsFor({ kind: "fabric", id: "f_cotton_jersey" }, nodes, drawings);
const weight = ff.find((f) => f.key === "density");
assert.equal(weight.unit, "g/m²");
assert.ok(Math.abs(weight.value - params.density * 1e6) < 1e-9);
const set = opsFor({ kind: "fabric", id: "f_cotton_jersey" }, nodes, "density", 150);
assert.ok(Math.abs(set[0].fields.density - 150e-6) < 1e-15);
assert.ok(ff.find((f) => f.key === "preset").options.length === PRESETS.length);

// beyond the brief: "none" takes the slot and frame back; duplicate labels and bad numbers are refused
const placed = nodes.map((n) => (n.id === "p1" ? { ...n, frame: slotOps[0].fields.frame, meta: slotOps[0].fields.meta } : n));
const none = opsFor({ kind: "pattern", id: "p1" }, placed, "slot", "none", { drawings });
assert.equal(none[0].fields.frame, "xy");
assert.equal(none[0].fields.meta.atelier.slot, undefined);
const two = [...nodes, { id: "p2", kind: "garment.pattern", label: "Back" }];
assert.ok(validate({ kind: "pattern", id: "p1" }, two, "label", "Back"));
assert.equal(validate({ kind: "pattern", id: "p1" }, two, "label", "Front"), null);
assert.ok(validate({ kind: "pattern", id: "p1" }, two, "allowance", [-1]));
assert.ok(validate({ kind: "pattern", id: "p1" }, two, "layer", 1.5));
assert.equal(validate({ kind: "pattern", id: "p1" }, two, "layer", 2), null);
console.log("props: ok");
