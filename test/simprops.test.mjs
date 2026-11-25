// The simulation controls' pure parts: the property rows of a piece, seam, fabric, internal
// line and tack through props.js, their checks and ops; the Simulation panel's options and ops;
// the pin ops; tacks going with their pieces; and what each edit does to a live cloth.
import assert from "node:assert/strict";
import { fieldsFor, opsFor, validate, fieldText } from "../props.js";
import { presetParams } from "../fabrics.js";
import * as m from "../model.js";
import { pinOps, N, ELASTIC_N } from "../simprops.js";
import { OPTIONS, OPTION_NAMES, optionFields, optionOps, resetOptionsOps, validateOption, optionValues } from "../simpanel.js";
import { addTack, removeTack, tacksOn } from "../tacks.js";
import { garmentChange, frozenChanges, optionsChanged } from "../drape.js";

const params = presetParams("cotton_jersey");
const base = m.newDocumentOps({ slug: "cotton_jersey", label: "Cotton jersey", params }).map((o) => o.node);
const line = (x0, y0, x1, y1) => ({ start: [x0, y0], segments: [{ type: "line", to: [x1, y1] }] });
let nodes = m.withAdded(base, m.addPattern(base, { label: "Front", path: m.rectPath(0, 0, 100, 100), fabric: "f_cotton_jersey" }).ops);
nodes = m.withAdded(nodes, m.addPattern(nodes, { label: "Back", path: m.rectPath(200, 0, 100, 100), fabric: "f_cotton_jersey" }).ops);
nodes = m.withAdded(nodes, m.addSeam(nodes, { a: "p1", b: "p2", a_from: 0, a_to: 100, b_from: 0, b_to: 100 }).ops);
nodes = m.withAdded(nodes, m.setPattern(nodes, "p1", { internal: [{ kind: "line", path: line(10, 10, 90, 10) }, { kind: "fold", path: line(10, 50, 90, 50) }] }));
const keys = (fs) => fs.map((f) => f.key);
const one = (ops) => { assert.equal(ops.length, 1); return ops[0].fields; };

// ---- a piece: Freeze, Strengthen, Pressure, saved pins ----------------------------------------
{
    const sel = { kind: "pattern", id: "p1" };
    const f = fieldsFor(sel, nodes, new Map());
    { const k = keys(f), at = k.indexOf("slot"); assert.deepEqual(k.slice(at + 1, at + 4), ["frozen", "strengthen", "pressure"], "after Slot, before the transforms"); }
    assert.equal(f.find((x) => x.key === "frozen").value, "false");
    assert.equal(f.find((x) => x.key === "strengthen").value, 1);
    assert.equal(f.find((x) => x.key === "pressure").unit, "Pa");
    assert.deepEqual(one(opsFor(sel, nodes, "frozen", "true")), { frozen: true });
    assert.deepEqual(one(opsFor(sel, nodes, "frozen", "false")), { frozen: null }, "unfrozen: no param");
    assert.deepEqual(one(opsFor(sel, nodes, "strengthen", 3)), { strengthen: 3 });
    assert.deepEqual(one(opsFor(sel, nodes, "strengthen", 1)), { strengthen: null }, "the default: no param");
    assert.deepEqual(one(opsFor(sel, nodes, "pressure", -20)), { pressure: -20 });
    assert.deepEqual(one(opsFor(sel, nodes, "pressure", 0)), { pressure: null });
    assert.match(validate(sel, nodes, "strengthen", 0.5), /from 1/);
    assert.match(validate(sel, nodes, "strengthen", NaN), /from 1/);
    assert.equal(validate(sel, nodes, "pressure", -50), null);
    assert.match(validate(sel, nodes, "pressure", 1e6), /pascals/);
    // the props' own keys are untouched
    assert.match(validate(sel, nodes, "layer", 1.5), /whole number/);
    // pins: a count and Clear once there are some
    const pinned = m.withAdded(nodes, m.setPattern(nodes, "p1", { pins: [[10, 20], [30, 40]] }));
    const pf = fieldsFor(sel, pinned, new Map());
    assert.equal(pf.find((x) => x.key === "pins").value, "2");
    assert.equal(pf.find((x) => x.key === "clear_pins").type, "action");
    assert.deepEqual(one(opsFor(sel, pinned, "clear_pins", "")), { pins: null });
}

