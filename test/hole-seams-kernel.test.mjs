// Sewing hole edges (A2 spec §2, plan B7) against the real kernel: a front with an armhole cut as
// a hole and a sleeve whose cap is sewn to it -- Segment sewing on a hole side, a free range on
// the hole (through its start), an M:N group with ranges on the hole, an outline point insert and
// removal that leave the hole anchors where they are, a cut that renumbers the hole, save and
// open, one undo step per sew, and the cloth built with the hole seam's pairs (the drape probe).
import assert from "node:assert/strict";
import { loadKernel } from "./package.mjs";
import { Atelier } from "../kernel.js";
import * as m from "../model.js";
import { makeTool } from "../tools.js";
import { hitOf } from "../view2d.js";
import { reanchor, loopOf } from "../sewing.js";
import { Drape } from "../cloth.js";
import { statusOf } from "../drape.js";
import { presetParams } from "../fabrics.js";

const k = await loadKernel();
const params = presetParams("cotton_jersey");
const near = (x, y, tol = 1e-6, what = "") => assert.ok(Math.abs(x - y) <= tol, `${what} ${x} vs ${y}`);

// p1 the front, 300 x 400, with the armhole: an ellipse hole (the kernel's four conic quarters,
// counter-clockwise from (230, 300)); p2 the sleeve, 200 x 150, its cap the top side (side 2,
// 350..550 of its arc length)
function setup() {
    const a = new Atelier(k);
    a.apply(m.newDocumentOps({ slug: "x", label: "Cotton jersey", params }), "new");
    a.apply(m.addPattern(a.nodes(), { label: "Front", path: m.rectPath(0, 0, 300, 400), fabric: "f_x" }).ops, "front");
    a.apply(m.addPattern(a.nodes(), { label: "Sleeve", path: m.rectPath(400, 0, 200, 150), fabric: "f_x" }).ops, "sleeve");
    a.apply(m.addHole(a.nodes(), "p1", a.ellipsePath(200, 300, 30, 50)), "armhole");
    assert.deepEqual(a.problems(), []);
    return a;
}
const errors = (a) => a.issues().filter((i) => i.severity === 0);
const ctx = (a) => ({ nodes: a.nodes(), drawings: new Map(a.drawings().map((d) => [d.id, d])) });
const pick = (point) => ({ item: 1, node: 0, face: 0, point: [...point, 0], segment: 0, distancePx: 1 });
// a click on hole 0 of p1 at arc length s on the hole, decoded as the 2D window decodes it
// (view2d.js hitOf on the kernel's hole samples)
function holeHit(a, s) {
    const d = a.drawing("p1"), smp = d.holes[0].samples;
    let i = 0;
    while (i + 3 < smp.length && smp[i + 3] <= s) i += 3;
    const t = smp.length > i + 3 ? (s - smp[i]) / (smp[i + 3] - smp[i]) : 0;
    const x = smp.length > i + 3 ? smp[i + 1] + t * (smp[i + 4] - smp[i + 1]) : smp[i + 1];
    const y = smp.length > i + 3 ? smp[i + 2] + t * (smp[i + 5] - smp[i + 2]) : smp[i + 2];
    return hitOf({ kind: "hole", id: "p1", index: 0 }, pick([x, y]), ctx(a).drawings);
}
const edgeHit = (a, id, s) => { const sides = a.drawing(id).sides; return { kind: "edge", id, s, side: sides.findIndex((v, i) => s >= v && s < sides[i + 1]) }; };
const seamNode = (a, id) => a.nodes().find((n) => n.id === id);
const seamIndex = (a, id) => a.nodes().find((n) => n.id === "garment").seams.indexOf(id);
const row = (a, id) => Array.from(k.cadaclysm_blacksmith_garment_seam(a.g, seamIndex(a, id)));
// every point of a seam end within `tol` mm of the hole's samples
function onHole(a, flat, tol = 0.6) {
    const smp = a.drawing("p1").holes[0].samples;
    for (let i = 0; i + 1 < flat.length; i += 2) {
        let best = Infinity;
        for (let j = 0; j + 2 < smp.length; j += 3) best = Math.min(best, Math.hypot(smp[j + 1] - flat[i], smp[j + 2] - flat[i + 1]));
        assert.ok(best < tol, `point ${flat[i]}, ${flat[i + 1]} is ${best} mm off the hole`);
    }
}

