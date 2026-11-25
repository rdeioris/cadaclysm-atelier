// The 2D ruler (spec §7) against the real kernel: the measure between two points, a side's arc
// length from the drawing's side table, the Ruler tool's measures (kept until Escape or a tool
// change, across fresh tools) and the Edit tool's hover read-out over an edge.
import assert from "node:assert/strict";
import { loadKernel } from "./package.mjs";
import { Atelier } from "../kernel.js";
import * as m from "../model.js";
import { makeTool, measureBetween, measureSide, sideLength, sideReadout, mmText, SNAPPING } from "../tools.js";
import { SHORTCUTS, toolOfKey } from "../shortcuts.js";

const k = await loadKernel();
const params = Object.fromEntries(m.FABRIC_FIELDS.map((n) => [n, 1]));
const a = new Atelier(k);
a.reset(m.newDocumentOps({ slug: "x", label: "X", params }));
a.apply(m.addPattern(a.nodes(), { label: "Front", path: m.rectPath(0, 0, 100, 50), fabric: "f_x" }).ops, "rect");
// a piece with a curved side: a quarter-ellipse-like cubic from (200, 0) to (300, 100)
a.apply(m.addPattern(a.nodes(), { label: "Curve", path: m.polyPath([[200, 0], [300, 0], [300, 100]], [null, null, { c1: [250, 100], c2: [200, 50] }]), fabric: "f_x" }).ops, "curve");
const drawings = new Map(a.drawings().map((d) => [d.id, d]));
const close = (x, y, tol, what) => assert.ok(Math.abs(x - y) <= tol, `${what}: ${x} vs ${y}`);

// two points: the straight distance, to 0.1 mm in the label
{
    const q = measureBetween([0, 0], [30, 40]);
    assert.equal(q.length, 50);
    assert.equal(q.text, "50.0 mm");
    assert.deepEqual(q.line, [[0, 0], [30, 40]]);
    assert.deepEqual(q.at, [15, 20]);
    assert.equal(measureBetween([1, 1], [1.04, 1]).text, "0.0 mm");
    assert.equal(mmText(123.456), "123.5 mm");
}
// a side: its arc length from the kernel's side table, drawn along the outline's samples
{
    const d = drawings.get("p1");
    close(sideLength(d, 0), 100, 1e-6, "the bottom side");
    close(sideLength(d, 1), 50, 1e-6, "the right side");
    close(sideLength(d, 3), 50, 1e-6, "the closing side");
    assert.equal(sideLength(d, 4), null, "no fifth side");
    assert.equal(sideLength(d, -1), null);
    assert.equal(sideLength(undefined, 0), null);
    const q = measureSide(d, 1);
    assert.equal(q.text, "50.0 mm");
    assert.ok(q.line.length >= 40, "drawn along the samples");
    assert.ok(q.line.every(([x]) => Math.abs(x - 100) < 1e-6), "on the right side");
    const last = measureSide(d, 3);
    assert.deepEqual(last.line.at(-1).map((v) => Math.round(v * 1e6) / 1e6 + 0), [0, 0], "the closing side ends on the first sample");
    // the curved side: the kernel's arc length, longer than its chord
    const c = drawings.get("p2");
    const curved = sideLength(c, 2);
    assert.ok(curved > Math.hypot(100, 100) + 1, `the curve's arc length ${curved} exceeds its chord`);
    const sum = [0, 1, 2].reduce((s, i) => s + sideLength(c, i), 0);
    close(sum, c.sides.at(-1), 1e-9, "the sides add up to the perimeter");
}
// the Edit tool's hover read-out: once per side, off an edge nothing
{
    assert.equal(sideReadout(drawings, { kind: "edge", id: "p1", side: 0, s: 40 }), "Front side 1: 100.0 mm");
    assert.equal(sideReadout(drawings, { kind: "pattern", id: "p1" }), null);
    const t = makeTool("edit", { nodes: a.nodes(), drawings, selection: null, request: async () => ({}) });
    assert.deepEqual(t.move([50, 0], { kind: "edge", id: "p1", side: 0, s: 50 }, {}), { status: "Front side 1: 100.0 mm", error: false });
    assert.deepEqual(t.move([60, 0], { kind: "edge", id: "p1", side: 0, s: 60 }, {}), {}, "the same side: said once");
    assert.equal(t.move([100, 20], { kind: "edge", id: "p1", side: 1, s: 120 }, {}).status, "Front side 2: 50.0 mm");
    assert.deepEqual(t.move([50, 25], { kind: "pattern", id: "p1" }, {}), {});
    assert.equal(t.move([100, 20], { kind: "edge", id: "p1", side: 1, s: 120 }, {}).status, "Front side 2: 50.0 mm", "back on it: said again");
}
// the Ruler tool: two clicks, an edge click, Shift's lock is the snapping's (it snaps), Escape clears
{
    assert.ok(SNAPPING.has("ruler"), "the Ruler snaps");
    assert.equal(SHORTCUTS.R.tool, "ruler");
    assert.deepEqual(toolOfKey({ key: "r" }), { tool: "ruler" });
    const keep = {};
    const ctx = { nodes: a.nodes(), drawings, selection: null, keep, request: async () => ({}) };
    let t = makeTool("ruler", ctx);
    const click = (p, h = null, mods = {}) => { t.down(p, h, mods); return t.up(p, h, mods); };
    assert.deepEqual(click([10, 10]).overlay.points, [[10, 10]]);
    assert.deepEqual(t.lastPoint(), [10, 10], "the read-out and the Shift lock measure from the first click");
    assert.deepEqual(t.move([40, 50], null, {}).overlay.lines.at(-1), [[10, 10], [40, 50]], "the rubber band");
    const r = click([40, 50]);
    assert.equal(r.status, "ruler: 50.0 mm");
    assert.equal(r.error, false);
    assert.deepEqual(r.overlay.labels, [{ at: [25, 30], text: "50.0 mm" }]);
    assert.equal(t.lastPoint(), null);
    // a click on an edge, not snapped to a point: that side's length
    const e = click([100, 25], { kind: "edge", id: "p1", side: 1, s: 125 }, { snap: "edge" });
    assert.equal(e.status, "side 2: 50.0 mm");
    assert.deepEqual(e.overlay.labels.map((l) => l.text), ["50.0 mm", "50.0 mm"]);
    // snapped to the side's midpoint: still the side
    assert.equal(click([100, 25], { kind: "edge", id: "p1", side: 1, s: 125 }, { snap: "midpoint" }).status, "side 2: 50.0 mm");
    keep.measures.pop();
    // a click on an edge snapped to its corner: a point, the start of a two-click measure
    const c = click([100, 50], { kind: "edge", id: "p1", side: 1, s: 150 }, { snap: "vertex" });
    assert.equal(c.status, undefined);
    assert.deepEqual(t.lastPoint(), [100, 50]);
    click([100, 0], null, {});
    assert.equal(keep.measures.length, 3);
    // a document change makes a fresh tool: the measures stay (the app keeps `keep` while the Ruler is armed)
    t = makeTool("ruler", { ...ctx });
    const p = (click([0, 0]), click([0, 0]));
    assert.equal(keep.measures.length, 3, "a zero-length measure is no measure");
    assert.equal(p.overlay.labels.length, 3, "the measures still drawn by the fresh tool");
    const esc = t.key("Escape");
    assert.equal(esc.done, true);
    assert.deepEqual(esc.overlay, { lines: [] });
    assert.equal(keep.measures.length, 0, "Escape clears them");
}
a.free();
console.log("ruler-kernel: ok");
