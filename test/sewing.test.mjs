import assert from "node:assert/strict";
import { makeSewingTool, reanchor, seamColour } from "../sewing.js";
import * as m from "../model.js";

const sides = [0, 100, 150, 250, 300];
const drawings = new Map([["p1", { sides }], ["p2", { sides }]]);
const nodes = [{ id: "garment", kind: "garment.garment", patterns: ["p1", "p2"], seams: [] }];
const edge = (id, s) => ({ kind: "edge", id, s, side: sides.findIndex((v, i) => s >= v && s < sides[i + 1]) });

// segment sewing: p1's right side (near its end) to p2's left side (near its start)
{
    const t = makeSewingTool("segment", { nodes, drawings });
    t.down([0, 0], edge("p1", 140), {});
    const r = t.down([0, 0], edge("p2", 260), {});
    const seam = r.ops.find((o) => o.op === "add").node;
    assert.deepEqual([seam.a, seam.a_from, seam.a_to, seam.b, seam.b_from, seam.b_to], ["p1", 100, 150, "p2", 250, 300]);
    assert.equal(typeof seam.reversed, "boolean");
    assert.deepEqual(seam.meta.atelier, { a: [1, 0, 1], b: [3, 0, 1] });
    assert.equal(r.done, true);
}
// free sewing: two ranges
{
    const t = makeSewingTool("free", { nodes, drawings });
    t.down([0, 0], edge("p1", 10), {}); t.down([0, 0], edge("p1", 60), {});
    t.down([0, 0], edge("p2", 20), {});
    const r = t.down([0, 0], edge("p2", 70), {});
    const seam = r.ops.find((o) => o.op === "add").node;
    assert.deepEqual([seam.a_from, seam.a_to, seam.b_from, seam.b_to], [10, 60, 20, 70]);
    assert.deepEqual(seam.meta.atelier.a, [0, 0.1, 0.6]);
}
// reanchor after p1 grew 20 mm on its bottom side
{
    const n2 = [...nodes, { id: "s1", kind: "garment.seam", a: "p1", b: "p2", a_from: 100, a_to: 150, b_from: 250, b_to: 300, reversed: true, meta: { atelier: { a: [1, 0, 1], b: [3, 0, 1] } } }];
    const d2 = new Map([["p1", { sides: [0, 120, 170, 290, 340] }], ["p2", { sides }]]);
    const r = reanchor(n2, d2, "p1");
    assert.deepEqual(r.ops, [{ op: "set", id: "s1", fields: { a_from: 120, a_to: 170 } }]);
    assert.deepEqual(r.removed, []);
}
assert.notEqual(seamColour(0), seamColour(1));
assert.equal(seamColour(0), seamColour(12));
console.log("sewing: ok");