// The drawing: each hole's samples and sides in the hole's own arc length
{
    const a = setup();
    const h = a.drawing("p1").holes[0];
    assert.equal(h.sides.length, 5, "four conic quarters");
    near(h.sides[0], 0); near(h.samples[0], 0);
    near(h.samples[1], 230, 1e-6, "the hole's samples start at its start point"); near(h.samples[2], 300, 1e-6);
    // Ramanujan's perimeter of the 30 x 50 ellipse: 255.27 mm
    near(h.sides.at(-1), Math.PI * (3 * 80 - Math.sqrt(180 * 140)), 0.05, "the hole's perimeter");
    // a pick on the hole: its arc length and side on the hole
    const hit = holeHit(a, 100);
    assert.equal(hit.kind, "hole"); assert.equal(hit.loop, 1); near(hit.s, 100, 0.05); assert.equal(hit.side, h.sides.findIndex((v, i) => 100 >= v && 100 < h.sides[i + 1]));
    a.free();
}

// Segment sewing: the sleeve's cap onto the armhole's top-left quarter (hole side 1)
{
    const a = setup();
    const sides = a.drawing("p1").holes[0].sides;
    const t = makeTool("segment", ctx(a));
    const h = holeHit(a, (sides[1] + sides[2]) / 2 - 5);   // nearer its start: the range runs with the arc
    assert.equal(h.side, 1);
    assert.ok(t.down([0, 0], h, {}).overlay.lines[0].length > 10, "the picked hole side is drawn");
    const head0 = a.head();
    const r = t.down([0, 0], edgeHit(a, "p2", 420), {});
    assert.ok(r.done && r.ops.length);
    const add = r.ops.find((o) => o.op === "add").node;
    assert.equal(add.a_loop, 1); assert.equal(add.b_loop, undefined, "an outline end writes no loop");
    near(add.a_from, sides[1]); near(add.a_to, sides[2]);
    assert.deepEqual(add.meta.atelier.a, [1, 0, 1, 1, 1], "a hole anchor: the 5-form with the loop");
    assert.deepEqual(add.meta.atelier.b, [2, 0, 1], "an outline anchor as before");
    a.apply(r.ops, "sew");
    assert.deepEqual(errors(a), [], "the garment validates");
    const rw = row(a, add.id);
    assert.equal(rw.length, 9);
    near(rw[1], sides[1]); near(rw[2], sides[2]);
    assert.deepEqual([rw[7], rw[8]], [1, 0], "garment_seam reads the loops back");
    const s = a.seams().find((x) => x.id === add.id);
    assert.equal(s.a_loop, 1);
    onHole(a, s.points_a);
    // one undo step takes the sew back
    assert.equal(a.undo(), true);
    assert.equal(a.nodes().some((n) => n.kind === "garment.seam"), false);
    assert.equal(a.head(), head0, "one undo step");
    a.redo();
    assert.equal(seamNode(a, add.id).a_loop, 1);
    // a click on the hole seam's line answers that hole, with the seam (the Edit tool selects it)
    const d = ctx(a).drawings;
    const ed = makeTool("edit", ctx(a));
    const sh = hitOf({ kind: "seam", id: add.id, pattern: "p1", loop: 1 }, pick([s.points_a[0], s.points_a[1]]), d);
    assert.deepEqual([sh.kind, sh.loop, sh.seam], ["hole", 1, add.id]);
    ed.down([0, 0], sh, {});
    assert.deepEqual(ed.up([0, 0], sh, {}).select, { kind: "seam", id: add.id });
    a.free();
}

// Free sewing: Shift-free clicks on the hole, through its start (from > to: the short wrapped range)
{
    const a = setup();
    const P = a.drawing("p1").holes[0].sides.at(-1);
    const t = makeTool("free", ctx(a));
    t.down([0, 0], holeHit(a, P - 30), {});
    // the second click of a pair on the outline of the same piece is refused: another loop
    assert.deepEqual(t.down([0, 0], edgeHit(a, "p1", 50), {}), {});
    t.down([0, 0], holeHit(a, 40), {});
    t.down([0, 0], edgeHit(a, "p2", 400), {});
    const r = t.down([0, 0], edgeHit(a, "p2", 470), {});
    const add = r.ops.find((o) => o.op === "add").node;
    assert.equal(add.a_loop, 1);
    near(add.a_from, P - 30, 0.05); near(add.a_to, 40, 0.05);
    assert.equal(add.meta.atelier.a.length, 5); assert.equal(loopOf(add.meta.atelier.a), 1);
    assert.equal(add.meta.atelier.a[0], 3, "starts on the last hole side"); assert.equal(add.meta.atelier.a[3], 0, "ends on the first");
    assert.equal(add.reversed, false);
    a.apply(r.ops, "sew free");
    assert.deepEqual(errors(a), []);
    assert.deepEqual(row(a, add.id).slice(7), [1, 0]);
    const s = a.seams().find((x) => x.id === add.id);
    onHole(a, s.points_a);
    const flat = s.points_a, len = (() => { let l = 0; for (let i = 2; i < flat.length; i += 2) l += Math.hypot(flat[i] - flat[i - 2], flat[i + 1] - flat[i - 1]); return l; })();
    near(len, 70, 1, "the short way round, 70 mm");
    a.free();
}

