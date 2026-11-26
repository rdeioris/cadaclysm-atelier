// Grading (A3) in the page, without the DOM: the grade table's rows and the panel's actions
// (props.js), the Edit tool's early refusal of a handle in a graded size (tools.js), and Show
// sizes' outlines in the 2D scene (scene2d.js), against the real kernel where the actions land.
import assert from "node:assert/strict";
import { loadKernel } from "./package.mjs";
import { Atelier } from "../kernel.js";
import * as m from "../model.js";
import * as G from "../grading.js";
import { gradeRows, gradeRuleAction, gradeCopyAction, gradeDistributeAction, gradeProportionalAction, sizeTable } from "../props.js";
import { baseOnlyText } from "../tools.js";
import { specs2d, sizeColour, ACCENT } from "../scene2d.js";

const k = await loadKernel();
const params = Object.fromEntries(m.FABRIC_FIELDS.map((n) => [n, 1]));
const a = new Atelier(k);
a.reset(m.newDocumentOps({ slug: "x", label: "X", params }));
a.apply(m.addPattern(a.nodes(), { label: "A", path: m.rectPath(0, 0, 100, 50), fabric: "f_x" }).ops, "a");
const grade = (action) => { const r = a.gradeOps(action); a.commit(r.ops, "grade", r.ids); };
const sizes = (action) => { const r = a.sizesOps(action); a.commit(r.ops, "sizes", r.ids); };

// no sizes: no table, the actions refused
assert.equal(sizeTable(a.nodes()), null);
assert.equal(gradeRows(a.nodes(), "p1", 0), null);
assert.throws(() => gradeRuleAction(a.nodes(), "p1", 1, "L", "1", "2"), /add sizes first/);
assert.equal(baseOnlyText(a.nodes()), null);

for (const name of ["M", "L", "XL"]) sizes({ op: "add", name });
sizes({ op: "add", name: "S", at: 0 });

// a typed row: the rule op, blank as 0; the base row and a bad number refused
const rule = gradeRuleAction(a.nodes(), "p1", 1, "L", "10", "");
assert.deepEqual(rule, { op: "rule", id: "p1", vertex: 1, size: "L", d: [10, 0] });
grade(rule);
assert.throws(() => gradeRuleAction(a.nodes(), "p1", 1, "M", "1", "0"), /base size's rule is 0, 0/);
assert.throws(() => gradeRuleAction(a.nodes(), "p1", 1, "L", "x", "0"), /two numbers/);
grade(gradeRuleAction(a.nodes(), "p1", 1, "XL", 20, 0));
assert.deepEqual(gradeRows(a.nodes(), "p1", 1), [
    { size: "S", base: false, current: false, d: [0, 0] },
    { size: "M", base: true, current: true, d: [0, 0] },
    { size: "L", base: false, current: false, d: [10, 0] },
    { size: "XL", base: false, current: false, d: [20, 0] },
]);

// Copy rule to…: point 2 (index 1)'s rules onto point 3; one point alone refused
assert.throws(() => gradeCopyAction("p1", 1, [1]), /select the points/);
grade(gradeCopyAction("p1", 1, [1, 2]));
assert.deepEqual(G.gradeOf(m.byId(a.nodes()).get("p1")).rules[2], { L: [10, 0], XL: [20, 0] });

// Distribute: the shorter way round (4 points: 0 and 2 are a tie, forward from 0); neighbours refused
assert.deepEqual(gradeDistributeAction("p1", [0, 2], 4), { op: "distribute", id: "p1", from: 0, to: 2 });
assert.deepEqual(gradeDistributeAction("p1", [1, 5], 6), { op: "distribute", id: "p1", from: 5, to: 1 }, "5 -> 0 -> 1: one point between");
assert.deepEqual(gradeDistributeAction("p1", [0, 1], 4), { op: "distribute", id: "p1", from: 1, to: 0 }, "0 and 1 are neighbours forward: the other way");
assert.deepEqual(gradeDistributeAction("p1", [0, 1], 3), { op: "distribute", id: "p1", from: 1, to: 0 });
assert.throws(() => gradeDistributeAction("p1", [0, 1], 2), /no points between/);
assert.throws(() => gradeDistributeAction("p1", [0], 4), /two points/);
grade(gradeDistributeAction("p1", [0, 2], 4));
{
    const r = G.gradeOf(m.byId(a.nodes()).get("p1")).rules[1];     // point 2 two thirds of the way (100 of 150 mm) from 1 to 3
    assert.ok(Math.abs(r.L[0] - 20 / 3) < 1e-6 && Math.abs(r.XL[0] - 40 / 3) < 1e-6 && r.L[1] === 0, JSON.stringify(r));
}

// Proportional…: +20 mm wide, +10 high a size step
const prop = gradeProportionalAction(["p1"], "20", 10);
assert.deepEqual(prop, { op: "proportional", ids: ["p1"], dw: 20, dh: 10 });
assert.throws(() => gradeProportionalAction([], 1, 1), /select a piece/);
assert.throws(() => gradeProportionalAction(["p1"], "a", 1), /width and a height/);
grade(prop);
assert.deepEqual(G.gradeOf(m.byId(a.nodes()).get("p1")).rules[2], { S: [-10, -5], L: [10, 5], XL: [20, 10] });

// the Edit tool refuses a handle in L at once; in M it does not
a.switchSize("L");
assert.equal(baseOnlyText(a.nodes()), "edit the shape in the base size (M)");
a.switchSize("M");
assert.equal(baseOnlyText(a.nodes()), null);

// Show sizes: every size but the current one, in the accent's ramp; the current is the outline
{
    const nest = a.sizeNest(["p1"]);
    assert.deepEqual(nest.map((g) => g.size), ["S", "L", "XL"]);
    const d = a.drawings();
    const specs = specs2d({ drawings: d, nodes: a.nodes(), selection: { kind: "pattern", id: "p1" }, nest });
    const items = specs.filter((s) => s.key.startsWith("p1/size/"));
    assert.deepEqual(items.map((s) => s.key), ["p1/size/S", "p1/size/L", "p1/size/XL"]);
    assert.deepEqual(items.map((s) => s.colour), [sizeColour(0, 4), sizeColour(2, 4), sizeColour(3, 4)]);
    assert.equal(sizeColour(3, 4), ACCENT);
    assert.deepEqual(items[0].what, { kind: "sizes", id: "p1", size: "S" });
    // XL's outline is the switch's: two steps, 140 x 70 about the same centre
    const xs = items[2].data.filter((_, i) => i % 4 === 0), ys = items[2].data.filter((_, i) => i % 4 === 1);
    assert.deepEqual([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)].map((v) => Math.round(v * 1e6) / 1e6), [-20, 120, -10, 60]);
    assert.deepEqual(a.sizeNest([]), []);
}
a.free();
console.log("grading-panel: ok");
