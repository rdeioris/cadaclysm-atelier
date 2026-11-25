// The edit paths against the real kernel: the Move tool's previews, refused (degenerate or
// duplicate) changes, a fresh history on New / Open, an outline edit and its seam re-anchor as
// one undo step, seam picking with real seam data, and removing a piece.
import assert from "node:assert/strict";
import { loadKernel } from "./package.mjs";
import { Atelier } from "../kernel.js";
import * as m from "../model.js";
import { makeTool } from "../tools.js";
import { opsFor } from "../props.js";
import { hitOf, arcAt } from "../view2d.js";

const k = await loadKernel();
const params = Object.fromEntries(m.FABRIC_FIELDS.map((n) => [n, 1]));
const fresh = () => { const a = new Atelier(k); a.reset(m.newDocumentOps({ slug: "x", label: "X", params })); return a; };
const rect = (a, label, x, y = 0, w = 100, h = 50) => a.apply(m.addPattern(a.nodes(), { label, path: m.rectPath(x, y, w, h), fabric: "f_x" }).ops, "rect");
const round = (v) => v.map((x) => Math.round(x * 1e6) / 1e6 + 0);
const drawingsOf = (a) => new Map(a.drawings().map((d) => [d.id, d]));
const node = (a, id) => m.byId(a.nodes()).get(id);

// C1: the Move tool against the kernel moves the piece by exactly the gesture's delta, however
// many previews went out on the way (each request is relative to the committed outline).
{
    const a = fresh();
    rect(a, "Front", 0);
    const ctx = { nodes: a.nodes(), drawings: drawingsOf(a), selection: { kind: "pattern", id: "p1" }, fabric: "f_x",
        request: async (kind, p) => (kind === "transform" ? a.transformedPiece(p.id, p.matrix) : a.mirroredPiece(p.id, p.axis)) };
    const t = makeTool("transform", ctx);
    const run = (r) => { if (r?.preview) a.preview(r.preview); return r; };
    t.down([0, 0], { kind: "pattern", id: "p1" }, {});
    run(await t.move([10, 0], null, {}));
    run(await t.move([20, 0], null, {}));
    assert.deepEqual(round(a.drawing("p1").bounds), [20, 0, 120, 50], "the second preview is 20 along, not 10 + 20");
    run(await t.move([35, 5], null, {}));
    const up = run(await t.up([35, 5], null, {}));
    assert.equal(up.endPreview, true);
    a.endPreview(true, "p1");
    assert.deepEqual(round(a.drawing("p1").bounds), [35, 5, 135, 55]);
    assert.deepEqual(round(node(a, "p1_outline").path.start), [35, 5]);
    a.undo();
    assert.deepEqual(round(a.drawing("p1").bounds), [0, 0, 100, 50], "the move is one undo step");
    // a mirror asked during a preview reflects the committed outline too
    a.preview(m.setOutline(a.nodes(), "p1", m.rectPath(500, 0, 100, 50)));
    const mir = a.mirrored("p1", [0, 0, 0, 1]);
    assert.ok(m.pathPoints(mir).every(([x]) => x <= 1e-9 && x >= -100 - 1e-9));
    // an axis off the origin is two points as well: across x = 100, the committed rect lands on 100..200
    const off = a.mirrored("p1", [100, 0, 100, 50]);
    assert.ok(m.pathPoints(off).every(([x, y]) => x >= 100 - 1e-9 && x <= 200 + 1e-9 && y >= -1e-9 && y <= 50 + 1e-9), "mirrored across x = 100");
    a.endPreview(false);
    a.free();
}

// I1: a collinear (zero-area) outline is refused: the kernel keeps its state, the error names the
// reason, and the document keeps flowing (drawings, then the next change).
{
    const a = fresh();
    rect(a, "A", 0);
    const before = a.nodes();
    const pen = m.addPattern(a.nodes(), { label: "L", path: m.polyPath([[200, 0], [250, 0], [300, 0]]), fabric: "f_x" });
    assert.throws(() => a.apply(pen.ops, "pen"), /encloses no area|degenerate/);
    assert.deepEqual(a.nodes(), before, "the refused change is rolled back");
    assert.equal(a.drawings().length, 1);
    assert.deepEqual(a.issues(), []);
    rect(a, "B", 200);
    assert.deepEqual(a.drawings().map((d) => d.label), ["A", "B"]);
    // undo takes back B, not a phantom of the refused pen piece
    a.undo();
    assert.deepEqual(a.drawings().map((d) => d.label), ["A"]);

    // an edit drag that folds the piece flat: the frame is refused, the preview keeps the last good one
    a.preview(m.setOutline(a.nodes(), "p1", m.rectPath(0, 0, 120, 50)));
    assert.throws(() => a.preview(m.setOutline(a.nodes(), "p1", m.polyPath([[0, 0], [60, 0], [120, 0]]))), /encloses no area|degenerate/);
    assert.equal(Math.round(a.drawing("p1").bounds[2]), 120);
    a.endPreview(true, "p1");
    assert.equal(Math.round(node(a, "p1_outline").path.segments[0].to[0]), 120);
    assert.equal(a.drawings().length, 1);
    // a first frame refused: nothing to commit, the outline stays as it was
    assert.throws(() => a.preview(m.setOutline(a.nodes(), "p1", m.polyPath([[0, 0], [60, 0], [120, 0]]))), /encloses no area|degenerate/);
    assert.equal(Math.round(a.drawing("p1").bounds[2]), 120);
    a.endPreview(true, "p1");
    assert.equal(Math.round(node(a, "p1_outline").path.segments[0].to[0]), 120);
    a.free();
}