// ---- pins saved from the cloth ------------------------------------------------------------------
{
    let n = nodes;
    n = m.withAdded(n, pinOps(n, "p1", [10.1234567891, 20], true));
    assert.deepEqual(m.byId(n).get("p1").pins, [[10.123457, 20]], "rounded to 1e-6 mm");
    n = m.withAdded(n, pinOps(n, "p1", [50, 50], true));
    // a release takes out the saved pin nearest it (a re-meshed vertex lies near, not on it)
    n = m.withAdded(n, pinOps(n, "p1", [51, 49], false));
    assert.deepEqual(m.byId(n).get("p1").pins, [[10.123457, 20]]);
    assert.deepEqual(pinOps(n, "p1", [80, 80], false), [], "none near: nothing");
    n = m.withAdded(n, pinOps(n, "p1", [10, 20], false));
    assert.equal(m.byId(n).get("p1").pins, null, "the last one out: no param");
    assert.deepEqual(pinOps(n, "nope", [0, 0], true), []);
}

// ---- a fabric: shrinkage as CLO's % ----------------------------------------------------------
{
    const sel = { kind: "fabric", id: "f_cotton_jersey" };
    const f = fieldsFor(sel, nodes, new Map());
    assert.deepEqual(keys(f).slice(-2), ["shrink_warp", "shrink_weft"]);
    assert.equal(f.at(-1).value, 100, "100: none");
    assert.deepEqual(one(opsFor(sel, nodes, "shrink_warp", 95)), { shrinkage: [0.95, 1] });
    const shrunk = m.withAdded(nodes, opsFor(sel, nodes, "shrink_warp", 95));
    assert.equal(fieldsFor(sel, shrunk, new Map()).find((x) => x.key === "shrink_warp").value, 95);
    assert.deepEqual(one(opsFor(sel, shrunk, "shrink_weft", 110)), { shrinkage: [0.95, 1.1] });
    assert.deepEqual(one(opsFor(sel, shrunk, "shrink_warp", 100)), { shrinkage: null }, "both 100: no param");
    assert.match(validate(sel, nodes, "shrink_weft", 40), /50 to 200/);
    assert.equal(validate(sel, nodes, "shrink_weft", 200), null);
    // a duplicate keeps it
    const dup = m.duplicateFabric(shrunk, "f_cotton_jersey").ops[0].node;
    assert.deepEqual(dup.shrinkage, [0.95, 1]);
}

// ---- a seam: Strengthen, Elastic (% and N) ----------------------------------------------------
{
    const sel = { kind: "seam", id: "s1" };
    const f = fieldsFor(sel, nodes, new Map());
    assert.deepEqual(keys(f).slice(-4), ["strengthen", "elastic_ratio", "elastic_stiffness", "remove"]);
    const stiff = f.find((x) => x.key === "elastic_stiffness");
    assert.equal(stiff.value, null);
    assert.equal(stiff.placeholder, `${ELASTIC_N} (estimated)`);
    assert.deepEqual(one(opsFor(sel, nodes, "strengthen", 5)), { strengthen: 5 });
    assert.deepEqual(one(opsFor(sel, nodes, "elastic_ratio", 70)), { elastic: { ratio: 0.7, stiffness: ELASTIC_N * N } }, "the estimate, 2 N");
    const el = m.withAdded(nodes, opsFor(sel, nodes, "elastic_ratio", 70));
    assert.equal(fieldText(fieldsFor(sel, el, new Map()).find((x) => x.key === "elastic_ratio")), "70");
    assert.deepEqual(one(opsFor(sel, el, "elastic_stiffness", 3)), { elastic: { ratio: 0.7, stiffness: 3e6 } }, "N -> g·mm/s²");
    assert.deepEqual(one(opsFor(sel, el, "elastic_stiffness", null)), { elastic: { ratio: 0.7, stiffness: 2e6 } }, "empty: the estimate");
    assert.deepEqual(one(opsFor(sel, el, "elastic_ratio", null)), { elastic: null }, "empty: no elastic");
    assert.match(validate(sel, nodes, "elastic_stiffness", 3), /length \(%\) first/);
    assert.match(validate(sel, nodes, "elastic_ratio", 0), /above 0/);
    assert.match(validate(sel, nodes, "elastic_ratio", 120), /at most 100/);
    assert.equal(validate(sel, el, "elastic_stiffness", 3), null);
    assert.match(validate(sel, el, "elastic_stiffness", -1), /above 0 N/);
    assert.match(validate(sel, nodes, "a_from", -1), /0 mm or more/, "the seam's own keys");
}

