// Grading arithmetic (A3 spec §1-§4, grading.js): the size table, a graded path, the affine fit,
// Distribute, Proportional and the rule index shift. Pure: no kernel.
import assert from "node:assert/strict";
import * as G from "../grading.js";
import { rectPath } from "../model.js";

const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) <= e, `${a} vs ${b}`);
const nearPt = (p, q, e = 1e-9) => { near(p[0], q[0], e); near(p[1], q[1], e); };

// ---- the size table ----
{
    let t = G.addSize(null, "M");
    assert.deepEqual(t, { sizes: ["M"], base: "M", current: "M" });
    t = G.addSize(t, "L");
    t = G.addSize(t, "S", 0);
    assert.deepEqual(t.sizes, ["S", "M", "L"]);
    assert.throws(() => G.addSize(t, "L"), /exists/);
    assert.throws(() => G.addSize(t, "  "), /name/);
    const grades = { p1: { base: rectPath(0, 0, 100, 50), rules: { 1: { L: [10, 0], S: [-10, 0] } } } };
    const r = G.renameSize({ ...t, current: "L" }, grades, "L", "Large");
    assert.deepEqual(r.table, { sizes: ["S", "M", "Large"], base: "M", current: "Large" });
    assert.deepEqual(r.grades.p1.rules, { 1: { Large: [10, 0], S: [-10, 0] } });
    assert.throws(() => G.renameSize(t, grades, "L", "S"), /exists/);
    const d = G.removeSize({ ...t, current: "L" }, grades, "L");
    assert.deepEqual(d.table, { sizes: ["S", "M"], base: "M", current: "M" }, "the current size removed: the base is current");
    assert.deepEqual(d.grades.p1.rules, { 1: { S: [-10, 0] } });
    assert.throws(() => G.removeSize(t, grades, "M"), /base/);
    assert.deepEqual(G.reorderSizes(t, ["L", "M", "S"]).sizes, ["L", "M", "S"]);
    assert.throws(() => G.reorderSizes(t, ["L", "M"]), /same sizes/);
    // base change: rule' = rule - rule(newBase); the base path is L's outline
    const b = G.changeBase(t, grades, "L");
    assert.equal(b.table.base, "L");
    assert.deepEqual(b.grades.p1.rules, { 1: { S: [-20, 0], M: [-10, 0] } });
    assert.deepEqual(G.vertices(b.grades.p1.base), [[0, 0], [110, 0], [100, 50], [0, 50]]);
    // and back: the same rules and base
    const back = G.changeBase(b.table, b.grades, "M");
    assert.deepEqual(back.grades.p1.rules, grades.p1.rules);
    assert.deepEqual(G.vertices(back.grades.p1.base), G.vertices(grades.p1.base));
}

