// trims.js without the kernel: the records, the ops that add, edit and remove them (fastenings
// re-pointed or dropped with their tacks), an internal line's removal, the panel's rows and
// checks, the tools' gestures and the 2D drawing from kernel-style instances.
import assert from "node:assert/strict";
import * as T from "../trims.js";
import { TEMPLATE } from "../trimgeo.js";
import { makeTool, SNAPPING } from "../tools.js";
import { hitOf } from "../view2d.js";
import { fieldsFor, validate, opsFor } from "../props.js";
import { garmentChange } from "../drape.js";
import { simOps } from "../simprops.js";
import { pieceOps, convertToHole } from "../model.js";

// a garment of two pieces, a seam and a fastening between piece p1's button (trims[1]) and p2's
// buttonhole (trims[0])
const button = T.buttonRecord([10, 20]), hole = T.buttonholeRecord([30, 40]);
const stitch = T.topstitchRecord({ pattern: "p1", loop: 0, from: 0, to: 100 });
const lineStitch = T.topstitchRecord({ pattern: "p1", index: 1 });
const nodes = () => [
    { id: "garment", kind: "garment.garment", patterns: ["p1", "p2"], seams: ["s1"], tacks: ["t1"] },
    { id: "p1", kind: "garment.pattern", label: "Front", outline: "p1_outline", trims: [stitch, button, lineStitch],
        internal: [{ kind: "line", path: { start: [0, 0], segments: [{ type: "line", to: [5, 5] }] } }, { kind: "line", path: { start: [1, 0], segments: [{ type: "line", to: [6, 5] }] } }] },
    { id: "p1_outline", kind: "profile.path", path: { start: [0, 0], segments: [] } },
    { id: "p2", kind: "garment.pattern", label: "Back", outline: "p2_outline", trims: [hole] },
    { id: "p2_outline", kind: "profile.path", path: { start: [0, 0], segments: [] } },
    { id: "s1", kind: "garment.seam", a: "p1", b: "p2", a_from: 0, a_to: 10, b_from: 0, b_to: 10, reversed: false },
    { id: "t1", kind: "garment.tack", a: "p1", b: "p2", a_at: [10, 20], b_at: [30, 40], fastens: [1, 0] },
];
const apply = (ns, ops) => {
    let out = ns.map((n) => ({ ...n }));
    for (const o of ops) {
        if (o.op === "set") out = out.map((n) => (n.id === o.id ? Object.fromEntries(Object.entries({ ...n, ...o.fields }).filter(([, v]) => v !== null)) : n));
        else if (o.op === "add") out.push(o.node);
        else if (o.op === "remove") out = out.filter((n) => n.id !== o.id);
    }
    return out;
};
const node = (ns, id) => ns.find((n) => n.id === id);

// records: the document's form (kinds/garment.rs)
assert.deepEqual(Object.keys(stitch), ["kind", "on", "from", "to", "offset", "stitch_length", "thread", "rows", "gap", "colour"]);
assert.equal(T.topstitchRecord({ pattern: "p1", loop: 2, from: 0, to: 5 }).loop, 2);
assert.deepEqual(Object.keys(lineStitch), ["kind", "on", "index", "offset", "stitch_length", "thread", "rows", "gap", "colour"]);
assert.equal(lineStitch.offset, 0);
assert.deepEqual(Object.keys(button), ["kind", "at", "diameter", "thickness", "holes", "colour", "mass"]);
assert.deepEqual(Object.keys(hole), ["kind", "at", "angle", "length", "colour"]);
assert.ok(T.BUTTONHOLE_DEFAULT.length >= T.BUTTON_DEFAULT.diameter + 2, "the default hole takes the default button");
assert.equal(T.hexOf([1, 0.5, 0]), "#ff8000");
assert.deepEqual(T.rgbOf("#ff8000"), [1, 0.501961, 0]);
assert.equal(T.rgbOf("red"), null);
assert.equal(T.trimName(node(nodes(), "p1"), 1), "Button 1");
assert.equal(T.trimName(node(nodes(), "p1"), 2), "Topstitch 2");
assert.equal(T.fastenerOf(nodes(), "p1", 1).id, "t1");
assert.equal(T.fastenerOf(nodes(), "p2", 0).id, "t1");
assert.equal(T.fastenerOf(nodes(), "p1", 0), null);
console.log("ok - records");

