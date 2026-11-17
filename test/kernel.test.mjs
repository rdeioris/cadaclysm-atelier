import assert from "node:assert/strict";
import { loadKernel } from "./package.mjs";
import { Atelier } from "../kernel.js";
import * as m from "../model.js";
const k = await loadKernel();
const params = Object.fromEntries(m.FABRIC_FIELDS.map((n) => [n, 1]));
const a = new Atelier(k);
a.apply(m.newDocumentOps({ slug: "x", label: "X", params }), "new");
const r = m.addPattern(a.nodes(), { label: "Front", path: m.rectPath(0, 0, 100, 50), fabric: "f_x", allowance: 10 });
a.apply(r.ops, "rect");

// drawing data
const d = a.drawing("p1");
assert.equal(d.label, "Front");
assert.deepEqual(d.bounds.map(Math.round), [0, 0, 100, 50]);
assert.ok(d.sew.length >= 8);
const cutXs = d.cut.filter((_, i) => i % 2 === 0);
assert.ok(Math.min(...cutXs) < -9 && Math.max(...cutXs) > 109, "the cut line stands 10 mm off");
assert.deepEqual(d.sides.map(Math.round), [0, 100, 150, 250, 300]);
assert.ok(d.samples.length / 3 >= 299);
assert.equal(d.grain.length, 4);

// pattern handles follow the garment node's pattern order (checked by name)
assert.equal(a.f("garment_pattern_name")(a.g, a.f("garment_patterns")(a.g)[0]), "Front");

// a seam, its draw data and meta round trip
const r2 = m.addPattern(a.nodes(), { label: "Back", path: m.rectPath(200, 0, 100, 50), fabric: "f_x" });
a.apply(r2.ops, "rect");
assert.equal(a.f("garment_pattern_name")(a.g, a.f("garment_patterns")(a.g)[1]), "Back");
const s = m.addSeam(a.nodes(), { a: "p1", b: "p2", a_from: 100, a_to: 150, b_from: 250, b_to: 300, reversed: true, anchor: { a: [1, 0, 1], b: [3, 0, 1] } });
a.apply(s.ops, "sew");
const sd = a.seams();
assert.equal(sd.length, 1);
assert.ok(sd[0].points_a.length >= 4 && sd[0].points_b.length >= 4);
assert.deepEqual(m.byId(a.nodes()).get("s1").meta, { atelier: { a: [1, 0, 1], b: [3, 0, 1] } });

// undo/redo, save/load
a.undo();
assert.equal(a.seams().length, 0);
a.redo();
assert.equal(a.seams().length, 1);
const text = a.save();
const b = new Atelier(k);
b.load(text);
assert.equal(b.drawings().length, 2);

// preview frames then commit: one undo step
a.preview(m.setOutline(a.nodes(), "p1", m.rectPath(0, 0, 120, 50)));
a.preview(m.setOutline(a.nodes(), "p1", m.rectPath(0, 0, 130, 50)));
assert.equal(Math.round(a.drawing("p1").bounds[2]), 130);
a.endPreview(true);
assert.equal(Math.round(a.drawing("p1").bounds[2]), 130);
a.undo();
assert.equal(Math.round(a.drawing("p1").bounds[2]), 100);

// kernel transforms
const moved = a.transformed("p1", [1, 0, 10, 0, 1, 20]);
assert.deepEqual(m.pathPoints(moved)[0].map(Math.round), [10, 20]);
const mir = a.mirrored("p1", [0, 0, 0, 1]);
assert.ok(m.pathPoints(mir).every(([x]) => x <= 1e-9));

// DXF out and back in: two more patterns
const dxf = a.toDxf();
assert.match(dxf, /AAMA|BLOCK/);
a.apply(a.fromDxf(dxf), "import");
assert.equal(a.drawings().length, 4);
assert.deepEqual(a.drawings().map((x) => x.label), ["Front", "Back", "Front 2", "Back 2"]);

// issues: a seam with mismatched lengths (50 mm against 100 mm) is flagged
const mm = m.addSeam(a.nodes(), { a: "p1", b: "p2", a_from: 100, a_to: 150, b_from: 150, b_to: 250 });
a.apply(mm.ops, "mismatch");
const iss = a.issues();
assert.ok(iss.length >= 1 && iss.every((i) => i.message.length > 0), "a length mismatch is reported");

// a side shorter than 1 mm still gets its own entry
const e = new Atelier(k);
e.apply(m.newDocumentOps({ slug: "x", label: "X", params }), "new");
e.apply(m.addPattern(e.nodes(), { label: "Nick", path: m.polyPath([[0, 0], [100, 0], [100, 0.3], [100, 50], [0, 50]]), fabric: "f_x" }).ops, "nick");
const ns = e.drawing("p1").sides;
assert.equal(ns.length, 6);
assert.ok(Math.abs(ns[2] - ns[1] - 0.3) < 1e-6, "the 0.3 mm side is present");
e.free();
a.free(); b.free();
console.log("kernel: ok");
