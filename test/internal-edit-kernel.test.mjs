// Curved internal lines (spec §4) against the real kernel: the Internal tool draws as the Polygon
// tool does (a drag is a curve point with mirrored handles), open, ended by Enter or a double
// click; the Edit tool drags an internal line's points and handles through the scene's item map
// (internalPointsOf, hitOf), each drag one preview and one commit (one undo step).
import assert from "node:assert/strict";
import { loadKernel } from "./package.mjs";
import { Atelier } from "../kernel.js";
import * as m from "../model.js";
import { makeTool } from "../tools.js";
import { specs2d } from "../scene2d.js";
import { hitOf, internalPointsOf } from "../view2d.js";

const k = await loadKernel();
const params = Object.fromEntries(m.FABRIC_FIELDS.map((n) => [n, 1]));
const fresh = () => { const a = new Atelier(k); a.reset(m.newDocumentOps({ slug: "x", label: "X", params })); return a; };
const node = (a, id) => m.byId(a.nodes()).get(id);
const ctxOf = (a, extra = {}) => ({ nodes: a.nodes(), drawings: new Map(a.drawings().map((d) => [d.id, d])), selection: { kind: "pattern", id: "p1" }, fabric: "f_x",
    request: async () => { throw new Error("no request"); }, ...extra });

const a = fresh();
a.apply(m.addPattern(a.nodes(), { label: "Front", path: m.rectPath(0, 0, 200, 100), fabric: "f_x" }).ops, "rect");

// ---- the Internal tool: a click, a drag (a curve point), a click, Enter ----
{
    const t = makeTool("internal", ctxOf(a));
    const click = (p, mods = {}) => { t.down(p, null, {}); return t.up(p, null, mods); };
    click([20, 20]);
    t.down([100, 60], null, {}); t.move([130, 60], null, {}); t.up([130, 60], null, {});     // drag: handles at (130, 60) and (70, 60)
    click([180, 20]);
    assert.deepEqual(t.lastPoint(), [180, 20]);
    const r = t.key("Enter");
    assert.equal(r.done, true);
    a.apply(r.ops, "internal");
    const path = node(a, "p1").internal[0].path;
    assert.deepEqual(path.start, [20, 20]);
    assert.deepEqual(path.segments.map((s) => s.type), ["bezier", "bezier"], "both segments by the curve point are cubics");
    assert.deepEqual(path.segments[0], { type: "bezier", c1: [20, 20], c2: [70, 60], to: [100, 60] });
    assert.deepEqual(path.segments[1], { type: "bezier", c1: [130, 60], c2: [180, 20], to: [180, 20] });
    assert.equal(m.isClosedPath(path), false, "an internal line is open");
    // the kernel draws it as Béziers, open
    const d = a.drawing("p1").internal[0];
    assert.equal(d.closed, false);
    assert.ok(d.beziers.length >= 16, "two cubic spans drawn");
}
// a double click ends the line too; the double click's first click is its last point, placed once
{
    const t = makeTool("internal", ctxOf(a));
    const click = (p, mods = {}) => { t.down(p, null, {}); return t.up(p, null, mods); };
    click([20, 80]);
    click([60, 90]);
    click([90, 80], { detail: 1 });
    const r = click([90, 80], { detail: 2, dblclick: true });
    a.apply(r.ops, "internal");
    const path = node(a, "p1").internal[1].path;
    assert.deepEqual(m.pathPoints({ ...path, segments: [...path.segments, { type: "line", to: path.start }] }), [[20, 80], [60, 90], [90, 80]]);
    assert.ok(path.segments.every((s) => s.type === "line"), "clicks alone: straight segments");
}
// Backspace drops the last point; Escape ends with nothing; one point places nothing
{
    const t = makeTool("internal", ctxOf(a));
    const click = (p) => { t.down(p, null, {}); return t.up(p, null, {}); };
    click([10, 10]); click([20, 10]); click([30, 30]);
    t.key("Backspace");
    assert.deepEqual(t.lastPoint(), [20, 10]);
    assert.equal(t.key("Escape").done, true);
    assert.equal(t.lastPoint(), null);
    const t2 = makeTool("internal", ctxOf(a));
    t2.down([10, 10], null, {}); t2.up([10, 10], null, {});
    const r = t2.key("Enter");
    assert.equal(r.ops, undefined, "a lone point is no line");
    assert.equal(r.done, true);
    const t3 = makeTool("internal", ctxOf(a, { selection: null }));
    t3.down([10, 10], null, {}); t3.up([10, 10], null, {}); t3.down([20, 10], null, {}); t3.up([20, 10], null, {});
    assert.match(t3.key("Enter").status, /select the piece/);
}