// removing a trim before the button re-points the fastening; removing the button drops the tack
{
    let ns = apply(nodes(), T.removeTrimOps(nodes(), "p1", 0));
    assert.equal(node(ns, "p1").trims.length, 2);
    assert.deepEqual(node(ns, "t1").fastens, [0, 0]);
    ns = apply(nodes(), T.removeTrimOps(nodes(), "p1", 1));
    assert.equal(node(ns, "t1"), undefined, "the fastening's tack goes with its button");
    assert.deepEqual(node(ns, "garment").tacks, undefined, "an empty tacks list is no param");
    ns = apply(nodes(), T.removeTrimOps(nodes(), "p2", 0));
    assert.equal(node(ns, "p2").trims, undefined, "the last trim gone: no trims param");
    assert.equal(node(ns, "t1"), undefined);
    assert.throws(() => T.removeTrimOps(nodes(), "p1", 9), /gone/);
    console.log("ok - remove re-points or drops fastenings");
}
// an internal line removed: topstitch along it dropped, along a later line re-pointed
{
    let ns = apply(nodes(), T.lineRemovedOps(nodes(), "p1", 0));
    assert.equal(node(ns, "p1").trims[2].index, 0, "line 1 is line 0 now");
    ns = apply(nodes(), T.lineRemovedOps(nodes(), "p1", 1));
    assert.equal(node(ns, "p1").trims.length, 2);
    assert.deepEqual(T.lineRemovedOps(nodes(), "p2", 0), [], "no topstitch on an internal line: no ops");
    // the panel's Remove line takes the topstitch along; Convert to hole does too
    const sel = { kind: "internal", id: "p1", index: 1 };
    ns = apply(nodes(), simOps(sel, nodes(), "remove", null));
    assert.equal(node(ns, "p1").internal.length, 1);
    assert.equal(node(ns, "p1").trims.length, 2);
    console.log("ok - an internal line's topstitch follows its removal");
}
// fasten: a tack from the button's centre to the hole's, with `fastens`
{
    const ns0 = apply(nodes(), [{ op: "remove", id: "t1" }, { op: "set", id: "garment", fields: { tacks: null } }]);
    const r = T.fastenOps(ns0, { id: "p1", index: 1 }, { id: "p2", index: 0 });
    const t = r.ops[0].node;
    assert.deepEqual([t.a, t.a_at, t.b, t.b_at, t.fastens], ["p1", [10, 20], "p2", [30, 40], [1, 0]]);
    assert.throws(() => T.fastenOps(nodes(), { id: "p1", index: 1 }, { id: "p2", index: 0 }), /already fastened/);
    assert.throws(() => T.fastenOps(ns0, { id: "p1", index: 0 }, { id: "p2", index: 0 }), /not on a button/);
    console.log("ok - fasten");
}
// the panel: a button's rows, an edit of its centre moves its fastening's tack end; a zipper's rows
{
    const sel = { kind: "trim", id: "p1", index: 1 };
    const keys = fieldsFor(sel, nodes(), new Map()).map((f) => f.key);
    assert.deepEqual(keys, ["at", "diameter", "thickness", "holes", "mass", "fastened", "colour", "remove"]);
    assert.equal(validate(sel, nodes(), "diameter", -1), "diameter is above 0 (and at most 1000)");
    assert.equal(validate(sel, nodes(), "holes", "3"), "a button has 0, 2 or 4 holes");
    assert.equal(validate(sel, nodes(), "colour", "#123456"), null);
    let ns = apply(nodes(), opsFor(sel, nodes(), "at", [11, 21]));
    assert.deepEqual(node(ns, "p1").trims[1].at, [11, 21]);
    assert.deepEqual(node(ns, "t1").a_at, [11, 21], "the tack end follows the button");
    ns = apply(nodes(), opsFor(sel, nodes(), "colour", "#ff0000"));
    assert.deepEqual(node(ns, "p1").trims[1].colour, [1, 0, 0]);
    const hsel = { kind: "trim", id: "p2", index: 0 };
    ns = apply(nodes(), opsFor(hsel, nodes(), "angle", 90));
    assert.ok(Math.abs(node(ns, "p2").trims[0].angle - Math.PI / 2) < 1e-6, "the panel's degrees are stored as radians");
    assert.equal(fieldsFor(hsel, ns, new Map()).find((f) => f.key === "angle").value, 90);
    const ssel = { kind: "trim", id: "p1", index: 0 };
    assert.deepEqual(fieldsFor(ssel, nodes(), new Map()).map((f) => f.key), ["on", "offset", "stitch_length", "thread", "rows", "gap", "colour", "remove"]);
    ns = apply(nodes(), opsFor(ssel, nodes(), "rows", "2"));
    assert.equal(node(ns, "p1").trims[0].rows, 2);
    // the seam: no zipper rows until it has one
    const seam = { kind: "seam", id: "s1" };
    assert.ok(!fieldsFor(seam, nodes(), new Map()).some((f) => f.key.startsWith("zipper_")));
    ns = apply(nodes(), T.zipperOps("s1", T.zipperRecord()));
    assert.ok(fieldsFor(seam, ns, new Map()).some((f) => f.key === "zipper_tooth_pitch"));
    assert.equal(validate(seam, ns, "zipper_stiffness", 0.5), "a zipper's stiffness is from 1 to 1000");
    const ns2 = apply(ns, opsFor(seam, ns, "zipper_tooth_pitch", 6));
    assert.equal(node(ns2, "s1").zipper.tooth_pitch, 6);
    assert.equal(node(apply(ns, opsFor(seam, ns, "zipper_remove", null)), "s1").zipper, undefined);
    // a panel edit is the tool's next
    const next = T.trimDefaults();
    T.rememberTrim(next, "button", "diameter", 20);
    T.rememberTrim(next, "seam", "zipper_tooth_pitch", 7);
    T.rememberTrim(next, "buttonhole", "angle", 90);
    assert.deepEqual([next.button.diameter, next.zipper.tooth_pitch, +next.buttonhole.angle.toFixed(6)], [20, 7, +(Math.PI / 2).toFixed(6)]);
    console.log("ok - the panel");
}
// the cloth: a trim, a zipper or a fastening changed makes it stale
{
    const ns = nodes();
    assert.equal(garmentChange(ns, apply(ns, T.removeTrimOps(ns, "p1", 0))).kind, "stale");
    assert.equal(garmentChange(ns, apply(ns, T.zipperOps("s1", T.zipperRecord()))).kind, "stale");
    assert.equal(garmentChange(ns, apply(ns, [{ op: "set", id: "t1", fields: { fastens: [0, 0] } }])).kind, "stale");
    console.log("ok - trim edits make the cloth stale");
}
// a moved piece takes its trims (the kernel maps them: kernel.js trimsThrough) and its fastening's tack end
{
    const r = { path: { start: [0, 0], segments: [] }, trims: [stitch, { ...button, at: [15, 20] }, lineStitch], matrix: [1, 0, 5, 0, 1, 0] };
    const ns = apply(nodes(), pieceOps(nodes(), "p1", r));
    assert.deepEqual(node(ns, "p1").trims[1].at, [15, 20]);
    assert.deepEqual(node(ns, "t1").a_at, [15, 20]);
    console.log("ok - a moved piece's trims");
}