// I2: a change that makes the garment fail to evaluate (two pieces of one name) is refused with
// the kernel's message; a garment that already fails (a loaded file) shows it as an issue.
{
    const a = fresh();
    rect(a, "Piece 2", 0);
    assert.throws(() => rect(a, "Piece 2", 200), /distinct names/);
    assert.equal(a.drawings().length, 1);
    assert.ok(a.g, "the garment still evaluates");
    // the same document built behind the Atelier's back, saved and opened: an issue, not a blank page
    const raw = new Atelier(k);
    raw.reset(m.newDocumentOps({ slug: "x", label: "X", params }));
    for (const x of [0, 200]) raw.f("document_apply")(raw.d, JSON.stringify({ op: "batch", ops: m.addPattern(raw.nodes(), { label: "Same", path: m.rectPath(x, 0, 100, 50), fabric: "f_x" }).ops }), "dup");
    const b = new Atelier(k);
    b.load(raw.save());
    const iss = b.issues();
    assert.ok(iss.some((i) => /distinct names/.test(i.message)), JSON.stringify(iss));
    assert.deepEqual(b.drawings(), []);
    assert.deepEqual(b.seams(), []);
    raw.free(); b.free(); a.free();
    // the rectangle and polygon tools never repeat a label
    const nodes = [...m.newDocumentOps({ slug: "x", label: "X", params }).map((o) => o.node),
        { id: "p1", kind: "garment.pattern", label: "Piece 2" }];
    const rt = makeTool("rectangle", { nodes, drawings: new Map(), selection: null, fabric: "f_x", request: null });
    rt.down([0, 0], null, {});
    const label = rt.up([50, 50], null, {}).ops.find((o) => o.node?.kind === "garment.pattern").node.label;
    assert.notEqual(label, "Piece 2");
}

// I3: New and Open start a fresh history: undo stops there instead of emptying the document.
{
    const a = fresh();
    const n0 = a.nodes();
    assert.equal(a.undo(), false);
    assert.deepEqual(a.nodes(), n0, "undo after New keeps the fabric and the garment");
    rect(a, "A", 0);
    assert.equal(a.undo(), true);
    assert.equal(a.undo(), false);
    assert.deepEqual(a.nodes(), n0);
    rect(a, "B", 0);             // the next piece still works
    assert.equal(a.drawings().length, 1);
    // Open: the file's own history is not walked back
    const { readFileSync } = await import("node:fs");
    const t = new Atelier(k);
    t.load(readFileSync(new URL("../assets/tshirt.json", import.meta.url), "utf8"));
    const tn = t.nodes();
    assert.equal(t.undo(), false);
    assert.deepEqual(t.nodes(), tn);
    assert.equal(t.drawings().length, 4);
    t.free(); a.free();
}

// I4: an outline edit and its seam re-anchor are one commit: one undo takes both back.
{
    const a = fresh();
    rect(a, "A", 0); rect(a, "B", 200);
    a.apply(m.addSeam(a.nodes(), { a: "p1", b: "p2", a_from: 100, a_to: 150, b_from: 250, b_to: 300, reversed: true, anchor: { a: [1, 0, 1], b: [3, 0, 1] } }).ops, "sew");
    a.preview(m.setOutline(a.nodes(), "p1", m.rectPath(0, 0, 140, 50)));
    a.preview(m.setOutline(a.nodes(), "p1", m.rectPath(0, 0, 140, 60)));
    a.endPreview(true, "p1");
    assert.deepEqual(round([node(a, "s1").a_from, node(a, "s1").a_to]), [140, 200], "the seam follows the widened side");
    a.undo();
    assert.equal(node(a, "p1_outline").path.segments[0].to[0], 100);
    assert.deepEqual([node(a, "s1").a_from, node(a, "s1").a_to], [100, 150], "one undo puts the seam back too");
    a.redo();
    assert.deepEqual(round([node(a, "s1").a_from, node(a, "s1").a_to]), [140, 200]);
    // a re-anchor that removes a seam (its side is gone) says so, and is the same one step
    a.apply(m.addSeam(a.nodes(), { a: "p1", b: "p2", a_from: 340, a_to: 400, b_from: 0, b_to: 60, anchor: { a: [3, 0, 1], b: [0, 0, 0.6] } }).ops, "sew");
    a.preview(m.setOutline(a.nodes(), "p1", m.polyPath([[0, 0], [140, 0], [140, 60]])));
    const r = a.endPreview(true, "p1");
    assert.deepEqual(r.removed, ["s2"]);
    assert.deepEqual(a.seams().map((s) => s.id), ["s1"]);
    a.undo();
    assert.deepEqual(a.seams().map((s) => s.id), ["s1", "s2"]);
    assert.equal(node(a, "p1_outline").path.segments.length, 4);
    a.free();
}