// M:N: the sleeve's cap (A, one outline range) onto two ranges on the hole (B): hole side 1 and
// a free range on hole side 2
{
    const a = setup();
    const hs = a.drawing("p1").holes[0].sides;
    const t = makeTool("sewmn", ctx(a));
    t.down([0, 0], edgeHit(a, "p2", 380), {});
    t.key("Enter");
    t.down([0, 0], holeHit(a, hs[1] + 3), {});
    t.down([0, 0], holeHit(a, hs[2] + 5), { shift: true });
    const o = t.down([0, 0], holeHit(a, hs[2] + 45), { shift: true });
    assert.equal(o.overlay.lines.length, 3, "each picked range drawn, the hole's too");
    const r = t.key("Enter");
    a.apply(r.ops, "sew M:N");
    assert.deepEqual(errors(a), []);
    const members = r.select.ids.map((id) => seamNode(a, id));
    assert.equal(members.length, 2, "1 + 2 - 1 seams");
    assert.ok(members.every((n) => n.b_loop === 1 && !n.a_loop), "every member's B end is on the hole");
    // distribution by length: the B lengths add up to the hole ranges', the A lengths to the cap
    const sum = (end) => members.reduce((t2, n) => t2 + (n[`${end}_to`] - n[`${end}_from`]), 0);
    near(sum("b"), (hs[2] - hs[1]) + 40, 1e-6, "B: hole side 1 + 40 mm");
    near(sum("a"), 200, 1e-6, "A: the cap");
    for (const n of members) {
        const rw = row(a, n.id);
        assert.deepEqual(rw.slice(7), [0, 1]);
        assert.equal(loopOf(n.meta.atelier.b), 1); assert.equal(loopOf(n.meta.atelier.a), 0);
        // each member's B is the same fraction of B as its A is of A
        near((n.b_to - n.b_from) / sum("b"), (n.a_to - n.a_from) / 200, 1e-6, "proportional");
    }
    assert.ok(members[0].meta.atelier.group.b.every((g) => loopOf(g.anchor) === 1), "the group's B ranges are on the hole");
    // re-distribution through the same lengths: the sleeve 20 % wider re-distributes the group,
    // the hole ranges unchanged
    const before = members.map((n) => [n.b_from, n.b_to]);
    a.commit(m.setOutline(a.nodes(), "p2", m.rectPath(400, 0, 240, 150)), "wider", "p2");
    const after = a.nodes().filter((n) => n.meta?.atelier?.group);
    assert.equal(after.length, members.length);
    after.forEach((n, i) => { near(n.b_from, before[i][0]); near(n.b_to, before[i][1]); assert.equal(n.b_loop, 1); });
    near(after.reduce((t2, n) => t2 + n.a_to - n.a_from, 0), 240, 1e-6, "A: the wider cap");
    assert.deepEqual(errors(a), []);
    a.free();
}

