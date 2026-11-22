import assert from "node:assert/strict";
import { fieldsFor, opsFor, validate, fieldText } from "../props.js";
import { presetParams, PRESETS } from "../fabrics.js";
import * as m from "../model.js";
import { reanchor } from "../sewing.js";
const params = presetParams("cotton_jersey");
let nodes = m.newDocumentOps({ slug: "cotton_jersey", label: "Cotton jersey", params }).map((o) => o.node);
nodes.push({ id: "p1", kind: "garment.pattern", label: "Front", fabric: "f_cotton_jersey", layer: 0, allowance: [10], grain: [0, 1] });
const drawings = new Map([["p1", { sides: [0, 100, 150, 250, 300], bounds: [0, 0, 100, 50] }]]);

const pf = fieldsFor({ kind: "pattern", id: "p1" }, nodes, drawings);
assert.deepEqual(pf.map((f) => f.key), ["label", "fabric", "layer", "allowance", "grain", "slot", "remove"]);
assert.equal(pf.at(-1).type, "action");
assert.deepEqual(pf.find((f) => f.key === "fabric").options.map((o) => o.value), ["f_cotton_jersey"]);
assert.deepEqual(opsFor({ kind: "pattern", id: "p1" }, nodes, "label", "Back"), [{ op: "set", id: "p1", fields: { label: "Back" } }]);
const slotOps = opsFor({ kind: "pattern", id: "p1" }, nodes, "slot", "front", { avatarBounds: [-200, 0, -150, 200, 1700, 150], drawings });
assert.ok(slotOps[0].fields.frame.origin && slotOps[0].fields.meta.atelier.slot === "front");

