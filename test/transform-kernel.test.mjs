// The pattern transforms (spec §2) against the kernel: transformedPiece moves the whole piece --
// outline, internal lines, notches at their mapped points, grain -- through one matrix; Rotate,
// Scale and Flip are one batch with the seams re-anchored; copy and paste add "‹label› copy"
// pieces 30 mm along with their inner seams, without the slot.
import assert from "node:assert/strict";
import { loadKernel } from "./package.mjs";
import { Atelier } from "../kernel.js";
import * as m from "../model.js";
import { transformMatrix, unionBounds } from "../props.js";
import { makeTool } from "../tools.js";

const k = await loadKernel();
const params = Object.fromEntries(m.FABRIC_FIELDS.map((n) => [n, 1]));
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} vs ${b}`);
const nearAll = (a, b, e = 1e-6) => { assert.equal(a.length, b.length, `${a} vs ${b}`); a.forEach((v, i) => near(v, b[i], e)); };
const node = (a, id) => m.byId(a.nodes()).get(id);
const drawingsOf = (a) => new Map(a.drawings().map((d) => [d.id, d]));
const line = { kind: "line", path: { start: [10, 10], segments: [{ type: "line", to: [40, 10] }] } };
// A (0..100 x 0..50) with an internal line, a notch at (30, 0) and a grain; B beside it, sewn to
// A's right side
function fresh() {
    const a = new Atelier(k);
    a.reset(m.newDocumentOps({ slug: "x", label: "X", params }));
    a.apply(m.addPattern(a.nodes(), { label: "A", path: m.rectPath(0, 0, 100, 50), fabric: "f_x", grain: [0.6, 0.8] }).ops, "a");
    a.apply(m.addPattern(a.nodes(), { label: "B", path: m.rectPath(200, 0, 100, 50), fabric: "f_x" }).ops, "b");
    a.apply([...m.addInternal(a.nodes(), "p1", line.path)], "line");
    a.apply(m.setPattern(a.nodes(), "p1", { notches: [{ at: 30, kind: "slit", depth: 5 }] }), "notch");
    a.apply(m.addSeam(a.nodes(), { a: "p1", b: "p2", a_from: 100, a_to: 150, b_from: 250, b_to: 300, reversed: true, anchor: { a: [1, 0, 1], b: [3, 0, 1] } }).ops, "sew");
    assert.deepEqual(a.problems(), []);
    return a;
}
// the panel's way: one batch through pieceOps, the pieces' seams re-anchored in it
const transform = (a, ids, key, value) => {
    const matrix = transformMatrix(key, value, unionBounds(drawingsOf(a), ids));
    const ops = ids.flatMap((id) => m.pieceOps(a.nodes(), id, a.transformedPiece(id, matrix)));
    return a.commit(ops, key, ids);
};

// rotate 90 degrees about the centre (50, 25): (x, y) -> (75 - y, x - 25)
{
    const a = fresh();
    const r = a.transformedPiece("p1", transformMatrix("rotate", 90, a.drawing("p1").bounds));
    nearAll(r.internal[0].path.start, [65, -15]);
    nearAll(r.internal[0].path.segments[0].to, [65, 15]);
    nearAll(r.grain, [-0.8, 0.6]);
    transform(a, ["p1"], "rotate", 90);
    const d = a.drawing("p1");
    nearAll(d.bounds, [25, -25, 75, 75]);
    nearAll(d.notches[0].slice(0, 2), [75, 5], 1e-3);
    nearAll(d.internal[0].points, [65, -15, 65, 15]);
    nearAll(node(a, "p1").grain, [-0.8, 0.6]);
    assert.deepEqual(a.problems(), []);
    assert.equal(a.undo(), true);
    nearAll(a.drawing("p1").bounds, [0, 0, 100, 50]);
    assert.deepEqual(node(a, "p1").internal, [line], "the rotation is one undo step");
    a.free();
}
// scale 200 % about the centre: the seam on A's right side is re-anchored to its doubled length;
// the allowance (a sewing width) stays
{
    const a = fresh();
    const out = transform(a, ["p1"], "scale", 200);
    assert.deepEqual(out.removed, []);
    nearAll(a.drawing("p1").bounds, [-50, -25, 150, 75]);
    const s = node(a, "s1");
    near(s.a_from, 200, 1e-4); near(s.a_to, 300, 1e-4);
    near(s.b_from, 250, 1e-9); near(s.b_to, 300, 1e-9);
    assert.deepEqual(node(a, "p1").allowance, [10]);
    nearAll(a.drawing("p1").notches[0].slice(0, 2), [10, -25], 1e-3);
    nearAll(a.drawing("p1").internal[0].points, [-30, -5, 30, -5]);
    a.free();
}
// flip: the grain reflects, the notch and internal line land on their mirrored points, the seam
// keeps its side
{
    const a = fresh();
    transform(a, ["p1"], "flipH", null);
    nearAll(node(a, "p1").grain, [-0.6, 0.8]);
    nearAll(a.drawing("p1").bounds, [0, 0, 100, 50]);
    nearAll(a.drawing("p1").notches[0].slice(0, 2), [70, 0], 1e-3);
    nearAll(a.drawing("p1").internal[0].points, [90, 10, 60, 10]);
    assert.deepEqual(a.problems(), []);
    transform(a, ["p1"], "flipV", null);
    nearAll(node(a, "p1").grain, [-0.6, -0.8]);
    nearAll(a.drawing("p1").notches[0].slice(0, 2), [70, 50], 1e-3);
    // the seam's range stays on the side it was sewn to: A's side 1, now on x = 0
    const pts = a.seams().find((s) => s.id === "s1").points_a;
    for (let i = 0; i < pts.length; i += 2) near(pts[i], 0, 1e-6);
    a.free();
}
// a multi-selection turns about the union's centre, both ends of the seam re-anchored
{
    const a = fresh();
    transform(a, ["p1", "p2"], "rotate", 180);
    nearAll(a.drawing("p1").bounds, [200, 0, 300, 50]);
    nearAll(a.drawing("p2").bounds, [0, 0, 100, 50]);
    const s = node(a, "s1");
    near(s.a_from, 100, 1e-4); near(s.a_to, 150, 1e-4);
    assert.deepEqual(a.problems(), []);
    a.free();
}
// copy and paste: the pieces 30 mm along x and y as "‹label› copy", their inner seam copied onto
// the copies, no slot; a second paste 60 mm along as "copy 2"; each paste one undo step
{
    const a = fresh();
    a.apply(m.setPattern(a.nodes(), "p1", { frame: "xy", meta: { atelier: { slot: "front", keep: 1 } }, particle_distance: 12, layer: 2 }), "slot");
    const clip = m.copyPieces(a.nodes(), ["p1", "p2"]);
    assert.equal(clip.seams.length, 1);
    assert.equal(m.copyPieces(a.nodes(), ["p1"]).seams.length, 0, "a seam with one end outside stays behind");
    const paste = (n) => {
        const d = 30 * n, r = m.pasteOps(a.nodes(), clip, a.piecesThrough(clip.pieces, [1, 0, d, 0, 1, d]));
        a.commit(r.ops, "paste");
        return r.ids;
    };
    const ids = paste(1);
    assert.deepEqual(ids, ["p3", "p4"]);
    nearAll(a.drawing("p3").bounds, [30, 30, 130, 80]);
    nearAll(a.drawing("p4").bounds, [230, 30, 330, 80]);
    const p3 = node(a, "p3");
    assert.equal(p3.label, "A copy");
    assert.equal(node(a, "p4").label, "B copy");
    assert.equal(p3.frame, undefined, "no slot frame: on the floor");
    assert.deepEqual(p3.meta, { atelier: { keep: 1 } }, "the slot dropped, the rest of the meta kept");
    assert.equal(p3.particle_distance, 12);
    assert.equal(p3.layer, 2);
    assert.equal(p3.fabric, "f_x");
    nearAll(p3.grain, [0.6, 0.8]);
    nearAll(a.drawing("p3").internal[0].points, [40, 40, 70, 40]);
    nearAll(a.drawing("p3").notches[0].slice(0, 2), [60, 30], 1e-3);
    const s2 = node(a, "s2");
    assert.equal(s2.a, "p3"); assert.equal(s2.b, "p4");
    assert.deepEqual([s2.a_from, s2.a_to, s2.b_from, s2.b_to, s2.reversed], [100, 150, 250, 300, true]);
    assert.deepEqual(s2.meta.atelier, node(a, "s1").meta.atelier);
    assert.ok(node(a, "garment").seams.includes("s2"));
    assert.deepEqual(a.problems(), []);
    // the copy's seam joins the copies' right and left sides, 30 mm along
    const pts = a.seams().find((s) => s.id === "s2").points_a;
    near(pts[0], 130, 1e-6);
    paste(2);
    assert.equal(node(a, "p5").label, "A copy 2");
    nearAll(a.drawing("p5").bounds, [60, 60, 160, 110]);
    assert.equal(node(a, "garment").patterns.length, 6);
    a.undo();
    assert.equal(node(a, "garment").patterns.length, 4, "a paste is one undo step");
    // the clipboard outlives its pieces: removed, they still paste
    a.apply(m.removePatterns(a.nodes(), ["p1", "p2"]), "rm");
    const again = m.pasteOps(a.nodes(), clip, a.piecesThrough(clip.pieces, [1, 0, 30, 0, 1, 30]));
    a.commit(again.ops, "paste");
    assert.equal(node(a, again.ids[0]).label, "A copy 2", "A copy is taken by p3");
    assert.deepEqual(a.problems(), []);
    a.free();
}
// A3: the Move tool's handles through the kernel, as the page runs them: each preview frame the
// tool returns goes to Atelier.preview, the release to endPreview with the tool's re-anchor list
{
    const drag = async (a, selection, hit, from, path, to, mods = {}) => {
        const request = async (kind, p) => (kind === "transform" ? a.transformedPiece(p.id, p.matrix)
            : Object.fromEntries(p.ids.map((id) => [id, a.transformedPiece(id, p.matrix)])));
        const t = makeTool("transform", { nodes: a.nodes(), drawings: drawingsOf(a), selection, fabric: "f_x", request });
        t.down(from, hit, {});
        for (const w of path) { const r = await t.move(w, null, mods); if (r.preview) a.preview(r.preview); }
        const up = await t.up(to, null, mods);
        if (up.preview) a.preview(up.preview);
        return { up, out: a.endPreview(!!up.endPreview, up.reanchor) };
    };
    // A's top-right corner to (200, 100): twice the size about (0, 0); its seam re-anchored
    {
        const a = fresh();
        const { up, out } = await drag(a, { kind: "pattern", id: "p1" }, { kind: "xform", id: "p1", handle: "ne" }, [100, 50], [[150, 75]], [200, 100]);
        assert.deepEqual(up.reanchor, ["p1"]); assert.deepEqual(out.removed, []);
        nearAll(a.drawing("p1").bounds, [0, 0, 200, 100]);
        const s = node(a, "s1");
        near(s.a_from, 200, 1e-4); near(s.a_to, 300, 1e-4);
        nearAll(a.drawing("p1").internal[0].points, [20, 20, 80, 20]);
        assert.deepEqual(a.problems(), []);
        a.undo();
        nearAll(a.drawing("p1").bounds, [0, 0, 100, 50], 1e-9);
        a.free();
    }
    // both pieces turned a quarter about the union's centre (150, 25) by the rotate handle, with
    // Shift (the pointer's 88 degrees snapped to 90): one undo step
    {
        const a = fresh();
        const a88 = Math.PI / 2 + (88 * Math.PI) / 180, r = 60;
        const { out } = await drag(a, { kind: "pattern", id: "p1", ids: ["p1", "p2"] }, { kind: "xform", id: "p1", handle: "rot" },
            [150, 25 + r], [[140, 80]], [150 + r * Math.cos(a88), 25 + r * Math.sin(a88)], { shift: true });
        assert.deepEqual(out.removed, []);
        // (x, y) -> (175 - y, x - 125)
        nearAll(a.drawing("p1").bounds, [125, -125, 175, -25]);
        nearAll(a.drawing("p2").bounds, [125, 75, 175, 175]);
        assert.deepEqual(a.problems(), []);
        a.undo();
        nearAll(a.drawing("p2").bounds, [200, 0, 300, 50], 1e-9);
        a.free();
    }
}
// a piece's saved pins (S1, pattern space) go with it: moved, and onto a pasted copy
{
    const a = fresh();
    a.apply(m.setPattern(a.nodes(), "p1", { pins: [[20, 20], [70, 30]] }), "pins");
    a.commit(m.pieceOps(a.nodes(), "p1", a.transformedPiece("p1", [1, 0, 15, 0, 1, -5])), "move", ["p1"]);
    nearAll(node(a, "p1").pins.flat(), [35, 15, 85, 25]);
    assert.equal(node(a, "p2").pins, undefined, "a piece without pins gets none");
    const clip = m.copyPieces(a.nodes(), ["p1"]);
    const r = m.pasteOps(a.nodes(), clip, a.piecesThrough(clip.pieces, [1, 0, 30, 0, 1, 30]));
    a.commit(r.ops, "paste");
    nearAll(node(a, r.ids[0]).pins.flat(), [65, 45, 115, 55]);
    a.free();
}
console.log("transform-kernel: ok");
