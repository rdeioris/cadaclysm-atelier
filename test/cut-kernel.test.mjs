// Cut and Cut & Sew against the kernel (spec §4): two pieces "<label> A" / "<label> B" with the
// fabric, grain, layer and allowance; seams follow their whole range or are dropped; notches and
// internal lines go to the piece holding them; one undo takes it all back; a cutter that does not
// cross the piece twice is refused and changes nothing.
import assert from "node:assert/strict";
import { loadKernel } from "./package.mjs";
import { Atelier } from "../kernel.js";
import * as m from "../model.js";

const k = await loadKernel();
const params = Object.fromEntries(m.FABRIC_FIELDS.map((n) => [n, 1]));
const near = (a, b, e = 1e-3) => assert.ok(Math.abs(a - b) < e, `${a} vs ${b}`);
function setup() {
    const a = new Atelier(k);
    a.reset(m.newDocumentOps({ slug: "x", label: "X", params }));
    const add = m.addPattern(a.nodes(), { label: "Front", path: m.rectPath(0, 0, 200, 100), fabric: "f_x", allowance: 10, grain: [1, 0] });
    const pat = add.ops.find((o) => o.node?.kind === "garment.pattern").node;
    pat.notches = [{ at: 50, kind: "slit", depth: 6 }, { at: 150, kind: "slit", depth: 6 }];
    pat.internal = [{ kind: "line", path: { start: [20, 20], segments: [{ type: "line", to: [40, 40] }] } }];
    a.apply(add.ops, "front");
    a.apply(m.addPattern(a.nodes(), { label: "Back", path: m.rectPath(300, 0, 200, 100), fabric: "f_x" }).ops, "back");
    // s1: Front's bottom (0..200, split by the cut), s2: Front's right side (200..300, all on B)
    a.apply(m.addSeam(a.nodes(), { a: "p1", b: "p2", a_from: 0, a_to: 200, b_from: 0, b_to: 200, reversed: true, anchor: { a: [0, 0, 1], b: [0, 0, 1] } }).ops, "s1");
    a.apply(m.addSeam(a.nodes(), { a: "p1", b: "p2", a_from: 200, a_to: 300, b_from: 500, b_to: 600, reversed: true, anchor: { a: [1, 0, 1], b: [3, 0, 1] } }).ops, "s2");
    return a;
}
const cutter = { start: [100, -20], segments: [{ type: "line", to: [100, 120] }] };

{
    const a = setup();
    const r = a.cutOps("p1", cutter, { sew: false });
    assert.deepEqual(r.dropped, ["s1"]);
    a.apply(r.ops, "cut");
    const pats = a.nodes().filter((n) => n.kind === "garment.pattern");
    assert.deepEqual(pats.map((p) => p.label).sort(), ["Back", "Front A", "Front B"]);
    const [A, B] = r.ids.map((id) => m.byId(a.nodes()).get(id));
    for (const p of [A, B]) {
        assert.equal(p.fabric, "f_x"); assert.deepEqual(p.grain, [1, 0]); assert.deepEqual(p.allowance, [10]);
        assert.deepEqual(a.drawing(p.id).bounds.map(Math.round).filter((_, i) => i % 2 === 1), [0, 100], "full height");
    }
    const left = a.drawing(A.id).bounds[0] < 50 ? A : B, right = left === A ? B : A;
    assert.deepEqual(left.notches.length, 1); assert.deepEqual(right.notches.length, 1);
    assert.equal((left.internal ?? []).length, 1, "the internal line stays on the piece holding it");
    const s2 = m.byId(a.nodes()).get("s2");
    assert.equal(s2.a, right.id, "s2 follows its range");
    near(Math.abs(s2.a_to - s2.a_from), 100, 0.6);
    assert.equal(m.byId(a.nodes()).get("s1"), undefined);
    assert.deepEqual(a.problems(), []);
    assert.equal(a.undo(), true);
    assert.deepEqual(a.nodes().filter((n) => n.kind === "garment.pattern").map((p) => p.label), ["Front", "Back"], "one undo");
    a.free();
}
{
    const a = setup();
    const r = a.cutOps("p1", cutter, { sew: true });
    a.apply(r.ops, "cut & sew");
    const sewn = a.nodes().filter((n) => n.kind === "garment.seam" && r.ids.includes(n.a) && r.ids.includes(n.b));
    assert.equal(sewn.length, 1, "one seam joins the cut edges");
    near(Math.abs(sewn[0].a_to - sewn[0].a_from), 100, 0.6);
    near(Math.abs(sewn[0].b_to - sewn[0].b_from), 100, 0.6);
    assert.deepEqual(a.issues().filter((i) => i.severity === "error"), []);
    a.free();
}
{
    const a = setup();
    const before = a.save();
    assert.throws(() => a.cutOps("p1", { start: [100, -20], segments: [{ type: "line", to: [100, 50] }] }, { sew: false }), /cross/);
    assert.equal(a.save(), before, "a refused cut changes nothing");
    a.free();
}

