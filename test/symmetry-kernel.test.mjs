// Symmetric pieces (spec §6) against the kernel: a linked pair (the Sym tool) keeps its partner
// the mirror of whichever piece was edited, in the same batch (one undo); Unlink, deleting one
// piece and a move with or without the partner; Unfold makes a half whole across a straight side,
// an edit on either half rebuilds it, and Fold back gives the edited half.
import assert from "node:assert/strict";
import { loadKernel } from "./package.mjs";
import { Atelier } from "../kernel.js";
import * as m from "../model.js";
import { makeTool } from "../tools.js";

const k = await loadKernel();
const params = Object.fromEntries(m.FABRIC_FIELDS.map((n) => [n, 1]));
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} vs ${b}`);
const nearAll = (a, b, e = 1e-6) => { assert.equal(a.length, b.length, `${a} vs ${b}`); a.forEach((v, i) => near(v, b[i], e)); };
const node = (a, id) => m.byId(a.nodes()).get(id);
const outline = (a, id) => node(a, `${id}_outline`).path;
const area = (a, id) => a.withOutline(id, (p) => a.f("profile_area_properties")(p, 1e-6)[0]);
const flat = (path) => JSON.stringify(path, (_, v) => (typeof v === "number" ? Math.round(v * 1e6) / 1e6 + 0 : v));
// a test-side mirror check: B's outline is A's mirrored across `axis` by the kernel
const isMirror = (a, from, to, axis) => assert.equal(flat(outline(a, to)), flat(a.withPath(outline(a, from), (p) => a.pathOf(a.f("profile_mirror")(p, axis[0], axis[1], axis[2] - axis[0], axis[3] - axis[1])))));
const ctx = (a, extra = {}) => ({
    nodes: a.nodes(), drawings: new Map(a.drawings().map((d) => [d.id, d])), selection: null, fabric: "f_x", pxToWorld: 1,
    request: async (kind, p) => (kind === "mirror" ? a.mirroredPiece(p.id, p.axis) : a.transformedPiece(p.id, p.matrix)), ...extra,
});
// two clicks of a tool: down and up at each point
async function clicks(t, pts) { let r; for (const p of pts) { t.down(p, null, {}); r = await t.up(p, null, {}); } return r; }

function fresh() {
    const a = new Atelier(k);
    a.reset(m.newDocumentOps({ slug: "x", label: "X", params }));
    a.apply(m.addPattern(a.nodes(), { label: "A", path: m.rectPath(0, 0, 100, 50), fabric: "f_x", grain: [0.6, 0.8], allowance: [1, 2, 3, 4] }).ops, "a");
    a.apply(m.setPattern(a.nodes(), "p1", { notches: [{ at: 30, kind: "v", depth: 5 }], internal: [{ kind: "line", path: { start: [10, 10], segments: [{ type: "line", to: [40, 10] }] } }] }), "marks");
    assert.deepEqual(a.problems(), []);
    return a;
}
const AXIS = [-10, 0, -10, 100];      // the line x = -10
async function symPair() {
    const a = fresh();
    const r = await clicks(makeTool("sym", ctx(a, { selection: { kind: "pattern", id: "p1" } })), [[-10, 0], [-10, 100]]);
    a.commit(r.ops, "sym");
    assert.deepEqual(node(a, "p1").meta.atelier.link, { partner: "p2", axis: AXIS });
    assert.deepEqual(node(a, "p2").meta.atelier.link, { partner: "p1", axis: AXIS });
    assert.equal(node(a, "p2").label, "A (sym)");
    isMirror(a, "p1", "p2", AXIS);
    return a;
}
// drag A's point 2 (100, 50) to (120, 70) as the Edit tool does: one outline set
const dragA = (a, id = "p1", i = 2, d = [20, 20]) => {
    const p = JSON.parse(JSON.stringify(outline(a, id)));
    p.segments[i - 1].to = [p.segments[i - 1].to[0] + d[0], p.segments[i - 1].to[1] + d[1]];
    return m.setOutline(a.nodes(), id, p);
};

// Sym, then edit A: B is A's mirror, internal line, notch, grain and allowance with it; one undo
{
    const a = await symPair();
    const b0 = outline(a, "p2");
    a.commit(dragA(a), "edit", "p1");
    isMirror(a, "p1", "p2", AXIS);
    nearAll(node(a, "p2").internal[0].path.start, [-30, 10]);
    nearAll(node(a, "p2").grain, [-0.6, 0.8]);
    assert.deepEqual(node(a, "p2").allowance, [1, 2, 3, 4]);
    nearAll(a.drawing("p2").notches[0].slice(0, 2), [-50, 0], 1e-3);
    assert.deepEqual(a.problems(), []);
    assert.equal(a.undo(), true);
    assert.equal(flat(outline(a, "p2")), flat(b0), "one undo takes both back");
    nearAll(outline(a, "p1").segments[1].to, [100, 50]);
    a.free();
}
// edit B (the partner), and A follows; an allowance edit on B too
{
    const a = await symPair();
    a.commit(dragA(a, "p2", 2, [-20, 20]), "edit", "p2");
    isMirror(a, "p2", "p1", AXIS);
    nearAll(outline(a, "p1").segments[1].to, [120, 70]);
    a.commit(m.setPattern(a.nodes(), "p2", { allowance: [5, 5, 5, 6] }), "allowance");
    assert.deepEqual(node(a, "p1").allowance, [5, 5, 5, 6]);
    a.free();
}
// a preview frame rebuilds the partner too; the commit is one undo
{
    const a = await symPair();
    a.preview(dragA(a));
    isMirror(a, "p1", "p2", AXIS);
    a.endPreview(true, "p1");
    isMirror(a, "p1", "p2", AXIS);
    nearAll(outline(a, "p2").segments[1].to, [-140, 70]);
    a.undo();
    nearAll(outline(a, "p2").segments[1].to, [-120, 50]);
    a.free();
}
// Unlink, then edit A, and B stays
{
    const a = await symPair();
    a.commit(m.unlinkOps(a.nodes(), "p2"), "unlink");
    assert.equal(node(a, "p1").meta?.atelier?.link, undefined);
    assert.equal(node(a, "p2").meta?.atelier?.link, undefined);
    const b0 = flat(outline(a, "p2"));
    a.commit(dragA(a), "edit", "p1");
    assert.equal(flat(outline(a, "p2")), b0);
    a.free();
}
// deleting one piece drops the other's link
{
    const a = await symPair();
    a.commit(m.removePattern(a.nodes(), "p1"), "remove");
    assert.equal(node(a, "p2").meta?.atelier?.link, undefined);
    a.undo();
    assert.equal(node(a, "p2").meta.atelier.link.partner, "p1");
    a.free();
}
// moving A alone keeps the axis: B moves the mirrored way; moving both moves the axis
{
    const a = await symPair();
    const shift = [1, 0, 30, 0, 1, 5];
    a.commit(m.pieceOps(a.nodes(), "p1", a.transformedPiece("p1", shift), ["p1"]), "move", ["p1"]);
    assert.deepEqual(node(a, "p1").meta.atelier.link.axis, AXIS);
    isMirror(a, "p1", "p2", AXIS);
    nearAll(outline(a, "p2").start, [-50, 5]);
    const ids = ["p1", "p2"];
    a.commit(ids.flatMap((id) => m.pieceOps(a.nodes(), id, a.transformedPiece(id, shift), ids)), "move", ids);
    const moved = [20, 5, 20, 105];
    assert.deepEqual(node(a, "p1").meta.atelier.link.axis, moved);
    assert.deepEqual(node(a, "p2").meta.atelier.link.axis, moved);
    isMirror(a, "p1", "p2", moved);
    nearAll(outline(a, "p2").start, [-20, 10]);
    a.free();
}
// a point inserted on A: B gains it too, and B's seam stays on its side
{
    const a = await symPair();
    a.apply(m.addPattern(a.nodes(), { label: "C", path: m.rectPath(0, 200, 100, 50), fabric: "f_x" }).ops, "c");
    // B's side 1 (from (-120, 0) to (-120, 50)) sewn to C's side 3
    a.apply(m.addSeam(a.nodes(), { a: "p2", b: "p3", a_from: 100, a_to: 150, b_from: 250, b_to: 300, reversed: false, anchor: { a: [1, 0, 1], b: [3, 0, 1] } }).ops, "sew");
    a.commit(a.pointOps({ id: "p1", op: "insert", s: 50 }), "point", "p1");
    assert.equal(outline(a, "p2").segments.length, 5);
    isMirror(a, "p1", "p2", AXIS);
    const s = node(a, "s1");
    assert.deepEqual(s.meta.atelier.a, [2, 0, 1], "the seam's side moved up one with the new point");
    near(s.a_from, 100); near(s.a_to, 150);
    assert.deepEqual(a.problems(), []);
    a.free();
}
// Cut on a linked piece: the partner's link is dropped
{
    const a = await symPair();
    a.apply(a.cutOps("p1", { start: [50, -10], segments: [{ type: "line", to: [50, 60] }] }).ops, "cut");
    assert.equal(node(a, "p2").meta?.atelier?.link, undefined);
    a.free();
}

// a pasted copy of a linked piece is linked to nothing; Sym on a linked piece is refused
{
    const a = await symPair();
    const clip = m.copyPieces(a.nodes(), ["p1"]);
    a.commit(m.pasteOps(a.nodes(), clip, a.piecesThrough(clip.pieces, [1, 0, 30, 0, 1, 30])).ops, "paste");
    assert.equal(node(a, "p3").meta?.atelier?.link, undefined);
    assert.equal(node(a, "p1").meta.atelier.link.partner, "p2");
    assert.equal(node(a, "p2").meta.atelier.link.partner, "p1");
    const r = await clicks(makeTool("sym", ctx(a, { selection: { kind: "pattern", id: "p1" } })), [[-10, 0], [-10, 100]]);
    assert.match(r.status, /linked already/);
    a.free();
}

// ---- unfold ----
// a half rectangle 0..50 x 0..60, folded on its left side x = 0 (side 3)
function halfPiece() {
    const a = new Atelier(k);
    a.reset(m.newDocumentOps({ slug: "x", label: "X", params }));
    a.apply(m.addPattern(a.nodes(), { label: "H", path: m.rectPath(0, 0, 50, 60), fabric: "f_x", allowance: [1, 2, 3, 4] }).ops, "h");
    a.apply(m.addPattern(a.nodes(), { label: "S", path: m.rectPath(200, 0, 50, 60), fabric: "f_x" }).ops, "s");
    a.apply(m.setPattern(a.nodes(), "p1", { notches: [{ at: 20, kind: "slit", depth: 4 }] }), "notch");
    return a;
}
{
    const a = halfPiece();
    // H's right side (side 1) sewn to S's left side (side 3); H's bottom (side 0) to S's bottom
    a.apply(m.addSeam(a.nodes(), { a: "p1", b: "p2", a_from: 50, a_to: 110, b_from: 170, b_to: 230, reversed: true, anchor: { a: [1, 0, 1], b: [3, 0, 1] } }).ops, "sew1");
    near(area(a, "p1"), 3000);
    const t = makeTool("unfold", ctx(a));
    const r = t.down([0, 30], { kind: "edge", id: "p1", side: 3, s: 190 }, {});
    assert.deepEqual(r.unfold, { id: "p1", side: 3 });
    const u = a.unfoldOps("p1", 3);
    a.commit(u.ops, "unfold", "p1");
    assert.deepEqual(a.problems(), []);
    near(area(a, "p1"), 6000, 1e-6);
    const w = outline(a, "p1");
    assert.equal(w.segments.length, 6);
    // the fold side is gone: no side runs along x = 0
    const pts = m.pathPoints(w);
    w.segments.forEach((s, i) => assert.ok(!(Math.abs(pts[i][0]) < 1e-9 && Math.abs(m.segmentEnd(s)[0]) < 1e-9), `side ${i} lies on the fold`));
    nearAll(a.drawing("p1").bounds, [-50, 0, 50, 60]);
    const U = node(a, "p1").meta.atelier.unfold;
    assert.deepEqual(U.axis, [0, 60, 0, 0]);
    assert.equal(U.half.path.segments.length, 4);
    assert.deepEqual(node(a, "p1").allowance, [1, 2, 3, 3, 2, 1]);
    assert.equal(node(a, "p1").notches.length, 2, "the notch and its mirror");
    nearAll(a.drawing("p1").notches.map((n) => n.slice(0, 2)).flat(), [20, 0, -20, 0], 1e-3);
    nearAll(a.drawing("p1").fold, [0, 0, 0, 60]);
    // the seam on H's right side stays on it: whole side 1
    assert.deepEqual(node(a, "s1").meta.atelier.a, [1, 0, 1]);
    near(node(a, "s1").a_from, 50); near(node(a, "s1").a_to, 110);
    // one undo: the half again
    a.undo();
    near(area(a, "p1"), 3000);
    a.redo();

    // an edit on the mirrored half (its corner (-50, 60), whole point 4) becomes the half
    const p = JSON.parse(JSON.stringify(w));
    p.segments[3].to = [-70, 80];
    a.commit(m.setOutline(a.nodes(), "p1", p), "edit", "p1");
    assert.deepEqual(a.problems(), []);
    const w2 = outline(a, "p1");
    nearAll(w2.segments[1].to, [70, 80], 1e-9);
    nearAll(w2.segments[3].to, [-70, 80], 1e-9);
    const h2 = node(a, "p1").meta.atelier.unfold.half.path;
    nearAll(h2.segments[1].to, [70, 80], 1e-9);
    near(node(a, "s1").a_from, 50);
    // a fold end moves only along the axis: whole point 0 (0, 0) dragged to (5, -10) lands on (0, -10)
    const q = JSON.parse(JSON.stringify(w2));
    q.start = [5, -10]; q.segments[5].to = [5, -10];
    a.commit(m.setOutline(a.nodes(), "p1", q), "edit", "p1");
    nearAll(outline(a, "p1").start, [0, -10], 1e-9);
    nearAll(outline(a, "p1").segments[5].to, [0, -10], 1e-9);

    // Fold back: the edited half, its seam kept
    const fb = a.foldBackOps("p1");
    assert.deepEqual(fb.dropped, []);
    a.commit(fb.ops, "fold back", "p1");
    assert.deepEqual(a.problems(), []);
    const h = outline(a, "p1");
    assert.equal(h.segments.length, 4);
    nearAll(h.start, [0, -10], 1e-9);
    nearAll(h.segments[1].to, [70, 80], 1e-9);
    assert.equal(node(a, "p1").meta?.atelier?.unfold, undefined);
    assert.deepEqual(node(a, "p1").allowance, [1, 2, 3, 4]);
    assert.equal(node(a, "p1").notches.length, 1);
    assert.ok(node(a, "s1"), "the seam on the half's side stays");
    a.free();
}
// a seam on the mirrored side is dropped by Fold back, and the status names it
{
    const a = halfPiece();
    a.commit(a.unfoldOps("p1", 3).ops, "unfold", "p1");
    // the whole's side 4 (from (-50, 60) to (-50, 0)), on the mirrored half, sewn to S
    const P = a.drawing("p1").sides;
    a.apply(m.addSeam(a.nodes(), { a: "p1", b: "p2", a_from: P[4], a_to: P[5], b_from: 170, b_to: 230, reversed: true, anchor: { a: [4, 0, 1], b: [3, 0, 1] } }).ops, "sew");
    const fb = a.foldBackOps("p1");
    assert.deepEqual(fb.dropped, ["s1"]);
    a.commit(fb.ops, "fold back", "p1");
    assert.equal(node(a, "s1"), undefined);
    a.undo();
    assert.ok(node(a, "s1"), "undo brings it back");
    a.free();
}
// a point inserted on the half: the mirror gains it, Unlink keeps the whole as it is
{
    const a = halfPiece();
    a.commit(a.unfoldOps("p1", 3).ops, "unfold", "p1");
    a.commit(a.pointOps({ id: "p1", op: "insert", s: 80 }), "point", "p1");
    assert.deepEqual(a.problems(), []);
    assert.equal(outline(a, "p1").segments.length, 8);
    assert.equal(node(a, "p1").meta.atelier.unfold.half.path.segments.length, 5);
    near(area(a, "p1"), 6000, 1e-6);
    a.commit(m.unlinkOps(a.nodes(), "p1"), "unlink");
    assert.equal(node(a, "p1").meta?.atelier?.unfold, undefined);
    const w = flat(outline(a, "p1"));
    const p = JSON.parse(JSON.stringify(outline(a, "p1")));
    p.segments[1].to = [60, 30];
    a.commit(m.setOutline(a.nodes(), "p1", p), "edit", "p1");
    assert.notEqual(flat(outline(a, "p1")), w);
    nearAll(outline(a, "p1").segments[5].to, [-50, 30], 1e-9, "the other half stays");
    a.free();
}
// a move takes the half and the axis with it; the next edit rebuilds about the moved fold
{
    const a = halfPiece();
    a.commit(a.unfoldOps("p1", 3).ops, "unfold", "p1");
    a.commit(m.pieceOps(a.nodes(), "p1", a.transformedPiece("p1", [1, 0, 100, 0, 1, 0])), "move", "p1");
    assert.deepEqual(node(a, "p1").meta.atelier.unfold.axis, [100, 60, 100, 0]);
    const p = JSON.parse(JSON.stringify(outline(a, "p1")));
    p.segments[0].to = [160, -5];
    a.commit(m.setOutline(a.nodes(), "p1", p), "edit", "p1");
    nearAll(outline(a, "p1").segments[4].to, [40, -5], 1e-9);
    a.free();
}
// Unfold refuses a curved side and a linked piece
{
    const a = halfPiece();
    a.apply(m.setOutline(a.nodes(), "p1", { start: [0, 0], segments: [{ type: "bezier", c1: [20, -10], c2: [30, -10], to: [50, 0] }, { type: "line", to: [50, 60] }, { type: "line", to: [0, 60] }, { type: "line", to: [0, 0] }] }), "curve");
    assert.throws(() => a.unfoldOps("p1", 0), /straight side/);
    a.free();
}
console.log("symmetry-kernel: ok");