// the tools
{
    // p1's outline samples (s, x, y): (0,0) -> (100,0) -> (100,150) -> (-50,150), sides at those points
    const samples = [0, 0, 0, 100, 100, 0, 250, 100, 150, 400, -50, 150];
    const drawings = new Map([["p1", { samples, sides: [0, 100, 250, 400], holes: [{ sides: [0, 30, 60] }] }]]);
    const ctx = { nodes: nodes(), drawings, pxToWorld: 1, trimNext: T.trimDefaults() };
    // Topstitch: a click on an edge stitches its side
    let t = makeTool("topstitch", ctx);
    t.down([5, 0], { kind: "edge", id: "p1", s: 120, side: 1 });
    let r = t.up([5, 0], { kind: "edge", id: "p1", s: 120, side: 1 });
    assert.deepEqual([r.trim.action, r.trim.id, r.trim.record.from, r.trim.record.to, r.trim.record.loop], ["add", "p1", 100, 250, undefined]);
    // a drag along it a stretch, its end from the outline under the pointer: the release is
    // picked as the piece (the line drawn to the pointer is on top), not as the edge
    t.down([100, 30], { kind: "edge", id: "p1", s: 130, side: 1 });
    r = t.up([101, 80], { kind: "pattern", id: "p1" });
    assert.deepEqual([r.trim.record.from, r.trim.record.to], [130, 180]);
    t.down([100, 80], { kind: "edge", id: "p1", s: 180, side: 1 });
    r = t.up([100, 30], null);
    assert.deepEqual([r.trim.record.from, r.trim.record.to], [130, 180], "dragged back");
    // released far from the edge: the pressed side
    t.down([100, 30], { kind: "edge", id: "p1", s: 130, side: 1 });
    r = t.up([40, 70], { kind: "pattern", id: "p1" });
    assert.deepEqual([r.trim.record.from, r.trim.record.to], [100, 250]);
    // a hole's side its loop
    t.down([0, 0], { kind: "hole", id: "p1", index: 0, loop: 1, s: 40, side: 1 });
    r = t.up([0, 0], { kind: "hole", id: "p1", index: 0, loop: 1, s: 40, side: 1 });
    assert.deepEqual([r.trim.record.loop, r.trim.record.from, r.trim.record.to], [1, 30, 60]);
    // an internal line
    r = t.down([0, 0], { kind: "internal", id: "p1", index: 1 });
    assert.deepEqual([r.trim.record.on, r.trim.record.index], ["internal", 1]);
    assert.match(t.down([0, 0], null).status, /click an edge/);
    // Button and Buttonhole: a click on a piece; the numbers last chosen
    ctx.trimNext.button.diameter = 20;
    r = makeTool("button", ctx).down([7, 8], { kind: "pattern", id: "p2" });
    assert.deepEqual([r.trim.id, r.trim.record.kind, r.trim.record.at, r.trim.record.diameter], ["p2", "button", [7, 8], 20]);
    r = makeTool("buttonhole", ctx).down([7, 8], { kind: "trim", id: "p1", index: 0 });
    assert.deepEqual([r.trim.id, r.trim.record.kind], ["p1", "buttonhole"]);
    assert.match(makeTool("button", ctx).down([0, 0], null).status, /click on a piece/);
    // Fasten: a button then a buttonhole (or the other way round)
    const ns0 = apply(nodes(), [{ op: "remove", id: "t1" }]);
    t = makeTool("fasten", { ...ctx, nodes: ns0 });
    assert.match(t.down([0, 0], { kind: "pattern", id: "p1" }).status, /click a button/);
    assert.deepEqual(t.down([0, 0], { kind: "trim", id: "p2", index: 0 }).overlay.points, [[30, 40]], "a marker on the first");
    // nothing drawn to the pointer: an overlay under it would be picked ahead of the second trim
    assert.deepEqual(t.move([25, 35], { kind: "pattern", id: "p2" }), {});
    assert.match(t.down([0, 0], { kind: "trim", id: "p2", index: 0 }).status, /buttonhole too/);
    r = t.down([0, 0], { kind: "trim", id: "p1", index: 1 });
    assert.deepEqual(r.trim, { action: "fasten", button: { id: "p1", index: 1 }, hole: { id: "p2", index: 0 } });
    // Zipper: a click on a seam
    r = makeTool("zipper", ctx).down([0, 0], { kind: "edge", id: "p1", s: 5, side: 0, seam: "s1" });
    assert.deepEqual([r.trim.action, r.trim.seam, r.trim.zipper.tooth_pitch, r.select.id], ["zipper", "s1", 5, "s1"]);
    assert.match(makeTool("zipper", ctx).down([0, 0], { kind: "pattern", id: "p1" }).status, /click a seam/);
    assert.ok(SNAPPING.has("button") && !SNAPPING.has("fasten"));
    // the Edit tool selects a trim, and a zipper's seam
    const edit = makeTool("edit", ctx);
    assert.deepEqual(edit.down([0, 0], { kind: "trim", id: "p1", index: 1 }).select, { kind: "trim", id: "p1", index: 1 });
    assert.deepEqual(edit.down([0, 0], { kind: "zipper", id: "s1", pattern: "p1" }).select, { kind: "seam", id: "s1" });
    // another tool reads a trim's pick as its piece
    const fold = makeTool("fold", ctx);
    fold.up([0, 0], { kind: "trim", id: "p1", index: 0 });
    fold.up([10, 0], { kind: "pattern", id: "p1" });
    assert.equal(fold.key("Enter").select.id, "p1");
    // hits: a trim's item and a zipper's
    assert.deepEqual(hitOf({ kind: "trim", id: "p1", index: 2 }, { point: [0, 0, 0] }, drawings), { kind: "trim", id: "p1", index: 2 });
    assert.deepEqual(hitOf({ kind: "zipper", id: "s1", pattern: "p2" }, { point: [0, 0, 0] }, drawings), { kind: "zipper", id: "s1", pattern: "p2" });
    console.log("ok - the tools");
}