// ---- gradedPath: vertices by their rule, a Bézier's handles with their own vertex ----
{
    const base = { start: [0, 0], segments: [
        { type: "bezier", c1: [30, -10], c2: [70, -10], to: [100, 0] },
        { type: "line", to: [100, 50] },
        { type: "conic", control: [50, 80], to: [0, 50], weight: 0.7 },
        { type: "line", to: [0, 0] }] };
    const rules = { 0: { L: [-5, 0] }, 1: { L: [10, 0] }, 2: { L: [10, 4] }, 3: { L: [0, 4] } };
    const p = G.gradedPath(base, rules, "L");
    nearPt(p.start, [-5, 0]);
    nearPt(p.segments[0].c1, [25, -10]); nearPt(p.segments[0].c2, [80, -10]); nearPt(p.segments[0].to, [110, 0]);
    nearPt(p.segments[1].to, [110, 54]);
    nearPt(p.segments[2].control, [55, 84]); nearPt(p.segments[2].to, [0, 54]);
    nearPt(p.segments[3].to, [-5, 0], 1e-12);
    assert.deepEqual(G.gradedPath(base, rules, "M"), base, "no rule: the base");
    // the moves read back
    assert.deepEqual(G.vertexMoves(base, p).map((d) => d.map((v) => Math.round(v * 1e9) / 1e9)), [[-5, 0], [10, 0], [10, 4], [0, 4]]);
    const handle = JSON.parse(JSON.stringify(p)); handle.segments[0].c1[1] += 3;
    assert.equal(G.vertexMoves(base, handle), null, "a handle moved on its own is not a vertex move");
    assert.deepEqual(G.withSize(rules, "XL", [[1, 0], [0, 0], [0, 0], [0, 0]])[0], { L: [-5, 0], XL: [1, 0] });
    // an arc's centre and a NURBS span's inner points follow their ends
    const arc = { start: [0, 0], segments: [{ type: "line", to: [10, 0] }, { type: "arc", to: [0, 10], centre: [0, 0], ccw: true }, { type: "line", to: [0, 0] }] };
    const q = G.movedPath(arc, [[2, 0], [2, 0], [2, 0]]);
    nearPt(q.segments[1].centre, [2, 0]);
    const nurbs = { start: [0, 0], segments: [{ type: "line", to: [100, 0] }, { type: "nurbs", degree: 2, points: [[120, 25], [100, 50]], weights: [1, 1, 1], knots: [0, 0, 0, 1, 1, 1] }, { type: "line", to: [0, 0] }] };
    const r = G.movedPath(nurbs, [[0, 0], [10, 0], [10, 10]]);
    nearPt(r.segments[1].points[0], [130, 30]); nearPt(r.segments[1].points[1], [110, 60]);
}

// ---- affineFit: exact for an affine map, least squares otherwise ----
{
    const from = [[0, 0], [100, 0], [100, 50], [0, 50]];
    const m = [1.1, 0.2, 5, -0.1, 0.9, -3];
    const fit = G.affineFit(from, from.map((p) => G.applyAffine(m, p)));
    fit.forEach((v, i) => near(v, m[i], 1e-9));
    // one corner moved: the fit splits it
    const to = from.map((p, i) => (i === 2 ? [p[0] + 8, p[1]] : p));
    const f2 = G.affineFit(from, to);
    near(f2[0], 1.04, 1e-9); near(f2[1], 0.08, 1e-9); near(f2[2], -2, 1e-9);           // least squares: dx = 2 + 0.04 (x - 50) + 0.08 (y - 25)
    // too few points, or collinear: the mean move
    assert.deepEqual(G.affineFit([[0, 0], [1, 1]], [[1, 0], [3, 1]]), [1, 0, 1.5, 0, 1, 0]);
    const inv = G.invertAffine(m), id = G.composeAffine(m, inv);
    assert.ok(G.isIdentity(id, 1e-12));
    // a rigid motion of a path is found, a reshape is not
    const rect = rectPath(0, 0, 100, 50), c = Math.cos(0.3), s = Math.sin(0.3), turn = [c, -s, 20, s, c, 5];
    const moved = { start: G.applyAffine(turn, rect.start), segments: rect.segments.map((g) => ({ ...g, to: G.applyAffine(turn, g.to) })) };
    G.rigidMotion(rect, moved).forEach((v, i) => near(v, turn[i], 1e-9));
    assert.equal(G.rigidMotion(rect, G.movedPath(rect, [[0, 0], [5, 0], [5, 0], [0, 0]])), null);
}

// ---- distribute: the points between two by arc length, every size ----
{
    // a 100 x 50 rectangle with points at 25, 50, 75 on its bottom side: vertices 0..3 there
    const arcs = [0, 25, 50, 75, 100, 150, 250, 300];
    const rules = { 0: { L: [0, 0], S: [0, 0] }, 4: { L: [8, 0], S: [-8, 0] } };
    const r = G.distribute(rules, 0, 4, arcs, ["S", "M", "L"]);
    assert.deepEqual(r[1], { S: [-2, 0], L: [2, 0] });
    assert.deepEqual(r[2], { S: [-4, 0], L: [4, 0] });
    assert.deepEqual(r[3], { S: [-6, 0], L: [6, 0] });
    assert.equal(r[5], undefined, "vertices outside the span keep theirs");
    // the other way round the outline (4 -> 0 runs over 5, 6, 7)
    const w = G.distribute(rules, 4, 0, arcs, ["S", "M", "L"]);
    assert.deepEqual(w[5].L, [8 * (1 - 50 / 200), 0]);
    assert.equal(w[1], undefined);
}