// An outline point insert or removal on the front leaves its hole anchors where they are
{
    const a = setup();
    const hs = a.drawing("p1").holes[0].sides;
    a.apply(m.addSeam(a.nodes(), { a: "p1", b: "p2", a_from: hs[1], a_to: hs[2], b_from: 350, b_to: 550, a_loop: 1, anchor: { a: [1, 0, 1, 1, 1], b: [2, 0, 1] } }).ops, "sew");
    // and one on the outline, which moves
    a.apply(m.addSeam(a.nodes(), { a: "p1", b: "p2", a_from: 300, a_to: 700, b_from: 0, b_to: 200, anchor: { a: [1, 0, 1], b: [0, 0, 1] } }).ops, "sew 2");
    const holeSeam = () => seamNode(a, "s1"), outSeam = () => seamNode(a, "s2");
    const keep = JSON.stringify([holeSeam().a_from, holeSeam().a_to, holeSeam().a_loop, holeSeam().meta.atelier.a]);
    a.commit(a.pointOps({ id: "p1", op: "insert", s: 150 }), "point", "p1");
    assert.equal(JSON.stringify([holeSeam().a_from, holeSeam().a_to, holeSeam().a_loop, holeSeam().meta.atelier.a]), keep, "the hole anchor did not move");
    assert.deepEqual(outSeam().meta.atelier.a, [2, 0, 1], "the outline anchor moved up a side");
    a.commit(a.pointOps({ id: "p1", op: "remove", indices: [1] }), "point", "p1");
    assert.equal(JSON.stringify([holeSeam().a_from, holeSeam().a_to, holeSeam().a_loop, holeSeam().meta.atelier.a]), keep, "nor on a removal");
    assert.deepEqual(outSeam().meta.atelier.a, [1, 0, 1]);
    assert.deepEqual(errors(a), []);
    // a hole the piece no longer has: the re-anchor drops the seam and names it
    const gone = reanchor(a.nodes(), new Map([["p1", { sides: a.drawing("p1").sides, holes: [] }]]), "p1");
    assert.deepEqual(gone.removed, ["s1"]);
    a.free();
}

// A cut beside the hole: the seam goes with the hole, renumbered among the new piece's holes
{
    const a = setup();
    a.apply(m.addHole(a.nodes(), "p1", m.rectPath(20, 20, 40, 40)), "pocket");   // hole 2 (loop 2), left of the cut
    a.apply(m.addHole(a.nodes(), "p1", m.rectPath(240, 20, 40, 40)), "pocket 2"); // hole 3 (loop 3), right of it
    const s2 = a.drawing("p1").holes[2].sides;
    a.apply(m.addSeam(a.nodes(), { a: "p1", b: "p2", a_from: s2[0], a_to: s2[1], b_from: 0, b_to: 40, a_loop: 3, anchor: { a: [0, 0, 1, 0, 3], b: [0, 0, 0.2] } }).ops, "sew pocket");
    assert.deepEqual(errors(a), []);
    const r = a.cutOps("p1", { start: [100, -20], segments: [{ type: "line", to: [100, 420] }] }, { sew: false });
    assert.deepEqual(r.dropped, []);
    a.apply(r.ops, "cut");
    const s = seamNode(a, "s1"), right = r.ids.find((id) => a.drawing(id).bounds[0] > 50);
    assert.equal(s.a, right);
    assert.equal(a.drawing(right).holes.length, 2, "the armhole and the right pocket");
    assert.equal(s.a_loop, 2, "the pocket is the right piece's hole 2");
    assert.deepEqual(s.meta.atelier.a, [0, 0, 1, 0, 2]);
    assert.deepEqual(errors(a), []);
    assert.deepEqual(row(a, "s1").slice(7), [2, 0]);
    a.free();
}

// Save and open: the loops and the 5-form anchors round-trip; a seam with a loop but no anchor
// (an older or hand-made file) is anchored on its hole when opened
{
    const a = setup();
    const hs = a.drawing("p1").holes[0].sides;
    a.apply(m.addSeam(a.nodes(), { a: "p2", b: "p1", a_from: 350, a_to: 550, b_from: hs[0], b_to: hs[2], b_loop: 1, reversed: true, anchor: { a: [2, 0, 1], b: [0, 0, 1, 1, 1] } }).ops, "sew");
    a.apply(m.addSeam(a.nodes(), { a: "p1", b: "p2", a_from: hs[2] + 10, a_to: hs[3], b_from: 0, b_to: 100, a_loop: 1 }).ops, "sew, no anchor");
    const text = a.save();
    const saved = JSON.parse(text).nodes.filter((n) => n.kind === "garment.seam");
    assert.equal(saved[0].b_loop, 1); assert.equal(saved[0].a_loop, undefined, "an outline end writes no loop");
    const b = new Atelier(k);
    b.load(text);
    const n1 = seamNode(b, "s1"), n2 = seamNode(b, "s2");
    assert.equal(n1.b_loop, 1); assert.deepEqual(n1.meta.atelier.b, [0, 0, 1, 1, 1]);
    assert.equal(n2.a_loop, 1); assert.equal(loopOf(n2.meta.atelier.a), 1, "anchored on the hole when opened");
    assert.equal(n2.meta.atelier.a[0], 2); near(n2.meta.atelier.a[1], 10 / (hs[3] - hs[2])); near(n2.meta.atelier.a[2], 1);
    assert.deepEqual(errors(b), []);
    assert.deepEqual(row(b, "s1").slice(7), [0, 1]);
    assert.deepEqual(b.seams().map((s) => s.points_b), a.seams().map((s) => s.points_b), "drawn the same");
    // and saved again, the same seams
    const again = JSON.parse(b.save()).nodes.filter((n) => n.kind === "garment.seam");
    assert.deepEqual(again[0], saved[0]);
    a.free(); b.free();
}