// Holes (Tasks 14-15): a hole wholly in one half stays a hole of that piece; a cutter that
// crosses or touches a hole is refused, changing nothing (no hole is ever dropped).
const square = (x, y, s) => ({ start: [x, y], segments: [[x + s, y], [x + s, y + s], [x, y + s], [x, y]].map((to) => ({ type: "line", to })) });
function holed() {
    const a = setup();
    a.apply(m.addHole(a.nodes(), "p1", square(50, 60, 20)), "hole left");
    a.apply(m.addHole(a.nodes(), "p1", square(140, 40, 20)), "hole right");
    return a;
}
{
    const a = holed();
    const r = a.cutOps("p1", cutter, { sew: false });
    a.apply(r.ops, "cut");
    const paths = r.ids.map((id) => m.byId(a.nodes()).get(`${id}_outline`).path);
    const leftK = a.drawing(r.ids[0]).bounds[0] < 50 ? 0 : 1;
    assert.deepEqual(paths[leftK].holes?.map((h) => h.start), [[50, 60]], "the left hole goes with the left half");
    assert.deepEqual(paths[1 - leftK].holes?.map((h) => h.start), [[140, 40]], "the right hole with the right half");
    for (const id of r.ids) assert.equal(a.drawing(id).holes.length, 1, "each new piece draws its hole");
    assert.deepEqual(a.problems(), []);
    a.free();
}
{
    const a = holed();
    const before = a.save();
    assert.throws(() => a.cutOps("p1", { start: [150, -20], segments: [{ type: "line", to: [150, 120] }] }, { sew: false }), /hole 2/);
    assert.throws(() => a.cutOps("p1", { start: [160, -20], segments: [{ type: "line", to: [160, 120] }] }, { sew: true }), /hole 2/, "touching a hole's side");
    assert.equal(a.save(), before, "a refused cut changes nothing");
    a.free();
}

// Cut along an internal line (`consume`): the line is the cut, on neither piece; a per-side
// allowance collapses to its first width (ruling 14) and says so.
{
    const a = setup();
    const p1 = m.byId(a.nodes()).get("p1");
    a.apply(m.setPattern(a.nodes(), "p1", { allowance: [10, 12, 10, 10], internal: [...p1.internal, { kind: "line", path: { start: [120, 0], segments: [{ type: "line", to: [120, 100] }] } }] }), "line");
    const r = a.cutOps("p1", { start: [120, 0], segments: [{ type: "line", to: [120, 100] }] }, { consume: 1 });
    assert.equal(r.collapsed, true);
    a.apply(r.ops, "cut");
    const [A, B] = r.ids.map((id) => m.byId(a.nodes()).get(id));
    assert.deepEqual([A.allowance, B.allowance], [[10], [10]]);
    assert.deepEqual([...(A.internal ?? []), ...(B.internal ?? [])].map((l) => l.path.start), [[20, 20]], "the cut line is consumed, the other kept");
    assert.deepEqual(a.problems(), []);
    a.free();
}

// A polyline cutter: an L across a corner cuts that corner off.
{
    const a = setup();
    const r = a.cutOps("p1", { start: [-20, 50], segments: [{ type: "line", to: [100, 50] }, { type: "line", to: [100, 120] }] }, { sew: true });
    a.apply(r.ops, "cut & sew");
    const boxes = r.ids.map((id) => a.drawing(id).bounds.map((v) => Math.round(v)));
    assert.ok(boxes.some((b) => JSON.stringify(b) === "[0,50,100,100]"), JSON.stringify(boxes));
    assert.ok(boxes.some((b) => JSON.stringify(b) === "[0,0,200,100]"), JSON.stringify(boxes));
    const sewn = a.nodes().filter((n) => n.kind === "garment.seam" && r.ids.includes(n.a) && r.ids.includes(n.b));
    assert.equal(sewn.length, 1);
    near(Math.abs(sewn[0].a_to - sewn[0].a_from), 150, 0.6);
    assert.deepEqual(a.issues().filter((i) => i.severity === "error"), []);
    a.free();
}
console.log("cut-kernel: ok");