// ---- proportional: width and height per size step, by place about the bounds centre ----
{
    const r = G.proportional(rectPath(0, 0, 100, 50), ["S", "M", "L", "XL"], "M", 20, 10);
    assert.deepEqual(r[0], { S: [10, 5], L: [-10, -5], XL: [-20, -10] });
    assert.deepEqual(r[2], { S: [-10, -5], L: [10, 5], XL: [20, 10] });
    const L = G.gradedPath(rectPath(0, 0, 100, 50), r, "L");
    assert.deepEqual(G.vertices(L), [[-10, -5], [110, -5], [110, 55], [-10, 55]], "L is 20 wider and 10 taller");
}

// ---- shiftRules: insert and remove re-index ----
{
    const rules = { 0: { L: [1, 0] }, 1: { L: [3, 0] }, 2: { L: [5, 0] }, 3: { L: [7, 0] } };
    const ins = G.shiftRules(rules, 2, +1, { t: 0.25, n: 4 });
    assert.deepEqual(ins, { 0: { L: [1, 0] }, 1: { L: [3, 0] }, 2: { L: [3.5, 0] }, 3: { L: [5, 0] }, 4: { L: [7, 0] } });
    assert.deepEqual(G.shiftRules(rules, 4, +1, { t: 0.5, n: 4 })[4], { L: [4, 0] }, "after the last vertex: between it and vertex 0");
    assert.deepEqual(G.shiftRules(rules, 2, +1, { copy: 1 })[2], { L: [3, 0] });
    assert.deepEqual(G.shiftRules(rules, 2, +1)[2], undefined);
    assert.deepEqual(G.shiftRules(ins, 2, -1), rules, "removing it gives the rules back");
    assert.deepEqual(G.shiftRules(rules, 0, -1), { 0: { L: [3, 0] }, 1: { L: [5, 0] }, 2: { L: [7, 0] } });
    // carried by position: a point added on a side, a corner replaced by two
    const rect = rectPath(0, 0, 100, 50);
    const five = { start: [0, 0], segments: [{ type: "line", to: [25, 0] }, ...rect.segments] };
    assert.deepEqual(G.carryRules(rules, rect, five)[1], { L: [1.5, 0] });
    assert.deepEqual(G.carryRules(rules, rect, five)[2], { L: [3, 0] });
    const round = { start: [0, 0], segments: [{ type: "line", to: [90, 0] }, { type: "arc", to: [100, 10], centre: [90, 10], ccw: true }, { type: "line", to: [100, 50] }, { type: "line", to: [0, 50] }, { type: "line", to: [0, 0] }] };
    const c = G.carryRules(rules, rect, round);
    assert.deepEqual([c[1], c[2], c[3]], [{ L: [3, 0] }, { L: [3, 0] }, { L: [5, 0] }], "both arc ends take the corner's rule");
}

// ---- a cut's pieces: rules at their places (vertex, side fraction, affine fit inside) ----
{
    const rect = rectPath(0, 0, 100, 50), rules = { 1: { L: [10, 0] }, 2: { L: [10, 0] } };
    const r = G.rulesAtPlaces(rules, rect, [{ vertex: 0 }, { side: 0, t: 0.5 }, { point: [50, 25] }, { vertex: 2 }]);
    assert.deepEqual(r, { 1: { L: [5, 0] }, 2: { L: [5, 0] }, 3: { L: [10, 0] } });
}

// ---- notches at their side fraction ----
{
    const at = G.notchesByFraction([{ at: 25, kind: "slit" }, { at: 125, kind: "v" }], [0, 100, 150, 250, 300], [0, 120, 170, 290, 340]);
    assert.deepEqual(at.map((n) => n.at), [30, 145]);
}
console.log("grading ok");
