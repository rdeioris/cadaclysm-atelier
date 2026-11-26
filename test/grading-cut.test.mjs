// Grading (A3) and Cut: a graded piece cut in the base size gives two graded pieces. Each new
// vertex takes the rule at its place on the cut piece: on a vertex its rule, on a side the rules
// interpolated along it, inside (a cutter's bend) the piece's affine fit. Switching size then
// moves both halves alike, so their shared cut edge stays shared.
import assert from "node:assert/strict";
import { loadKernel } from "./package.mjs";
import { Atelier } from "../kernel.js";
import * as m from "../model.js";
import * as G from "../grading.js";

const k = await loadKernel();
const params = Object.fromEntries(m.FABRIC_FIELDS.map((n) => [n, 1]));
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} vs ${b}`);
const node = (a, id) => m.byId(a.nodes()).get(id);
const verts = (a, id) => G.vertices(node(a, `${id}_outline`).path);
const sorted = (ps) => ps.map((p) => p.map((v) => Math.round(v * 1e6) / 1e6 + 0)).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
const sameSet = (ps, qs) => assert.deepEqual(sorted(ps), sorted(qs));

// a 100 x 50 rectangle, its right side graded +10 mm in L (and -10 in S)
function setup() {
    const a = new Atelier(k);
    a.reset(m.newDocumentOps({ slug: "x", label: "X", params }));
    a.apply(m.addPattern(a.nodes(), { label: "A", path: m.rectPath(0, 0, 100, 50), fabric: "f_x" }).ops, "a");
    for (const name of ["M", "S", "L"]) { const r = a.sizesOps({ op: "add", name, ...(name === "S" ? { at: 0 } : {}) }); a.commit(r.ops, "sizes", r.ids); }
    for (const v of [1, 2]) for (const [s, dx] of [["S", -10], ["L", 10]]) { const r = a.gradeOps({ op: "rule", id: "p1", vertex: v, size: s, d: [dx, 0] }); a.commit(r.ops, "grade", r.ids); }
    return a;
}

for (const sew of [false, true]) {
    const a = setup();
    const r = a.cutOps("p1", m.openPath([[50, -10], [50, 60]]), { sew });
    a.apply(r.ops, sew ? "cut & sew" : "cut");
    const [left, right] = r.ids.map((id) => [id, verts(a, id)]).sort((p, q) => Math.min(...p[1].map((v) => v[0])) - Math.min(...q[1].map((v) => v[0]))).map(([id]) => id);
    for (const id of [left, right]) {
        const g = G.gradeOf(node(a, id));
        assert.ok(g, `${id} graded`);
        assert.ok(G.nearPath(g.base, node(a, `${id}_outline`).path), "its base is its outline");
    }
    a.switchSize("L");
    sameSet(verts(a, left), [[0, 0], [55, 0], [55, 50], [0, 50]]);
    sameSet(verts(a, right), [[55, 0], [110, 0], [110, 50], [55, 50]]);
    a.switchSize("S");
    sameSet(verts(a, left), [[0, 0], [45, 0], [45, 50], [0, 50]]);
    sameSet(verts(a, right), [[45, 0], [90, 0], [90, 50], [45, 50]]);
    assert.deepEqual(a.problems(), []);
    a.switchSize("M");
    sameSet(verts(a, left), [[0, 0], [50, 0], [50, 50], [0, 50]]);
    if (sew) {
        const s = a.nodes().find((n) => n.kind === "garment.seam");
        a.switchSize("L");
        const s2 = node(a, s.id);
        near(s2.a_to - s2.a_from, 50, 1e-3);     // the cut edge keeps its length (a vertical side)
    }
    a.free();
}

// a bent cutter: its bend inside the piece follows the affine fit (x' = 1.1 x in L)
{
    const a = setup();
    const r = a.cutOps("p1", m.openPath([[40, -10], [40, 25], [60, 25], [60, 60]]), { sew: false });
    a.apply(r.ops, "cut");
    a.switchSize("L");
    const all = r.ids.flatMap((id) => verts(a, id));
    for (const [x, y] of [[44, 25], [66, 25], [44, 0], [66, 50]]) assert.ok(all.some((p) => Math.hypot(p[0] - x, p[1] - y) < 1e-6), `a vertex at ${x}, ${y}: ${JSON.stringify(all)}`);
    assert.deepEqual(a.problems(), []);
    a.free();
}

// an ungraded piece cut in a graded garment: no grade on the halves
{
    const a = setup();
    a.apply(m.addPattern(a.nodes(), { label: "B", path: m.rectPath(300, 0, 100, 50), fabric: "f_x" }).ops, "b");
    const id = a.nodes().find((n) => n.kind === "garment.pattern" && n.label === "B").id;
    const r = a.cutOps(id, m.openPath([[350, -10], [350, 60]]), { sew: false });
    a.apply(r.ops, "cut");
    for (const pid of r.ids) assert.equal(G.gradeOf(node(a, pid)), null);
    a.free();
}
console.log("grading-cut: ok");