// I7: a click on a real seam (garment_range_points lies on the outline) names the seam, and the
// edit tool's click without a drag selects it; a drag still moves the edge.
{
    const a = fresh();
    rect(a, "A", 0); rect(a, "B", 200);
    a.apply(m.addSeam(a.nodes(), { a: "p1", b: "p2", a_from: 100, a_to: 150, b_from: 250, b_to: 300, reversed: true, anchor: { a: [1, 0, 1], b: [3, 0, 1] } }).ops, "sew");
    const drawings = a.drawings(), seams = a.seams(), nodes = a.nodes();
    const byId = new Map(drawings.map((d) => [d.id, d]));
    const sp = seams[0].points_a, mid = (sp.length >> 2) * 2;
    assert.ok(arcAt(byId.get("p1").samples, byId.get("p1").sides, [sp[mid], sp[mid + 1]]).d < 0.01, "the seam's range points lie on the outline");
    const at = (p) => ({ item: 1, node: 0, face: 0, point: [p[0], p[1], 0], segment: 0, distancePx: 0 });
    const h = hitOf({ kind: "seam", id: "s1", pattern: "p1" }, at([100, 25]), byId);
    assert.equal(h.kind, "edge"); assert.equal(h.id, "p1"); assert.equal(h.seam, "s1");
    const off = hitOf({ kind: "sew", id: "p1" }, at([50, 0]), byId);
    assert.equal(off.kind, "edge"); assert.equal(off.seam, undefined);
    const ctx = { nodes, drawings: byId, selection: null, fabric: "f_x", request: null, pxToWorld: 1 };
    const t = makeTool("edit", ctx);
    t.down([100, 25], h, {});
    assert.deepEqual(t.up([100, 25], h, {}), { select: { kind: "seam", id: "s1" } });
    const t2 = makeTool("edit", ctx);
    t2.down([100, 25], h, {});
    assert.ok(t2.move([120, 25], null, {}).preview, "a drag on the seamed edge still moves it");
    assert.equal(t2.up([120, 25], null, {}).endPreview, true);
    a.free();
}

// I8: removing a piece through the property field's ops takes its seams too; Delete on a seam removes it.
{
    const a = fresh();
    rect(a, "A", 0); rect(a, "B", 200); rect(a, "C", 400);
    a.apply(m.addSeam(a.nodes(), { a: "p1", b: "p2", a_from: 100, a_to: 150, b_from: 250, b_to: 300 }).ops, "sew");
    a.apply(m.addSeam(a.nodes(), { a: "p2", b: "p3", a_from: 100, a_to: 150, b_from: 250, b_to: 300 }).ops, "sew");
    a.apply(opsFor({ kind: "seam", id: "s2" }, a.nodes(), "remove", null), "remove seam");
    assert.deepEqual(a.seams().map((s) => s.id), ["s1"]);
    a.apply(opsFor({ kind: "pattern", id: "p1" }, a.nodes(), "remove", null), "remove piece");
    assert.deepEqual(a.drawings().map((d) => d.label), ["B", "C"]);
    assert.equal(a.seams().length, 0);
    assert.ok(!a.nodes().some((n) => n.id === "p1_outline" || n.id === "s1"));
    a.undo();
    assert.deepEqual(a.drawings().map((d) => d.label), ["A", "B", "C"]);
    assert.equal(a.seams().length, 1);
    a.free();
}
// M2: a new document never inherits an open preview; M6: DXF pieces take the fabric asked for
{
    const a = fresh();
    rect(a, "A", 0);
    a.apply(m.addFabric(a.nodes(), "y", "Y", params).ops, "fabric");
    a.preview(m.setOutline(a.nodes(), "p1", m.rectPath(0, 0, 120, 50)));
    const saved = a.save();
    a.load(saved);
    assert.equal(a.previewing, false);
    const ops = a.fromDxf(a.toDxf(), "f_y");
    assert.equal(ops.find((o) => o.node?.kind === "garment.pattern").node.fabric, "f_y");
    assert.equal(a.fromDxf(a.toDxf(), "nope").find((o) => o.node?.kind === "garment.pattern").node.fabric, "f_x");
    a.free();
}
console.log("edits-kernel: ok");