// ---- an internal line: kind, fold angle and strength, elastic ------------------------------------
{
    const plain = { kind: "internal", id: "p1", index: 0 }, fold = { kind: "internal", id: "p1", index: 1 };
    assert.deepEqual(keys(fieldsFor(plain, nodes, new Map())), ["line_kind", "elastic_ratio", "elastic_stiffness", "remove"]);
    const ff = fieldsFor(fold, nodes, new Map());
    assert.deepEqual(keys(ff), ["line_kind", "angle", "fold_strength", "elastic_ratio", "elastic_stiffness", "remove"]);
    assert.equal(ff.find((x) => x.key === "angle").value, 180, "flat until set");
    assert.deepEqual(fieldsFor({ kind: "internal", id: "p1", index: 9 }, nodes, new Map()), [], "a gone line has no rows");
    const internal = (ops) => one(ops).internal;
    let l = internal(opsFor(fold, nodes, "angle", 90));
    assert.equal(l[1].angle, 90);
    assert.equal(l[0].angle, undefined, "the other line as it was");
    const folded = m.withAdded(nodes, opsFor(fold, nodes, "angle", 90));
    l = internal(opsFor(fold, folded, "fold_strength", 2));
    assert.deepEqual([l[1].angle, l[1].strength], [90, 2]);
    assert.equal(internal(opsFor(fold, folded, "angle", 180))[1].angle, undefined, "180: the default, left out");
    // a fold made a plain line loses its angle and strength (the kernel refuses them on a line)
    const strong = m.withAdded(folded, opsFor(fold, folded, "fold_strength", 2));
    l = internal(opsFor(fold, strong, "line_kind", "line"));
    assert.deepEqual(l[1], { kind: "line", path: line(10, 50, 90, 50) });
    l = internal(opsFor(plain, nodes, "line_kind", "fold"));
    assert.equal(l[0].kind, "fold");
    // an elastic on a line
    l = internal(opsFor(plain, nodes, "elastic_ratio", 80));
    assert.deepEqual(l[0].elastic, { ratio: 0.8, stiffness: 2e6 });
    const elastic = m.withAdded(nodes, opsFor(plain, nodes, "elastic_ratio", 80));
    assert.equal(internal(opsFor(plain, elastic, "elastic_ratio", null))[0].elastic, undefined);
    // remove
    assert.deepEqual(internal(opsFor(plain, nodes, "remove", null)).map((x) => x.kind), ["fold"]);
    assert.match(validate(fold, nodes, "angle", 400), /0 to 360/);
    assert.match(validate(fold, nodes, "fold_strength", -1), /0 to 1000/);
    assert.match(validate(plain, nodes, "line_kind", "hem"), /line, a fold or a dart/);
    assert.match(validate({ kind: "internal", id: "p1", index: 9 }, nodes, "angle", 90), /gone/);
}