// the 2D drawing from kernel-style instances
{
    const inst = (ref, pattern, template, size, x = 0, y = 0, angle = 0) => ({ ref, pattern, x, y, angle, template, size });
    const segs = T.instanceSegments(inst(null, "p1", TEMPLATE.STITCH, [1.8, 0.6, 0], 10, 5, Math.PI / 2));
    assert.deepEqual(segs.map((v) => +v.toFixed(6)), [10, 4.1, 10, 5.9], "a stitch is a dash along its direction");
    assert.equal(T.instanceSegments(inst(null, "p1", TEMPLATE.BUTTON, [15, 3, 4])).length, 4 * (20 + 4 * 6), "a button's rim and four holes");
    assert.equal(T.instanceSegments(inst(null, "p1", TEMPLATE.BUTTON, [15, 3, 0])).length, 4 * 20);
    assert.equal(T.instanceSegments(inst(null, "p1", TEMPLATE.TAPE, [12, 5, 0.6])).length, 8, "a tape's two long sides");
    const layout = { instances: [
        inst({ kind: "trim", id: "p1", index: 0 }, "p1", TEMPLATE.STITCH, [1.8, 0.6, 0], 0, 0),
        inst({ kind: "trim", id: "p1", index: 0 }, "p1", TEMPLATE.STITCH, [1.8, 0.6, 0], 3, 0),
        inst({ kind: "trim", id: "p1", index: 1 }, "p1", TEMPLATE.BUTTON, [15, 3, 4], 10, 20),
        inst({ kind: "zipper", id: "s1" }, "p2", TEMPLATE.TOOTH, [5, 5, 3]),
        inst({ kind: "tack", id: "t1" }, "p1", TEMPLATE.STITCH, [1, 1, 0]),
    ] };
    const specs = T.trimSpecs({ layout, drawings: [{}, {}], nodes: nodes(), selection: { kind: "trim", id: "p1", index: 1 } });
    assert.deepEqual(specs.map((s) => s.key), ["trim/p1/0", "trim/p1/1", "zip/s1"], "one item a trim; a fastening is its tack's drawing");
    assert.equal(specs[0].data.length, 12, "two stitches, one dash each");
    assert.deepEqual(specs[1].what, { kind: "trim", id: "p1", index: 1 });
    assert.deepEqual(specs[2].what, { kind: "zipper", id: "s1", pattern: "p2" });
    assert.equal(specs[1].colour, "#ff7a1a", "the selected trim in the accent");
    assert.equal(specs[0].colour, T.TRIM_2D.stitch);
    assert.equal(T.trimSpecs({ layout: { instances: [] } }).length, 0);
    console.log("ok - the 2D drawing");
}
// the 3D look: one template per kind, size and colour; the zipper's teeth and slider metal
{
    const row = [7, 1, 0, 0, 0, 0, TEMPLATE.TOOTH, 5, 5, 3, 0.1, 0.2, 0.3, 0.05];
    const other = [...row]; other[10] = 0.9;
    assert.notEqual(T.lookKey(row, 0), T.lookKey(other, 0), "another colour, another template");
    assert.ok(T.isMetal(TEMPLATE.TOOTH) && T.isMetal(TEMPLATE.SLIDER) && !T.isMetal(TEMPLATE.TAPE) && !T.isMetal(TEMPLATE.BUTTON));
    console.log("ok - the 3D look keys");
}
// Convert to hole drops topstitch along the converted line
{
    const ns = nodes();
    node(ns, "p1").internal[1] = { kind: "line", path: { start: [0, 0], segments: [{ type: "line", to: [5, 0] }, { type: "line", to: [5, 5] }, { type: "line", to: [0, 0] }] } };
    const out = apply(ns, convertToHole(ns, "p1", 1));
    assert.equal(node(out, "p1").trims.length, 2);
    console.log("ok - Convert to hole");
}
