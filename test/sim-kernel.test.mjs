// The simulation controls against the kernel: the panel's defaults are the kernel's; a garment
// with saved options, pins, a tack, a fold line, a frozen piece, shrinkage and a strengthened
// elastic seam is taken by the kernel, saves, reloads and saves again byte-equal; a cloth built
// from it starts from the saved options and pins (the pin map finds them), tacks and freezes;
// and live edits reach it: Freeze, the options, a re-mesh that keeps the saved pins.
import assert from "node:assert/strict";
import { loadKernel } from "./package.mjs";
import { Atelier } from "../kernel.js";
import { Drape } from "../cloth.js";
import * as m from "../model.js";
import { presetParams } from "../fabrics.js";
import { opsFor } from "../props.js";
import { pinOps } from "../simprops.js";
import { OPTIONS, optionOps } from "../simpanel.js";
import { addTack } from "../tacks.js";

const k = await loadKernel();
const f = (n) => k[`cadaclysm_blacksmith_${n}`];

// the panel's defaults are the kernel's (the f32 options to f32)
{
    const def = Array.from(f("cloth_default_options")());
    assert.equal(def.length, OPTIONS.length);
    OPTIONS.forEach((o, i) => assert.ok(Math.abs(Math.fround(o.def) - def[i]) <= 1e-9 * Math.max(1, Math.abs(def[i])), `${o.name}: ${o.def} against ${def[i]}`));
}

const a = new Atelier(k);
a.reset(m.newDocumentOps({ slug: "cotton_jersey", label: "Cotton jersey", params: presetParams("cotton_jersey") }));
let ops = m.addPattern(a.nodes(), { label: "Left", path: m.rectPath(0, 0, 200, 200), fabric: "f_cotton_jersey" }).ops;
a.apply(ops);
a.apply(m.addPattern(a.nodes(), { label: "Right", path: m.rectPath(300, 0, 200, 200), fabric: "f_cotton_jersey" }).ops);
a.apply(m.addSeam(a.nodes(), { a: "p1", b: "p2", a_from: 200, a_to: 400, b_from: 600, b_to: 800, reversed: true }).ops);
const sel = (kind, id, index) => ({ kind, id, ...(index !== undefined ? { index } : {}) });
const edit = (selection, key, value) => a.apply(opsFor(selection, a.nodes(), key, value), `set ${key}`);
// a fold line at 90 degrees across the left piece
a.apply(m.addInternal(a.nodes(), "p1", { start: [100, 10], segments: [{ type: "line", to: [100, 190] }] }, "fold"));
edit(sel("internal", "p1", 0), "angle", 90);
edit(sel("internal", "p1", 0), "fold_strength", 2);
// a tack from the left piece to the right one, a pin on the left, the right frozen
a.apply(addTack(a.nodes(), { a: "p1", a_at: [50, 150], b: "p2", b_at: [350, 150] }).ops);
a.apply(pinOps(a.nodes(), "p1", [20, 180], true));
edit(sel("pattern", "p2"), "frozen", "true");
edit(sel("pattern", "p1"), "strengthen", 2);
edit(sel("pattern", "p1"), "pressure", 3);
edit(sel("fabric", "f_cotton_jersey"), "shrink_weft", 95);
edit(sel("seam", "s1"), "strengthen", 3);
edit(sel("seam", "s1"), "elastic_ratio", 90);
// saved options
a.apply(optionOps(a.nodes(), "substeps", 20));
a.apply(optionOps(a.nodes(), "gravity.y", -5));
assert.deepEqual(a.problems(), [], "the kernel takes every control");
assert.deepEqual(a.issues().filter((i) => i.severity === "error"), []);

// the garment carries them: options, pins, the tack, the fold, the frozen piece, strength
const pid = (id) => a.patternIndex(id);
{
    const so = Array.from(f("garment_sim_options")(a.g));
    assert.equal(so[2], 20);
    assert.equal(so[5], -5000);
    assert.ok(so.filter((x) => !Number.isNaN(x)).length === 2, "the other options unset");
    assert.deepEqual(Array.from(f("garment_pins")(a.g)), [pid("p1"), 20, 180]);
    assert.deepEqual(Array.from(f("garment_fold")(a.g, pid("p1"), 0)), [90, 2]);
    assert.deepEqual(Array.from(f("garment_piece_sim")(a.g, pid("p2"))), [1, 1, 0]);
    assert.deepEqual(Array.from(f("garment_piece_sim")(a.g, pid("p1"))), [0, 2, 3]);
    assert.ok(f("garment_tacks")(a.g).length > 0, "one tack");
}

// save -> open: the same nodes; open -> save -> open -> save: the same text (a save carries the
// history, which an open starts afresh)
const text = a.save();
const b = new Atelier(k);
b.load(text);
// (the open anchors the seam to its sides: app data, meta.atelier)
const bare = (nodes) => nodes.map(({ meta, ...n }) => n);
assert.deepEqual(bare(b.nodes()), bare(a.nodes()), "the same nodes after a reload");
{
    const c = new Atelier(k);
    c.load(b.save());
    assert.equal(c.save(), b.save(), "saves byte-equal after a reload");
    c.free();
}
assert.deepEqual(b.problems(), []);
assert.deepEqual(m.byId(b.nodes()).get("garment").sim_options, { substeps: 20, "gravity.y": -5000 });
assert.deepEqual(m.byId(b.nodes()).get("p1").pins, [[20, 180]]);
assert.deepEqual(b.nodes().filter((n) => n.kind === "garment.tack").map((n) => [n.a, n.b, n.a_at, n.b_at]), [["p1", "p2", [50, 150], [350, 150]]]);