// ---- tacks: the node and the garment's list, their rows, going with their pieces ------------------
{
    const r = addTack(nodes, { a: "p1", a_at: [10, 10], b: "p2", b_at: [250, 50] });
    assert.equal(r.id, "t1");
    assert.deepEqual(r.ops, [
        { op: "add", node: { id: "t1", kind: "garment.tack", a: "p1", b: "p2", a_at: [10, 10], b_at: [250, 50] } },
        { op: "set", id: "garment", fields: { tacks: ["t1"] } },
    ]);
    let n = m.withAdded(nodes, r.ops);
    n = m.withAdded(n, addTack(n, { a: "p2", a_at: [210, 10], b: "p2", b_at: [290, 10] }).ops);
    assert.deepEqual(m.byId(n).get("garment").tacks, ["t1", "t2"]);
    const sel = { kind: "tack", id: "t1" };
    const f = fieldsFor(sel, n, new Map());
    assert.deepEqual(keys(f), ["pieces", "a_at", "b_at", "remove"]);
    assert.equal(f[0].value, "Front – Back");
    assert.equal(fieldText(f[1]), "10, 10");
    assert.deepEqual(one(opsFor(sel, n, "a_at", [12, 14])), { a_at: [12, 14] });
    assert.match(validate(sel, n, "a_at", [1]), /two numbers/);
    assert.deepEqual(opsFor(sel, n, "remove", null), removeTack(n, "t1"));
    assert.deepEqual(removeTack(n, "t1"), [{ op: "set", id: "garment", fields: { tacks: ["t2"] } }, { op: "remove", id: "t1" }]);
    assert.deepEqual(removeTack(m.withAdded(n, removeTack(n, "t1")), "t2")[0].fields, { tacks: null }, "the last one out: no list");
    assert.deepEqual(tacksOn(n, ["p1"]), ["t1"]);
    // removing a piece takes its tacks; the other piece's own stay
    const gone = m.withAdded(n, m.removePattern(n, "p1"));
    assert.deepEqual(gone.filter((x) => x.kind === "garment.tack").map((x) => x.id), ["t2"]);
    assert.deepEqual(m.byId(gone).get("garment").tacks, ["t2"]);
    // a cut piece's tacks go with it
    const cut = m.replacePattern(n, "p2", [{ label: "Back A", path: m.rectPath(200, 0, 50, 100) }, { label: "Back B", path: m.rectPath(250, 0, 50, 100) }], { dropped: ["s1"] });
    const after = m.withAdded(n, cut.ops);
    assert.deepEqual(after.filter((x) => x.kind === "garment.tack"), [], "both tacks touched the cut piece");
    assert.equal(m.byId(after).get("garment").tacks, null);
}

// ---- the Simulation panel ---------------------------------------------------------------------
{
    assert.equal(OPTIONS.length, 20);
    assert.deepEqual(OPTION_NAMES.slice(0, 4), ["particle_distance", "frame_dt", "substeps", "iterations"]);
    const rows = optionFields(nodes);
    const row = (name, ns = nodes) => optionFields(ns).find((r) => r.name === name);
    assert.equal(rows.length, 20);
    assert.deepEqual([row("gravity.y").value, row("gravity.y").unit], [-9.8, "m/s²"], "friendly units");
    assert.deepEqual([row("frame_dt").value, row("air_density").value, row("sewing_stiffness").value], [33.33333, 1.225, 100]);
    assert.equal(row("self_collision").value, "yes");
    assert.ok(rows.every((r) => !r.set));
    // a change: the kernel's units, only the options away from the default
    let n = m.withAdded(nodes, optionOps(nodes, "gravity.y", -4.9));
    assert.deepEqual(m.byId(n).get("garment").sim_options, { "gravity.y": -4900 });
    assert.ok(row("gravity.y", n).set);
    n = m.withAdded(n, optionOps(n, "substeps", 60));
    n = m.withAdded(n, optionOps(n, "self_collision", "no"));
    assert.deepEqual(m.byId(n).get("garment").sim_options, { "gravity.y": -4900, substeps: 60, self_collision: 0 });
    assert.deepEqual(optionValues(n).slice(2, 7), [60, 1, 0, -4900, 0]);
    // back to the default drops it; the last one dropped leaves no param
    n = m.withAdded(n, optionOps(n, "gravity.y", -9.8));
    n = m.withAdded(n, optionOps(n, "self_collision", "yes"));
    assert.deepEqual(m.byId(n).get("garment").sim_options, { substeps: 60 });
    assert.deepEqual(resetOptionsOps(n), [{ op: "set", id: "garment", fields: { sim_options: null } }]);
    assert.deepEqual(resetOptionsOps(nodes), [], "nothing saved: nothing to reset");
    assert.deepEqual(optionOps(n, "substeps", 30), [{ op: "set", id: "garment", fields: { sim_options: null } }]);
    // checks
    assert.match(validateOption(nodes, "substeps", 2.5), /whole number/);
    assert.match(validateOption(nodes, "particle_distance", 2), /5 to 100/);
    assert.match(validateOption(nodes, "damping", -1), /not negative/);
    assert.match(validateOption(nodes, "self_stiffness", 2), /0 to 1/);
    assert.match(validateOption(nodes, "weld_distance", 2), /above the self thickness/);
    assert.match(validateOption(nodes, "self_thickness", 3), /above the self thickness/);
    assert.equal(validateOption(nodes, "self_thickness", 1), null);
    assert.match(validateOption(nodes, "gravity.y", NaN), /not a number/);
    assert.equal(validateOption(nodes, "self_collision", "no"), null);
    assert.match(validateOption(nodes, "nope", 1), /no option/);
}

