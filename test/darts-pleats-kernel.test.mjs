// Darts and pleats (S2 spec §1, §5) against the real kernel: kernel.js runs garment_close_dart_cut,
// _folded, garment_rotate_dart and garment_add_pleats / _remove_pleats on a scratch copy of the
// garment and turns what changed into document ops (one commit, one undo step); the document
// evaluates back to the same garment.
import assert from "node:assert/strict";
import { loadKernel } from "./package.mjs";
import { Atelier } from "../kernel.js";
import * as m from "../model.js";
import { addTack } from "../tacks.js";
import { pleatDraft, pleatSpec, s2Request, groupOfLine } from "../pleats.js";
import { garmentChange } from "../drape.js";

const k = await loadKernel();
const params = Object.fromEntries(m.FABRIC_FIELDS.map((n) => [n, 1]));
const node = (a, id) => m.byId(a.nodes()).get(id);
const near = (x, y, tol = 1e-6) => Math.abs(x - y) <= tol;
const hasPoint = (path, [x, y]) => [path.start, ...path.segments.map((s) => s.to)].some((p) => near(p[0], x, 1e-6) && near(p[1], y, 1e-6));
const dart = (x) => ({ kind: "dart", path: { start: [x - 20, 300], segments: [{ type: "line", to: [x, 200] }, { type: "line", to: [x + 20, 300] }] } });

// A (p1, 200 x 300) sewn to B (p2) along A's right side, a tack between them; on A a cut-able
// waist dart at x = 100 (from the hem) with the Dart tool's two slit notches, and a fold line.
function fixture() {
    const a = new Atelier(k);
    a.reset(m.newDocumentOps({ slug: "x", label: "X", params }));
    a.apply(m.addPattern(a.nodes(), { label: "A", path: m.rectPath(0, 0, 200, 300), fabric: "f_x" }).ops, "a");
    a.apply(m.addPattern(a.nodes(), { label: "B", path: m.rectPath(300, 0, 200, 300), fabric: "f_x" }).ops, "b");
    a.apply(m.addSeam(a.nodes(), { a: "p1", b: "p2", a_from: 200, a_to: 500, b_from: 600, b_to: 900, reversed: true, anchor: { a: [1, 0, 1], b: [3, 0, 1] } }).ops, "seam");
    a.apply(addTack(a.nodes(), { a: "p1", a_at: [10, 10], b: "p2", b_at: [310, 10] }).ops, "tack");
    a.apply(m.setPattern(a.nodes(), "p1", {
        internal: [dart(100), { kind: "fold", angle: 90, path: { start: [10, 50], segments: [{ type: "line", to: [190, 50] }] } }],
        notches: [{ at: 580, kind: "slit", depth: 6 }, { at: 620, kind: "slit", depth: 6 }],
    }), "dart");
    return a;
}
const kernelTacks = (a) => a.f("garment_tacks")(a.g).length / 7;

// ---- Close (cut): the outline takes the legs, a seam sews them, the mark goes; one undo ----
{
    const a = fixture();
    const before = a.nodes();
    const ops = a.dartOps("p1", 0, "cut");
    a.commit(ops, "close dart (cut)");
    const p = node(a, "p1"), outline = node(a, "p1_outline").path;
    assert.ok(hasPoint(outline, [100, 200]) && hasPoint(outline, [80, 300]) && hasPoint(outline, [120, 300]), "the apex and the legs' ends are outline points");
    assert.deepEqual(p.internal.map((l) => l.kind), ["fold"], "the mark removed, the fold kept");
    assert.equal(p.internal[0].angle, 90, "the fold keeps its angle");
    const g = node(a, "garment");
    assert.equal(g.seams.length, 2, "a seam sewing the legs");
    const s = node(a, g.seams[1]);
    assert.equal(s.a, "p1"); assert.equal(s.b, "p1");
    assert.ok(near(s.a_to - s.a_from, s.b_to - s.b_from, 1e-6), "the two legs are as long");
    assert.ok(s.meta.atelier.a && s.meta.atelier.b, "the new seam is anchored");
    assert.equal(node(a, "s1").a_from, 200, "the old seam keeps its range (before the dart)");
    assert.ok(node(a, "s1").meta.atelier.a.every((v, i) => near(v, [1, 0, 1][i], 1e-9)), "and its side");
    assert.equal(a.issues().filter((i) => i.severity === "error").length, 0, "evaluates without errors");
    // the area shrinks by the wedge: 20 x 100 x 2 / 2 = 2000 mm²
    assert.ok(near(a.withOutline("p1", (q) => Math.abs(a.f("profile_area_properties")(q, 1e-9)[0])), 60000 - 2000, 1e-3), "area less the wedge");
    assert.equal(garmentChange(before, a.nodes()).kind, "stale", "a new seam: the cloth rebuilds");
    a.undo();
    assert.deepEqual(node(a, "p1").internal.map((l) => l.kind), ["dart", "fold"], "one undo takes it back");
    assert.equal(node(a, "garment").seams.length, 1);
}