// The drape probe: the cloth's seam pairs include the hole seam's, and the sewing welds them.
// A rectangle armhole near the front's edge, its right side (hole side 1, 80 mm) sewn with
// Segment sewing to the sleeve's left side (80 mm); the front in the x-y plane, the sleeve
// framed 20 mm in front of it over the armhole (no avatar, gravity off while sewing).
{
    const a = new Atelier(k);
    a.apply(m.newDocumentOps({ slug: "x", label: "Cotton jersey", params }), "new");
    a.apply(m.addPattern(a.nodes(), { label: "Front", path: m.rectPath(0, 0, 300, 400), fabric: "f_x" }).ops, "front");
    a.apply(m.addPattern(a.nodes(), { label: "Sleeve", path: m.rectPath(400, 0, 100, 80), fabric: "f_x" }).ops, "sleeve");
    a.apply(m.addHole(a.nodes(), "p1", m.rectPath(220, 300, 60, 80)), "armhole");
    a.apply([...m.setPattern(a.nodes(), "p1", { frame: { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0] } }),
        ...m.setPattern(a.nodes(), "p2", { frame: { origin: [-120, 300, 20], x: [1, 0, 0], y: [0, 1, 0] } })], "frames");
    const pairsOf = () => { const d = new Drape(k, null); d.build(a.save()); return { d, pairs: statusOf(d.status()).seamPairs }; };
    const base = pairsOf(); base.d.free();
    assert.equal(base.pairs, 0);
    const hs = a.drawing("p1").holes[0].sides;
    near(hs[2] - hs[1], 80, 1e-6, "hole side 1");
    const t = makeTool("segment", ctx(a));
    t.down([0, 0], holeHit(a, hs[1] + 10), {});
    // the sleeve's left side runs (400, 80) -> (400, 0): a click near its end, so reversed
    const r = t.down([0, 0], edgeHit(a, "p2", 350), {});
    const add = r.ops.find((o) => o.op === "add").node;
    assert.deepEqual([add.a_loop, add.b_loop, add.reversed], [1, undefined, true]);
    a.apply(r.ops, "sew to the hole");
    assert.deepEqual(errors(a).map((i) => i.message), []);
    const { d, pairs } = pairsOf();
    assert.ok(pairs > 0, "the hole seam gives the cloth seam pairs");
    let s = statusOf(d.status());
    for (let f = 0; f < 400 && s.welded < s.seamPairs; f++) { d.step(); s = statusOf(d.status()); }
    assert.equal(s.nonFinite, 0);
    console.log(`  drape probe: ${pairs} seam pairs on the hole, ${s.welded} welded after ${s.frame} frames`);
    assert.equal(s.welded, s.seamPairs, "every pair of the hole seam welded");
    // and welded onto the hole's edge: a few frames on, each sleeve particle on its sewn side
    // (pattern x = 400) lies within 2 mm of a front particle on the hole's right side (x = 280)
    for (let f = 0; f < 20; f++) d.step();
    const pos = d.positions(), uv = k.cadaclysm_blacksmith_cloth_vertex_links(d.h), topo = d.topology();
    const on = (id, test) => Array.from(topo.vertexPatterns).map((pi, v) => (topo.patterns[pi] === id && test(uv[2 * v], uv[2 * v + 1]) ? v : -1)).filter((v) => v >= 0);
    const sleeveSide = on("p2", (u) => Math.abs(u - 400) < 1e-3), holeSide = on("p1", (u, v) => Math.abs(u - 280) < 1e-3 && v > 299 && v < 381);
    assert.ok(sleeveSide.length >= 2 && holeSide.length >= 2, `${sleeveSide.length} sleeve and ${holeSide.length} hole particles on the seam`);
    const gap = (v) => Math.min(...holeSide.map((w) => Math.hypot(pos[3 * v] - pos[3 * w], pos[3 * v + 1] - pos[3 * w + 1], pos[3 * v + 2] - pos[3 * w + 2])));
    const worst = Math.max(...sleeveSide.map(gap));
    assert.ok(worst < 2, `the sleeve's side is on the hole's edge: worst ${worst.toFixed(2)} mm`);
    d.free(); a.free();
}
console.log("hole-seams-kernel: ok");
