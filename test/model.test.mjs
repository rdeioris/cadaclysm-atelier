import assert from "node:assert/strict";
import * as m from "../model.js";

const fabric = { slug: "x", label: "X", params: Object.fromEntries(m.FABRIC_FIELDS.map((n) => [n, 1])) };
// apply ops to a plain node list the way the kernel does, enough for these tests
function apply(nodes, ops) {
    let out = nodes.map((n) => ({ ...n }));
    for (const o of ops) {
        if (o.op === "add") out.push(o.node);
        else if (o.op === "remove") out = out.filter((n) => n.id !== o.id);
        else if (o.op === "set") out = out.map((n) => (n.id === o.id ? { ...n, ...o.fields } : n));
        else throw new Error(o.op);
    }
    return out;
}

let nodes = apply([], m.newDocumentOps(fabric));
assert.ok(m.byId(nodes).get("garment"));
assert.equal(m.byId(nodes).get("f_x").kind, "garment.fabric");
assert.equal(m.FABRIC_FIELDS.length, 20);

const r1 = m.addPattern(nodes, { label: "Front", path: m.rectPath(0, 0, 100, 50), fabric: "f_x" });
assert.equal(r1.id, "p1");
nodes = apply(nodes, r1.ops);
const r2 = m.addPattern(nodes, { label: "Back", path: m.rectPath(200, 0, 100, 50), fabric: "f_x" });
assert.equal(r2.id, "p2");
nodes = apply(nodes, r2.ops);
assert.deepEqual(m.byId(nodes).get("garment").patterns, ["p1", "p2"]);
assert.equal(m.byId(nodes).get("p1").outline, "p1_outline");
assert.deepEqual(m.byId(nodes).get("p1").allowance, [10]);

// rectPath: counter-clockwise, closed back to start
const rp = m.rectPath(0, 0, 100, 50);
assert.deepEqual(rp.start, [0, 0]);
assert.deepEqual(rp.segments.map((s) => s.to), [[100, 0], [100, 50], [0, 50], [0, 0]]);
assert.deepEqual(m.pathPoints(rp), [[0, 0], [100, 0], [100, 50], [0, 50]]);

// polyPath with one curve
const pp = m.polyPath([[0, 0], [10, 0], [10, 10]], [undefined, { c1: [12, 3], c2: [12, 7] }]);
assert.equal(pp.segments[1].type, "bezier");
assert.deepEqual(pp.segments[1].c1, [12, 3]);
assert.deepEqual(pp.segments.at(-1).to, [0, 0]);

const s = m.addSeam(nodes, { a: "p1", b: "p2", a_from: 0, a_to: 100, b_from: 0, b_to: 100, reversed: true, anchor: { a: [0, 0, 1], b: [0, 0, 1] } });
assert.equal(s.id, "s1");
nodes = apply(nodes, s.ops);
assert.deepEqual(m.byId(nodes).get("garment").seams, ["s1"]);
assert.deepEqual(m.byId(nodes).get("s1").meta, { atelier: { a: [0, 0, 1], b: [0, 0, 1] } });

// removing several patterns is one batch: a seam between two of them is removed once
{
    const both = apply(nodes, m.removePatterns(nodes, ["p1", "p2"]));
    const ops = m.removePatterns(nodes, ["p1", "p2"]);
    assert.equal(ops.filter((o) => o.op === "remove" && o.id === "s1").length, 1);
    assert.deepEqual(["p1", "p2", "p1_outline", "p2_outline", "s1"].map((id) => m.byId(both).get(id)), [undefined, undefined, undefined, undefined, undefined]);
    assert.deepEqual(m.byId(both).get("garment").patterns, []);
    assert.deepEqual(m.byId(both).get("garment").seams, []);
    assert.deepEqual(m.removePatterns(nodes, ["p2"]), m.removePattern(nodes, "p2"));
}
// removing a pattern takes its seams and its outline along, and updates the garment
nodes = apply(nodes, m.removePattern(nodes, "p2"));
assert.equal(m.byId(nodes).get("s1"), undefined);
assert.equal(m.byId(nodes).get("p2_outline"), undefined);
assert.deepEqual(m.byId(nodes).get("garment").patterns, ["p1"]);
assert.deepEqual(m.byId(nodes).get("garment").seams, []);

// nextId is the max id IN USE plus one: a removed max can be reused, a removed lower id is not
assert.equal(m.nextId(nodes, "p"), "p2");
assert.equal(m.nextId([{ id: "p7" }, { id: "p3" }], "p"), "p8");

// removeSeam drops it from the garment's list and removes the node; setFabric keeps only known fields
const withSeam = apply(nodes, m.addSeam(nodes, { a: "p1", b: "p1", a_from: 0, a_to: 10, b_from: 20, b_to: 30 }).ops);
assert.deepEqual(m.byId(withSeam).get("garment").seams, ["s1"]);
const noSeam = apply(withSeam, m.removeSeam(withSeam, "s1"));
assert.deepEqual(m.byId(noSeam).get("garment").seams, []);
assert.equal(m.byId(noSeam).get("s1"), undefined);
assert.deepEqual(m.setFabric(nodes, "f_x", { density: 2, bogus: 9 })[0].fields, { density: 2 });

// a fabric added twice is one fabric
assert.deepEqual(m.addFabric(nodes, "x", "X", fabric.params).ops, []);
console.log("model: ok");