// a cloth from it: the saved options (gravity off while sewing), the saved pin in the pin map,
// the tack sewn, the right piece frozen
const drape = new Drape(k);
drape.build(text);
const kid = (id) => drape.kernelPattern(id);
{
    const o = Array.from(f("cloth_options")(drape.h));
    assert.equal(o[2], 20, "substeps from the document");
    assert.deepEqual(o.slice(4, 7), [0, 0, 0], "sewing: gravity off");
    assert.deepEqual(Array.from(drape.gravity), [0, -5000, 0], "the saved gravity kept for the drape");
    assert.equal(drape.pins.size, 1, "the saved pin is in the pin map");
    const [v, link] = [...drape.pins][0];
    assert.equal(link[0], kid("p1"));
    assert.ok(Math.hypot(link[1] - 20, link[2] - 180) < 1e-6, `the pin's vertex is the saved point: ${link}`);
    assert.equal(drape.pinPositions().length, 3);
    assert.deepEqual(drape.pinPlace(v), { pattern: "p1", at: [link[1], link[2]] });
    assert.equal(f("cloth_tack_pairs")(drape.h), 1, "the tack is a sewing pair");
    assert.equal(f("cloth_is_frozen")(drape.h, kid("p2")), true);
    assert.equal(f("cloth_is_frozen")(drape.h, kid("p1")), false);
}
// a few frames: the pinned point and the frozen piece stay put
{
    const p0 = drape.positions().slice();
    const [v] = [...drape.pins.keys()];
    for (let i = 0; i < 3; i++) drape.step();
    const p1 = drape.positions();
    assert.deepEqual([...p1.subarray(3 * v, 3 * v + 3)], [...p0.subarray(3 * v, 3 * v + 3)], "the saved pin holds");
    const vp = f("cloth_vertex_patterns")(drape.h);
    let moved = 0;
    vp.forEach((p, i) => { if (p === kid("p2") && Math.hypot(p1[3 * i] - p0[3 * i], p1[3 * i + 1] - p0[3 * i + 1], p1[3 * i + 2] - p0[3 * i + 2]) > 0) moved++; });
    assert.equal(moved, 0, "the frozen piece does not move");
}

// live edits: unfreeze, an option, a re-mesh keeping the saved pin
{
    edit(sel("pattern", "p2"), "frozen", "false");
    let r = drape.update(a.save());
    assert.deepEqual([r.kind, r.remeshed], ["same", false]);
    assert.equal(f("cloth_is_frozen")(drape.h, kid("p2")), false, "unfrozen at once");
    a.apply(optionOps(a.nodes(), "damping", 0.05));
    r = drape.update(a.save());
    assert.equal(r.kind, "same");
    const o = Array.from(f("cloth_options")(drape.h));
    assert.ok(Math.abs(o[7] - 0.05) < 1e-7, `damping applied live: ${o[7]}`);
    assert.equal(o[2], 20);
    edit(sel("pattern", "p1"), "strengthen", 4);
    r = drape.update(a.save());
    assert.deepEqual([r.kind, r.patterns, r.remeshed], ["remesh", ["p1"], true]);
    assert.equal(drape.pins.size, 1, "the saved pin found again on the re-meshed piece");
    const [, link] = [...drape.pins][0];
    assert.ok(Math.hypot(link[1] - 20, link[2] - 180) < 1e-6);
    // a new particle distance is a rebuild
    a.apply(optionOps(a.nodes(), "particle_distance", 15));
    r = drape.update(a.save());
    assert.deepEqual([r.kind, drape.stale], ["stale", "the particle distance changed"]);
}

// a pin made on the cloth, saved, and a fresh cloth pins it again
{
    const fresh = new Drape(k);
    a.apply(optionOps(a.nodes(), "particle_distance", 20));
    fresh.build(a.save());
    const vp = f("cloth_vertex_patterns")(fresh.h);
    const v = vp.findIndex((p) => p === fresh.kernelPattern("p1") && ![...fresh.pins.keys()].includes(vp.indexOf(p)));
    const target = [...vp.keys()].find((i) => vp[i] === fresh.kernelPattern("p1") && !fresh.pins.has(i) && i > v);
    const place = fresh.pinPlace(target);
    assert.equal(fresh.togglePin(target), true);
    a.apply(pinOps(a.nodes(), place.pattern, place.at, true));
    const again = new Drape(k);
    again.build(a.save());
    assert.equal(again.pins.size, 2, "both saved pins pinned on a new cloth");
    // let go: the saved pin goes
    const off = pinOps(a.nodes(), place.pattern, place.at, false);
    assert.equal(off[0].fields.pins.length, 1);
    fresh.free(); again.free();
}
drape.free();
a.free(); b.free();
console.log("sim-kernel: ok");
