// The simulation's 2D tools (simtools.js) through tools.js's makeTool: Fold line and Tack, the
// Edit tool selecting an internal line or a tack, a tack's 2D items and the 2D hit of one.
import assert from "node:assert/strict";
import { makeTool, SNAPPING } from "../tools.js";
import { tackSpecs, pieceOf } from "../simtools.js";
import { hitOf } from "../view2d.js";
import * as m from "../model.js";

const base = m.newDocumentOps({ slug: "x", label: "X", params: Object.fromEntries(m.FABRIC_FIELDS.map((n) => [n, 1])) }).map((o) => o.node);
let nodes = m.withAdded(base, m.addPattern(base, { label: "Front", path: m.rectPath(0, 0, 100, 100), fabric: "f_x" }).ops);
nodes = m.withAdded(nodes, m.addPattern(nodes, { label: "Back", path: m.rectPath(200, 0, 100, 100), fabric: "f_x" }).ops);
const ctx = (extra = {}) => ({ nodes, drawings: new Map(), selection: null, fabric: "f_x", request: async () => { throw new Error("no kernel"); }, ...extra });
const on = (id) => ({ kind: "pattern", id });
const click = (t, p, h = null, mods = {}) => { t.down(p, h, mods); return t.up(p, h, mods); };

assert.ok(SNAPPING.has("fold") && SNAPPING.has("tack"), "both place points: snapping on");

// Fold line: points on a piece, Enter ends it; a fold internal line on the first click's piece,
// selected for its angle
{
    const t = makeTool("fold", ctx());
    click(t, [10, 50], on("p1"));
    assert.deepEqual(t.lastPoint(), [10, 50]);
    assert.deepEqual(t.move([50, 50]).overlay.lines[0], [[10, 50], [50, 50]]);
    click(t, [90, 50], on("p1"));
    const r = t.key("Enter");
    assert.equal(r.done, true);
    assert.deepEqual(r.ops, [{ op: "set", id: "p1", fields: { internal: [{ kind: "fold", path: { start: [10, 50], segments: [{ type: "line", to: [90, 50] }] } }] } }]);
    assert.deepEqual(r.select, { kind: "internal", id: "p1", index: 0 });
}
// ... on the selected piece when the first click is off every piece; a double click ends it;
// an existing line stays first
{
    const withLine = m.withAdded(nodes, m.addInternal(nodes, "p2", { start: [210, 10], segments: [{ type: "line", to: [290, 10] }] }));
    const t = makeTool("fold", ctx({ nodes: withLine, selection: on("p2") }));
    click(t, [210, 50]);
    click(t, [290, 60]);
    const r = click(t, [290, 60], null, { detail: 2, dblclick: true });     // a double click's second release
    assert.deepEqual(r.ops[0].fields.internal.map((l) => l.kind), ["line", "fold"]);
    assert.deepEqual(r.select, { kind: "internal", id: "p2", index: 1 });
}
// ... nothing on no piece; Escape drops the points
{
    const t = makeTool("fold", ctx());
    click(t, [500, 500]); click(t, [600, 500]);
    const r = t.key("Enter");
    assert.equal(r.ops, undefined);
    assert.match(r.status, /on a piece/);
    const t2 = makeTool("fold", ctx());
    click(t2, [10, 10], on("p1"));
    assert.equal(t2.key("Escape").done, true);
    assert.equal(t2.lastPoint(), null);
}

// Tack: a point on a piece, then one on another; the tool stays on for the next
{
    const t = makeTool("tack", ctx());
    assert.match(t.down([500, 500], null).status, /on a piece/);
    assert.match(t.down([5, 5], { kind: "tack", id: "t9" }).status, /that is a tack/);
    const first = t.down([10, 20], on("p1"));
    assert.deepEqual(first.overlay.points, [[10, 20]]);
    assert.equal(first.error, false);
    assert.deepEqual(t.lastPoint(), [10, 20]);
    assert.deepEqual(t.move([100, 20]).overlay.lines, [[[10, 20], [100, 20]]]);
    // an edge hit (a seamed one too) is on its piece
    const r = t.down([200, 50], { kind: "edge", id: "p2", s: 350, side: 3, seam: "s1" });
    assert.deepEqual(r.ops, [
        { op: "add", node: { id: "t1", kind: "garment.tack", a: "p1", b: "p2", a_at: [10, 20], b_at: [200, 50] } },
        { op: "set", id: "garment", fields: { tacks: ["t1"] } },
    ]);
    assert.deepEqual(r.select, { kind: "tack", id: "t1" });
    assert.equal(r.done, undefined, "still on");
    assert.equal(t.lastPoint(), null);
    // the same piece twice is a tack too, not the same point
    t.down([10, 10], on("p1"));
    assert.match(t.down([10, 10], on("p1")).status, /is the first/);
    const same = t.down([90, 90], { kind: "internal", id: "p1", index: 0 });
    assert.deepEqual([same.ops[0].node.a, same.ops[0].node.b], ["p1", "p1"]);
    assert.equal(t.key("Escape").done, true);
}
assert.deepEqual(["pattern", "edge", "internal", "point", "handle", "hole", "tack", "seam"].map((kind) => pieceOf({ kind, id: "p1" })),
    ["p1", "p1", "p1", "p1", "p1", null, null, null]);

// Edit: a click on an internal line of the piece being edited, or on a tack, selects it; a click on
// another piece's internal line selects that piece; a double click on the line inserts a point
{
    const t = makeTool("edit", ctx({ selection: on("p1") }));
    const line = { kind: "internal", id: "p1", index: 2 };
    assert.deepEqual(t.down([10, 50], line, {}), {});
    assert.deepEqual(t.up([10, 50], line, {}).select, line);
    const t2 = makeTool("edit", ctx({ selection: line }));
    assert.deepEqual(t2.down([10, 50], line, {}), {}, "the line's piece stays the one being edited");
    assert.equal(t2.up([10, 50], line, { dblclick: true }).point.op, "insert");
    assert.deepEqual(t.down([10, 50], { kind: "internal", id: "p2", index: 0 }, {}).select, { kind: "pattern", id: "p2" });
    assert.deepEqual(t.down([10, 50], { kind: "tack", id: "t3" }, {}).select, { kind: "tack", id: "t3" });
}

// a tack's 2D items: a dashed line and the two ends, above every piece; picked as the tack;
// accented when selected
{
    const tacked = [...nodes, { id: "t1", kind: "garment.tack", a: "p1", b: "p2", a_at: [10, 20], b_at: [200, 50] }];
    const drawings = [{ id: "p1", layer: 0 }, { id: "p2", layer: 0 }];
    const specs = tackSpecs({ nodes: tacked, drawings });
    assert.deepEqual(specs.map((s) => [s.key, s.show]), [["tack/t1/line", "lines"], ["tack/t1/ends", "points"]]);
    const z = specs[0].data[2];
    assert.deepEqual(specs[1].data, [10, 20, z, 200, 50, z]);
    assert.ok(z > 10 + 4 * 1 + 2, "above the second piece's seams");
    assert.deepEqual(specs[0].what, { kind: "tack", id: "t1" });
    assert.notEqual(specs[0].colour, tackSpecs({ nodes: tacked, drawings, selection: { kind: "tack", id: "t1" } })[0].colour);
    assert.deepEqual(hitOf(specs[1].what, { point: [10, 20, z], node: 0 }, new Map()), { kind: "tack", id: "t1" });
    assert.deepEqual(tackSpecs({ nodes, drawings }), []);
}
console.log("simtools: ok");
