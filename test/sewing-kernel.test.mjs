// The wrap convention against the real kernel, and the tools' ranges end to end.
import assert from "node:assert/strict";
import { loadKernel } from "./package.mjs";
import { Atelier } from "../kernel.js";
import * as m from "../model.js";
import { makeTool } from "../tools.js";
import { reanchor } from "../sewing.js";
const k = await loadKernel();
const params = Object.fromEntries(m.FABRIC_FIELDS.map((n) => [n, 1]));
const a = new Atelier(k);
a.apply(m.newDocumentOps({ slug: "x", label: "X", params }), "new");
a.apply(m.addPattern(a.nodes(), { label: "F", path: m.rectPath(0, 0, 100, 50), fabric: "f_x" }).ops, "p");
a.apply(m.addPattern(a.nodes(), { label: "B", path: m.rectPath(200, 0, 100, 50), fabric: "f_x" }).ops, "p");
const pts = (from, to) => {
    a.apply(m.addSeam(a.nodes(), { a: "p1", b: "p2", a_from: from, a_to: to, b_from: 0, b_to: 40 }).ops, "s");
    const p = a.seams().at(-1).points_a;
    a.undo();
    return p.length / 2;
};
// from > to is the short wrapped range (280 -> corner (0,0) -> 20); from < to the same pair the long way
assert.equal(pts(280, 20), 3);
assert.equal(pts(20, 280), 5);

const ctx = () => ({ nodes: a.nodes(), drawings: new Map(a.drawings().map((d) => [d.id, d])) });
const hit = (id, s) => ({ kind: "edge", id, s, side: a.drawing(id).sides.findIndex((v, i) => s >= v && s < a.drawing(id).sides[i + 1]) });
// free sewing across the outline's start: clicks at 280 then 20 sew the short wrapped range
{
    const t = makeTool("free", ctx());
    t.down([0, 0], hit("p1", 280), {}); t.down([0, 0], hit("p1", 20), {});
    t.down([0, 0], hit("p2", 10), {});
    const r = t.down([0, 0], hit("p2", 50), {});
    const s = r.ops.find((o) => o.op === "add").node;
    assert.deepEqual([s.a_from, s.a_to, s.b_from, s.b_to], [280, 20, 10, 50]);
    assert.equal(s.reversed, false);
    a.apply(r.ops, "sew");
    assert.equal(a.seams().at(-1).points_a.length / 2, 3);
    // the anchor follows the sides when p1 grows: side 3 from t 0.2, side 0 to t 0.2
    const grown = new Map(ctx().drawings); grown.set("p1", { sides: [0, 120, 170, 290, 340] });
    const re = reanchor(a.nodes(), grown, "p1");
    const f = re.ops.find((o) => o.id === s.id).fields;
    assert.ok(Math.abs(f.a_to - 24) < 1e-6);
    assert.ok(f.a_from > f.a_to, "still wrapped");
    // a side that no longer exists removes the seam and names it
    const small = new Map(ctx().drawings); small.set("p1", { sides: [0, 100, 150] });
    const gone = reanchor(a.nodes(), small, "p1");
    assert.deepEqual(gone.removed, [s.id]);
    assert.ok(gone.ops.some((o) => o.op === "remove" && o.id === s.id));
    a.apply(gone.ops, "gone");
    assert.equal(a.seams().length, 0);
}
console.log("sewing-kernel: ok");