// ---- what each edit does to a live cloth ------------------------------------------------------
{
    const after = (ops, ns = nodes) => garmentChange(ns, m.withAdded(ns, ops));
    const sel = (kind, id, index) => ({ kind, id, ...(index !== undefined ? { index } : {}) });
    // live: Freeze, pins, the options but the particle distance
    assert.deepEqual(after(opsFor(sel("pattern", "p1"), nodes, "frozen", "true")), { kind: "same" });
    assert.deepEqual(frozenChanges(nodes, m.withAdded(nodes, opsFor(sel("pattern", "p1"), nodes, "frozen", "true"))), [{ id: "p1", on: true }]);
    assert.deepEqual(after(pinOps(nodes, "p1", [5, 5], true)), { kind: "same" });
    assert.deepEqual(after(optionOps(nodes, "damping", 0.1)), { kind: "same" });
    assert.equal(optionsChanged(nodes, m.withAdded(nodes, optionOps(nodes, "damping", 0.1))), true);
    assert.equal(optionsChanged(nodes, nodes), false);
    assert.deepEqual(after(optionOps(nodes, "particle_distance", 15)), { kind: "stale", why: "the particle distance changed" });
    // re-meshed: a piece's numbers, its fold lines, a fabric's shrinkage, a seam's numbers, a tack's ends
    assert.deepEqual(after(opsFor(sel("pattern", "p1"), nodes, "strengthen", 2)), { kind: "remesh", patterns: ["p1"] });
    assert.deepEqual(after(opsFor(sel("pattern", "p2"), nodes, "pressure", 5)), { kind: "remesh", patterns: ["p2"] });
    assert.deepEqual(after(opsFor(sel("internal", "p1", 1), nodes, "angle", 90)), { kind: "remesh", patterns: ["p1"] });
    assert.deepEqual(after(opsFor(sel("internal", "p1", 0), nodes, "line_kind", "fold")), { kind: "remesh", patterns: ["p1"] });
    assert.deepEqual(after(opsFor(sel("internal", "p1", 0), nodes, "line_kind", "dart")), { kind: "same" }, "a plain line made a dart: drawn only");
    assert.deepEqual(after(opsFor(sel("fabric", "f_cotton_jersey"), nodes, "shrink_weft", 90)), { kind: "remesh", patterns: ["p1", "p2"] });
    assert.deepEqual(after(opsFor(sel("seam", "s1"), nodes, "strengthen", 4)), { kind: "remesh", patterns: ["p1", "p2"] });
    // elastics and tacks added or removed: a rebuild; their numbers: a re-mesh
    assert.equal(after(opsFor(sel("seam", "s1"), nodes, "elastic_ratio", 70)).kind, "stale");
    const el = m.withAdded(nodes, opsFor(sel("seam", "s1"), nodes, "elastic_ratio", 70));
    assert.deepEqual(after(opsFor(sel("seam", "s1"), el, "elastic_stiffness", 5), el), { kind: "remesh", patterns: ["p1", "p2"] });
    assert.deepEqual(after(opsFor(sel("internal", "p1", 0), nodes, "elastic_ratio", 70)), { kind: "stale", why: "Front's elastics changed" });
    const lel = m.withAdded(nodes, opsFor(sel("internal", "p1", 0), nodes, "elastic_ratio", 70));
    assert.deepEqual(after(opsFor(sel("internal", "p1", 0), lel, "elastic_ratio", 60), lel), { kind: "remesh", patterns: ["p1"] });
    const tack = addTack(nodes, { a: "p1", a_at: [10, 10], b: "p2", b_at: [250, 50] });
    assert.deepEqual(after(tack.ops), { kind: "stale", why: "the tacks changed" });
    const tacked = m.withAdded(nodes, tack.ops);
    assert.deepEqual(after(opsFor(sel("tack", "t1"), tacked, "a_at", [20, 20]), tacked), { kind: "remesh", patterns: ["p1", "p2"] });
    assert.deepEqual(after(removeTack(tacked, "t1"), tacked), { kind: "stale", why: "the tacks changed" });
    // the fabric's other numbers still rebuild
    assert.equal(after([{ op: "set", id: "f_cotton_jersey", fields: { density: 999 } }]).kind, "stale");
}
console.log("simprops: ok");