const ff = fieldsFor({ kind: "fabric", id: "f_cotton_jersey" }, nodes, drawings);
const weight = ff.find((f) => f.key === "density");
assert.equal(weight.unit, "g/m²");
// buckling stiffness: a ratio of the bending, 0 to 1, with a tooltip saying so
const bs = ff.find((f) => f.key === "buckling_stiffness_warp");
assert.equal(bs.unit, "× bending");
assert.equal(bs.value, 0.5);
assert.match(bs.tip, /fraction of the bending stiffness/);
assert.equal(validate({ kind: "fabric", id: "f_cotton_jersey" }, nodes, "buckling_stiffness_warp", 0.3), null);
assert.match(validate({ kind: "fabric", id: "f_cotton_jersey" }, nodes, "buckling_stiffness_warp", 1323.9), /from 0 to 1/);
assert.match(validate({ kind: "fabric", id: "f_cotton_jersey" }, nodes, "buckling_ratio_weft", -0.1), /from 0 to 1/);
assert.equal(validate({ kind: "fabric", id: "f_cotton_jersey" }, nodes, "bending_warp", 5000), null);
assert.equal(ff.find((f) => f.key === "bending_warp").tip, undefined);
assert.ok(Math.abs(weight.value - params.density * 1e6) < 1e-9);
const set = opsFor({ kind: "fabric", id: "f_cotton_jersey" }, nodes, "density", 150);
assert.ok(Math.abs(set[0].fields.density - 150e-6) < 1e-15);
assert.ok(ff.find((f) => f.key === "preset").options.length === PRESETS.length);
// the fabric still carries jersey values: its measured source is shown; an estimated preset is flagged
assert.match(ff.find((f) => f.key === "source").value, /^Measured \(KES-F\): Narasimhan/);
assert.equal(ff.find((f) => f.key === "source").type, "readonly");
const est = m.addFabric(nodes, "cotton_fleece", "Cotton fleece (estimated)", presetParams("cotton_fleece")).ops[0].node;
const ef = fieldsFor({ kind: "fabric", id: est.id }, [...nodes, est], drawings);
assert.equal(ef.find((f) => f.key === "source").label, "Source (ESTIMATE)");
assert.match(ef.find((f) => f.key === "source").value, /^ESTIMATE, not measured/);
assert.ok(ef.find((f) => f.key === "preset").options.some((o) => o.label === "Cotton fleece (estimated)"));
const edited = { ...est, density: 2e-4 };
assert.equal(fieldsFor({ kind: "fabric", id: est.id }, [...nodes, edited], drawings).find((f) => f.key === "source"), undefined);

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
const seam = { id: "s1", kind: "garment.seam", a: "p1", b: "p2", a_from: 0, a_to: 50, b_from: 0, b_to: 50, reversed: false };
const withSeam = [...two, { id: "garment", kind: "garment.garment", patterns: ["p1", "p2"], seams: ["s1"] }, seam];
const sSel = { kind: "seam", id: "s1" };
assert.deepEqual(opsFor(sSel, withSeam, "reversed", "true"), [{ op: "set", id: "s1", fields: { reversed: true } }]);
assert.deepEqual(opsFor(sSel, withSeam, "a_to", 60), [{ op: "set", id: "s1", fields: { a_to: 60 } }]);
const rm = opsFor(sSel, withSeam, "remove", null);
assert.ok(rm.some((o) => o.op === "remove" && o.id === "s1") && rm.some((o) => o.op === "set" && o.id === "garment" && o.fields.seams.length === 0));
// I8: "Remove piece" takes the pattern, its outline and its seams
assert.deepEqual(opsFor({ kind: "pattern", id: "p1" }, withSeam, "remove", null), m.removePattern(withSeam, "p1"));
// I5: a typed seam end rewrites that end's anchor, so the next outline edit keeps the typed place
{
    const anchored = withSeam.map((n) => (n.id === "s1" ? { ...n, meta: { atelier: { a: [0, 0, 0.5], b: [0, 0, 0.5] } } } : n));
    const ops = opsFor(sSel, anchored, "a_from", 120, { drawings });
    assert.equal(ops.length, 1);
    assert.equal(ops[0].fields.a_from, 120);
    assert.deepEqual(ops[0].fields.meta.atelier, { a: [1, 0.4, 0.5, 0], b: [0, 0, 0.5] });
    const after = anchored.map((n) => (n.id === "s1" ? { ...n, ...ops[0].fields } : n));
    const grown = new Map([["p1", { sides: [0, 120, 170, 290, 340] }]]);
    const re = reanchor(after, grown, "p1").ops.find((o) => o.id === "s1").fields;
    assert.ok(Math.abs(re.a_from - 140) < 1e-9, `the typed end follows its side: ${re.a_from}`);
    assert.ok(Math.abs(re.a_to - 60) < 1e-9);
    // an end typed onto the same side, in order, keeps the three-number form; a "to" at a corner stays on its side
    const same = opsFor(sSel, anchored, "a_to", 100, { drawings })[0].fields.meta.atelier.a;
    assert.deepEqual(same, [0, 0, 1]);
    // without the piece's sides the stale anchor of that end is dropped
    const blind = opsFor(sSel, anchored, "b_to", 30, { drawings: new Map() })[0].fields.meta.atelier;
    assert.deepEqual(blind, { a: [0, 0, 0.5] });
}
const fSel = { kind: "fabric", id: "f_cotton_jersey" };
const pre = opsFor(fSel, nodes, "preset", "denim");
assert.equal(pre[0].fields.density, presetParams("denim").density);
assert.deepEqual(opsFor(fSel, nodes, "thickness", 0.7), [{ op: "set", id: "f_cotton_jersey", fields: { thickness: 0.7 } }]);
assert.throws(() => opsFor({ kind: "pattern", id: "p1" }, nodes, "slot", "front", { drawings }), /no avatar/);
// the avatar's Form select: the forms forms.json lists, the current one chosen
{
    const forms = [{ name: "f-M", label: "f-M" }, { name: "f-M-head", label: "f-M with head" }];
    const fields = fieldsFor({ kind: "avatar", id: "avatar" }, [], new Map(), { name: "f-M", bounds: [0, 0, 0, 1, 1, 1], landmarks: null, forms });
    const form = fields.find((f) => f.key === "form");
    assert.ok(form, "a Form field");
    assert.equal(form.type, "select");
    assert.equal(form.value, "f-M");
    assert.deepEqual(form.options, [{ value: "f-M", label: "f-M" }, { value: "f-M-head", label: "f-M with head" }]);
    const none = fieldsFor({ kind: "avatar", id: "avatar" }, [], new Map(), { name: "x", bounds: [0, 0, 0, 1, 1, 1] });
    assert.equal(none.find((f) => f.key === "form"), undefined, "no forms list: no Form field");
}
// the slot options: the hood slots on a form with a head, "On <piece>" for each placed piece;
// an on:<id> slot takes the host's frame, out a layer
{
    const withP2 = [...placed, { id: "p2", kind: "garment.pattern", label: "Pocket", layer: 1 }];
    const opts = (avatar) => fieldsFor({ kind: "pattern", id: "p2" }, withP2, drawings, avatar).find((f) => f.key === "slot").options.map((o) => o.value);
    const box = [-200, 0, -150, 200, 1700, 150];
    assert.ok(!opts({ name: "f-M", bounds: box, landmarks: { hps_y: 1425 } }).includes("hood_left"), "no head: no hood slots");
    const o = opts({ name: "f-M-head", bounds: box, landmarks: { hps_y: 1425, head: { centre: [0, 1630, 4], half: [75, 112.5, 95] } } });
    assert.ok(o.includes("hood_left") && o.includes("hood_right") && o.includes("on:p1") && !o.includes("on:p2"), o.join());
    const own = fieldsFor({ kind: "pattern", id: "p1" }, withP2, drawings, null).find((f) => f.key === "slot").options.map((o) => o.value);
    assert.ok(!own.includes("on:p1"), "not on itself");
    const d2 = new Map([...drawings, ["p2", { bounds: [10, 10, 40, 30] }]]);
    const on = opsFor({ kind: "pattern", id: "p2" }, withP2, "slot", "on:p1", { avatarBounds: box, drawings: d2 });
    const host = slotOps[0].fields.frame;
    assert.deepEqual(on[0].fields.frame.origin, [host.origin[0], host.origin[1], host.origin[2] + 8]);
    assert.equal(on[0].fields.meta.atelier.slot, "on:p1");
}
// a field's text: numbers as the user would type them; a grain rounded to 1e-4 (a mirrored
// piece's reflected grain is 2.442346e-8, 1 stored), -0 shown as 0, the stored value untouched
{
    const g = { key: "grain", type: "numbers", value: [2.442346e-8, 1] };
    assert.equal(fieldText(g), "0, 1");
    assert.deepEqual(g.value, [2.442346e-8, 1], "stored grain kept");
    assert.equal(fieldText({ key: "grain", type: "numbers", value: [-1e-9, -1] }), "0, -1");
    assert.equal(fieldText({ key: "grain", type: "numbers", value: [0.70710678, 0.70710678] }), "0.7071, 0.7071");
    assert.equal(fieldText({ key: "grain", type: "numbers", value: [-0.25, 1] }), "-0.25, 1");
    assert.equal(fieldText({ key: "allowance", type: "numbers", value: [10, 12.5] }), "10, 12.5");
    assert.equal(fieldText({ key: "x", type: "number", value: 1 / 3 }), "0.3333333");
    assert.equal(fieldText({ key: "label", type: "text", value: "Front" }), "Front");
    const mirrored = { ...nodes.find((n) => n.id === "p1"), grain: [2.442346e-8, 1] };
    const gf = fieldsFor({ kind: "pattern", id: "p1" }, [...nodes.filter((n) => n.id !== "p1"), mirrored], drawings).find((f) => f.key === "grain");
    assert.equal(fieldText(gf), "0, 1");
}
// a fabric's colour: the palette's until set, #rrggbb only, kept in meta.atelier (other meta kept)
{
    const fSel = { kind: "fabric", id: "f_cotton_jersey" };
    const cf = fieldsFor(fSel, nodes, drawings);
    assert.deepEqual(cf.slice(0, 3).map((f) => f.key), ["label", "colour", "duplicate"], "the three at the top: the numbers below scroll");
    assert.equal(cf[1].type, "colour");
    assert.equal(cf[1].value, "#d96c5a", "the palette's first colour until one is set");
    assert.equal(cf[2].type, "action");
    assert.equal(validate(fSel, nodes, "colour", "#2B4A6F"), null);
    for (const bad of ["2b4a6f", "#2b4a6", "#2b4a6g", "blue", ""]) assert.match(validate(fSel, nodes, "colour", bad), /#rrggbb/, bad);
    const withMeta = nodes.map((n) => (n.id === "f_cotton_jersey" ? { ...n, meta: { note: 1, atelier: { x: 2 } } } : n));
    const ops = opsFor(fSel, withMeta, "colour", " #2B4A6F ");
    assert.deepEqual(ops, [{ op: "set", id: "f_cotton_jersey", fields: { meta: { note: 1, atelier: { x: 2, colour: "#2b4a6f" } } } }]);
    const coloured = withMeta.map((n) => (n.id === "f_cotton_jersey" ? { ...n, ...ops[0].fields } : n));
    assert.equal(fieldsFor(fSel, coloured, drawings)[1].value, "#2b4a6f");
    // Duplicate: the same numbers and meta (so the same physics and colour) under a new id and label
    const dup = opsFor(fSel, coloured, "duplicate", null);
    assert.equal(dup.length, 1); assert.equal(dup[0].op, "add");
    const copy = dup[0].node, src = coloured.find((n) => n.id === "f_cotton_jersey");
    assert.equal(copy.id, "f_cotton_jersey_2"); assert.equal(copy.label, "Cotton jersey copy");
    for (const k of m.FABRIC_FIELDS) assert.equal(copy[k], src[k], k);
    assert.deepEqual(copy.meta, src.meta); assert.notEqual(copy.meta, src.meta, "a copy, not the same object");
    const again = m.duplicateFabric([...coloured, copy], "f_cotton_jersey").ops[0].node;
    assert.deepEqual([again.id, again.label], ["f_cotton_jersey_3", "Cotton jersey copy 2"]);
    assert.throws(() => m.duplicateFabric(nodes, "p1"), /no fabric p1/);
}
console.log("props: ok");