// ---- the Edit tool: the scene offers the internal points and handles on the selected piece only ----
const sceneOf = (a, selection) => specs2d({ drawings: a.drawings(), seams: [], nodes: a.nodes(), selection, colours: new Map() });
{
    const none = sceneOf(a, null);
    assert.ok(!none.some((s) => s.key.endsWith("/ipoints")), "no internal points without a selection");
    const sel = sceneOf(a, { kind: "pattern", id: "p1" });
    const ip = sel.find((s) => s.key === "p1/ipoints"), ih = sel.find((s) => s.key === "p1/ihandles");
    assert.equal(ip.data.length / 3, 3 + 3, "the curved line's 3 points and the straight one's 3");
    assert.equal(ih.data.length / 3, 4, "the curved line's 4 handles");
    // a pick on the curved line's middle point decodes to it, through the item map's entry
    assert.deepEqual(hitOf(ip.what, { node: 1, point: [100, 60, 0] }, new Map()), { kind: "ipoint", id: "p1", line: 0, index: 1 });
    const h = hitOf(ih.what, { node: 2, point: [130, 60, 0] }, new Map());
    assert.deepEqual(h, { kind: "ihandle", id: "p1", line: 0, index: 1, which: "c1" });
    const xf = specs2d({ drawings: a.drawings(), seams: [], nodes: a.nodes(), selection: { kind: "pattern", id: "p1" }, colours: new Map(), xform: true });
    assert.ok(!xf.some((s) => s.key === "p1/ipoints"), "not under the Move tool");
}
// drag a handle: one preview of internal[0].path, one commit, one undo
{
    const before = structuredClone(node(a, "p1").internal);
    const t = makeTool("edit", ctxOf(a));
    const ih = sceneOf(a, { kind: "pattern", id: "p1" }).find((s) => s.key === "p1/ihandles");
    const hit = hitOf(ih.what, { node: 2, point: [130, 60, 0] }, new Map());
    assert.deepEqual(t.down([130, 60], hit, {}), {});
    const mv = t.move([140, 75], null, {});
    a.preview(mv.preview);
    assert.deepEqual(node(a, "p1").internal[0].path.segments[1].c1, [140, 75], "the handle moved by the drag");
    assert.deepEqual(node(a, "p1").internal[0].path.segments[0].c2, [70, 60], "its twin stays: handles move alone");
    assert.deepEqual(node(a, "p1").internal[1], before[1], "the other line is untouched");
    assert.equal(t.up([140, 75], null, {}).endPreview, true);
    a.endPreview(true, null);
    assert.deepEqual(node(a, "p1").internal[0].path.segments[1].c1, [140, 75]);
    assert.ok(a.drawing("p1").internal[0].beziers.length >= 16);
    a.undo();
    assert.deepEqual(node(a, "p1").internal, before, "the drag is one undo step");
}
// drag a point: the handles on either side of it ride along; the open line's ends stay
{
    const t = makeTool("edit", ctxOf(a));
    const ipts = internalPointsOf(a.nodes(), "p1").points;
    const at = ipts.findIndex((q) => q.line === 0 && q.index === 1);
    const ip = sceneOf(a, { kind: "pattern", id: "p1" }).find((s) => s.key === "p1/ipoints");
    t.down([100, 60], hitOf(ip.what, { node: at, point: [100, 60, 0] }, new Map()), {});
    const mv = t.move([105, 50], null, {});
    const path = mv.preview[0].fields.internal[0].path;
    assert.deepEqual(path.segments[0].to, [105, 50]);
    assert.deepEqual(path.segments[0].c2, [75, 50], "the handle into the point moved with it");
    assert.deepEqual(path.segments[1].c1, [135, 50], "the handle out of the point moved with it");
    assert.deepEqual(path.start, [20, 20]);
    assert.deepEqual(path.segments[1].to, [180, 20], "the line's other points stay");
    a.preview(mv.preview);
    t.up([105, 50], null, {});
    a.endPreview(true, null);
    assert.deepEqual(node(a, "p1").internal[0].path.segments[0].to, [105, 50]);
    // the open line's first point moves the first segment's c1, and no segment's end
    const t2 = makeTool("edit", ctxOf(a));
    const first = internalPointsOf(a.nodes(), "p1").points.findIndex((q) => q.line === 0 && q.index === 0);
    const ip2 = sceneOf(a, { kind: "pattern", id: "p1" }).find((s) => s.key === "p1/ipoints");
    t2.down([20, 20], hitOf(ip2.what, { node: first, point: [20, 20, 0] }, new Map()), {});
    const p2 = t2.move([10, 20], null, {}).preview[0].fields.internal[0].path;
    assert.deepEqual(p2.start, [10, 20]);
    assert.deepEqual(p2.segments[0].c1, [10, 20]);
    assert.deepEqual(p2.segments[1].to, [180, 20], "an open line has no closing segment to drag along");
    t2.key("Escape");
}
// an internal closed shape (Int □) edits the same way: its first point drags the closing segment's end
{
    a.apply(m.addInternal(a.nodes(), "p1", m.rectPath(120, 70, 20, 20)), "internal");
    const ipts = internalPointsOf(a.nodes(), "p1").points.filter((q) => q.line === 2);
    assert.equal(ipts.length, 4, "a closed square: its 4 corners, the end not repeated");
    const t = makeTool("edit", ctxOf(a));
    t.down([120, 70], { kind: "ipoint", id: "p1", line: 2, index: 0 }, {});
    const mv = t.move([115, 65], null, {});
    const sq = mv.preview[0].fields.internal[2].path;
    assert.deepEqual(sq.start, [115, 65]);
    assert.deepEqual(sq.segments[3].to, [115, 65], "the shape stays closed");
    a.preview(mv.preview);
    t.up([115, 65], null, {});
    a.endPreview(true, null);
    assert.equal(a.drawing("p1").internal[2].closed, true);
}
a.free();
console.log("internal-edit-kernel: ok");