// ---- Close (fold): legs, a 360° centre fold, tacks pairing the legs; the document carries them back ----
{
    const a = fixture();
    const before = a.nodes();
    a.commit(a.dartOps("p1", 0, "fold"), "close dart (fold)");
    const p = node(a, "p1");
    assert.deepEqual(p.internal.map((l) => l.kind), ["line", "fold", "line", "fold"]);
    assert.equal(p.internal[3].angle, 360, "the centre line folds fully back");
    assert.equal(p.internal[1].angle, 90, "the old fold kept");
    const g = node(a, "garment");
    assert.equal(g.tacks.length, 6, "five tacks made beside the one there was");
    for (const t of g.tacks.slice(1)) { const n = node(a, t); assert.equal(n.a, "p1"); assert.equal(n.b, "p1"); }
    assert.deepEqual(node(a, "p1_outline").path, before.find((n) => n.id === "p1_outline").path, "the outline unchanged");
    assert.equal(kernelTacks(a), 6, "the evaluated garment has them");
    assert.equal(garmentChange(before, a.nodes()).kind, "stale", "new tacks: the cloth rebuilds");
    a.undo();
    assert.equal(node(a, "garment").tacks.length, 1);
}

// ---- Rotate: the dart moves to the outline point; the seam after the rotated stretch re-anchors ----
{
    const a = fixture();
    const len = () => a.withOutline("p1", (q) => a.f("profile_length")(q, 1e-9)[0]);
    const area = () => a.withOutline("p1", (q) => Math.abs(a.f("profile_area_properties")(q, 1e-9)[0]));
    const [L0, A0] = [len(), area()];
    assert.throws(() => a.dartOps("p1", 0, "rotate", 600), /dart refused \(InsideDart\)/, "not into the dart itself");
    const to = a.outlineArcNear("p1", [50, 0.4], 2);
    assert.ok(near(to, 50, 1e-3), "the arc length at the pointer");
    assert.throws(() => a.outlineArcNear("p1", [50, 30], 2), /outline/, "too far from the outline");
    a.commit(a.dartOps("p1", 0, "rotate", to), "rotate dart");
    const d = node(a, "p1").internal[0];
    assert.equal(d.kind, "dart");
    assert.ok(near(d.path.segments[0].to[0], 100) && near(d.path.segments[0].to[1], 200), "the apex stays");
    assert.ok(near(d.path.start[0], 50) && near(d.path.start[1], 0), "the dart opens at the point");
    assert.ok(len() > L0 && area() !== A0, `the outline reshaped (${len()} vs ${L0}, ${area()} vs ${A0})`);
    const s1 = node(a, "s1");
    assert.ok(s1.a_from !== 200, "the seam's range moved with the outline");
    const sides = a.sidesOf("p1"), an = s1.meta.atelier.a;
    assert.ok(near(sides[an[0]] + an[1] * (sides[an[0] + 1] - sides[an[0]]), s1.a_from, 1e-6), "anchored at its new start");
    // a refusal leaves the document as it was and names the fault
    const head = a.head();
    assert.throws(() => a.dartOps("p1", 0, "rotate", s1.a_from + 10), /dart refused \(OnSeam\)/);
    assert.equal(a.head(), head);
    assert.throws(() => a.dartOps("p1", 1, "cut"), /not a dart/);
}

// ---- Pleats: added (prefolded folds, top tacks, the group on the pattern), edited, removed ----
{
    const a = fixture();
    const draft = pleatDraft([[320, 300], [320, 0]], [[320, 150], [480, 150]], {});
    assert.equal(draft.count, 2, "160 mm: two 20 mm knife pleats");
    const spec = pleatSpec(draft);
    const before = a.nodes();
    a.commit(a.pleatOps("p2", { spec }), "add pleats");
    const p = node(a, "p2");
    assert.equal(p.pleats.length, 1);
    const g0 = p.pleats[0];
    assert.equal(g0.internal.length, 4, "two knife pleats, two folds each");
    for (const i of g0.internal) { assert.equal(p.internal[i].kind, "fold"); assert.equal(p.internal[i].prefold, true); }
    assert.deepEqual(new Set(g0.internal.map((i) => p.internal[i].angle)), new Set([0, 360]), "valleys and mountains");
    assert.equal(g0.tacks.length, 2, "a top tack a pleat");
    for (const t of g0.tacks) assert.equal(node(a, t).kind, "garment.tack");
    assert.deepEqual(node(a, "garment").tacks, ["t1", ...g0.tacks]);
    assert.deepEqual({ ...g0.spec }, spec, "the spec stored as given");
    // the document evaluates back to the group, its tacks mapped
    const rows = a.pleatRows(a.g);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].internal, g0.internal);
    assert.equal(rows[0].tacks.length, 2);
    assert.equal(a.f("garment_fold_prefold")(a.g, a.patternIndex("p2"), g0.internal[0]), true, "prefold read back");
    assert.equal(garmentChange(before, a.nodes()).kind, "stale", "pleats: rebuilt");
    // selectable as a group, and its numbers edited: remove + add, one batch
    assert.equal(groupOfLine(p, g0.internal[2]), 0);
    const req = s2Request({ kind: "internal", id: "p2", index: g0.internal[1] }, a.nodes(), "pleat_count", 3);
    assert.equal(req.kind, "pleat"); assert.equal(req.action, "edit"); assert.equal(req.spec.count, 3);
    const head = a.head();
    a.commit(a.pleatOps("p2", { spec: req.spec, remove: req.group }), "edit pleats");
    const q = node(a, "p2");
    assert.equal(q.pleats.length, 1);
    assert.equal(q.pleats[0].internal.length, 6, "three pleats");
    assert.equal(q.internal.length, 6, "the old folds gone");
    assert.equal(node(a, "garment").tacks.length, 4, "the old tacks gone, three new");
    for (const t of g0.tacks) assert.ok(!node(a, t) || q.pleats[0].tacks.includes(t), "an old tack is gone or the new group's");
    a.undo();
    assert.equal(a.head(), head, "the edit was one undo step");
    assert.equal(node(a, "p2").pleats[0].internal.length, 4);
    a.redo();
    // Delete: the group, its folds and its tacks
    a.commit(a.pleatOps("p2", { remove: 0 }), "remove pleats");
    const r = node(a, "p2");
    assert.equal(r.pleats, undefined, "no pleats param left");
    assert.equal((r.internal ?? []).length, 0);
    assert.deepEqual(node(a, "garment").tacks, ["t1"]);
    assert.equal(a.nodes().filter((n) => n.kind === "garment.tack").length, 1);
}

// ---- two pieces' groups: the kernel's group ids map to each piece's own list ----
{
    const a = fixture();
    a.commit(a.pleatOps("p2", { spec: pleatSpec(pleatDraft([[320, 300], [320, 0]], [[320, 150], [400, 150]], { count: 1, top_tack: false })) }), "p2 pleats");
    a.commit(a.pleatOps("p2", { spec: pleatSpec(pleatDraft([[420, 300], [420, 0]], [[420, 150], [480, 150]], { count: 1, top_tack: false })) }), "p2 pleats 2");
    a.commit(a.pleatOps("p1", { spec: pleatSpec(pleatDraft([[150, 0], [150, 40]], [[150, 20], [190, 20]], { count: 1, depth: 5, top_tack: false })) }), "p1 pleats");
    assert.equal(node(a, "p2").pleats.length, 2);
    assert.equal(node(a, "p1").pleats.length, 1);
    const second = node(a, "p2").pleats[1];
    a.commit(a.pleatOps("p2", { remove: 0 }), "remove the first");
    const left = node(a, "p2").pleats;
    assert.equal(left.length, 1);
    assert.deepEqual(left[0].spec, second.spec, "the second group stays");
    assert.equal(node(a, "p1").pleats.length, 1, "the other piece's group untouched");
    // the preview: shown, then taken back; the commit is what Enter makes
    a.pleatPreview("p2", pleatSpec(pleatDraft([[330, 300], [330, 0]], [[330, 150], [400, 150]], { count: 1, top_tack: false })));
    assert.equal(node(a, "p2").pleats.length, 2, "previewed");
    a.pleatPreview("p2", pleatSpec(pleatDraft([[330, 300], [330, 0]], [[330, 150], [410, 150]], { count: 1, top_tack: false })));
    assert.equal(node(a, "p2").pleats.length, 2, "a second frame replaces the first");
    a.endPreview(false);
    assert.equal(node(a, "p2").pleats.length, 1, "dropped");
    // a pleat crossing a fold line is refused, naming the fault
    assert.throws(() => a.pleatOps("p1", { spec: pleatSpec(pleatDraft([[20, 0], [20, 300]], [[20, 150], [100, 150]], {})) }), /FoldsCross/);
}

// ---- Rotate preview: a frame from the committed piece each time; a miss shows nothing ----
{
    const a = fixture();
    const o0 = JSON.stringify(node(a, "p1_outline").path);
    a.rotatePreview("p1", 0, [50, 0], 2);
    const o1 = JSON.stringify(node(a, "p1_outline").path);
    assert.notEqual(o1, o0, "previewed");
    a.rotatePreview("p1", 0, [60, 0], 2);
    assert.notEqual(JSON.stringify(node(a, "p1_outline").path), o1, "the next frame from the committed piece");
    assert.throws(() => a.rotatePreview("p1", 0, [60, 60], 2), /outline/);
    assert.equal(JSON.stringify(node(a, "p1_outline").path), o0, "a miss: the piece as committed");
    a.endPreview(false);
    assert.equal(JSON.stringify(node(a, "p1_outline").path), o0);
}
console.log("darts-pleats-kernel: ok");
