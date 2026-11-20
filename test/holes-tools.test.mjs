// Hole tools against the kernel: a hole drawn on a piece is one undo step and is drawn with its
// cut line; a hole outside the piece is refused and changes nothing (spec §4).
import assert from "node:assert/strict";
import { loadKernel } from "./package.mjs";
import { Atelier } from "../kernel.js";
import * as m from "../model.js";
import { makeTool } from "../tools.js";

const k = await loadKernel();
const params = Object.fromEntries(m.FABRIC_FIELDS.map((n) => [n, 1]));
const a = new Atelier(k);
a.reset(m.newDocumentOps({ slug: "x", label: "X", params }));
a.apply(m.addPattern(a.nodes(), { label: "Front", path: m.rectPath(0, 0, 200, 100), fabric: "f_x", allowance: 10 }).ops, "rect");
const ctx = (extra = {}) => ({ nodes: a.nodes(), drawings: new Map(a.drawings().map((d) => [d.id, d])), selection: null, fabric: "f_x",
    request: async (kind, p) => a.ellipsePath(p.cx, p.cy, p.rx, p.ry), ...extra });

const t = makeTool("hole-rectangle", ctx());
t.down([20, 20], { kind: "pattern", id: "p1" }, {});
const r = t.up([60, 50], null, {});
a.apply(r.ops, "hole");
assert.equal(a.drawing("p1").holes.length, 1);
assert.equal(a.drawing("p1").holes[0].cut.length, 1);

const e = makeTool("hole-ellipse", ctx({ selection: { kind: "pattern", id: "p1" } }));
e.down([140, 50], null, {});
a.apply((await e.up([180, 70], null, {})).ops, "hole");
assert.equal(a.drawing("p1").holes.length, 2, "the selected piece takes it");

const before = JSON.stringify(a.nodes());
const out = makeTool("hole-rectangle", ctx({ selection: { kind: "pattern", id: "p1" } }));
out.down([300, 20], null, {});
assert.throws(() => a.apply(out.up([340, 50], null, {}).ops, "hole"));
assert.equal(JSON.stringify(a.nodes()), before, "a refused hole changes nothing");
// a hole inside another hole is not in the piece's material: refused too (the kernel's face
// refuses crossing holes; kernel.js refuses a nested one through profile_contains)
const inner = makeTool("hole-rectangle", ctx({ selection: { kind: "pattern", id: "p1" } }));
inner.down([155, 57], null, {});
assert.throws(() => a.apply(inner.up([165, 63], null, {}).ops, "hole"), /inside hole/);
assert.equal(JSON.stringify(a.nodes()), before, "a nested hole changes nothing");
const across = makeTool("hole-rectangle", ctx({ selection: { kind: "pattern", id: "p1" } }));
across.down([170, 55], null, {});
assert.throws(() => a.apply(across.up([190, 65], null, {}).ops, "hole"), /cross/);
assert.equal(JSON.stringify(a.nodes()), before, "a hole crossing another changes nothing");
// a hole touching the outline or another hole leaves no cloth between them: refused. A snap to
// the piece's corner lands within float32 of it (the View answers f32), which the face takes as
// inside: kernel.js measures the gap with profile_deviation.
for (const [what, path] of [
    ["the outline (a corner snap)", m.rectPath(180 - 2e-5, 80 - 2e-5, 20, 20)],
    ["the outline (an edge)", m.rectPath(100, 80, 20, 20)],
    ["another hole", m.rectPath(120, 55, 20 - 2e-5, 10)],
]) {
    assert.throws(() => a.apply(m.addHole(a.nodes(), "p1", path), "hole"), /touches|cross/, what);
    assert.equal(JSON.stringify(a.nodes()), before, `a hole touching ${what} changes nothing`);
}

const none = makeTool("hole-polygon", ctx());
none.down([300, 300], null, {}); none.up([300, 300], null, {});
none.down([320, 300], null, {}); none.up([320, 300], null, {});
none.down([320, 320], null, {}); none.up([320, 320], null, {});
none.down([300, 300], null, {});
assert.match(none.up([300, 300], null, {}).status, /piece/);
a.undo();
assert.equal(a.drawing("p1").holes.length, 1, "one undo takes one hole back");
// internal shapes on a piece, and Convert to Hole: one batch, one undo
const it = makeTool("internal-rectangle", ctx({ selection: { kind: "pattern", id: "p1" } }));
it.down([120, 20], null, {});
a.apply(it.up([160, 40], null, {}).ops, "internal");
assert.deepEqual(a.drawing("p1").internal.map((l) => l.closed), [true]);
const th = makeTool("to-hole", ctx());
const conv = th.down([120, 30], { kind: "internal", id: "p1", index: 0 }, {});
a.apply(conv.ops, "to hole");
assert.equal(a.drawing("p1").internal.length, 0);
assert.equal(a.drawing("p1").holes.length, 2, "the converted shape is the second hole");
a.undo();
assert.equal(a.drawing("p1").internal.length, 1, "one undo takes the conversion back");
assert.match(makeTool("to-hole", ctx()).down([0, 0], { kind: "pattern", id: "p1" }, {}).status, /click an internal/);
{   // the ellipse and polygon internal shapes; an open internal line is no hole; a shape off every piece is refused
    const ie = makeTool("internal-ellipse", ctx());
    ie.down([80, 60], { kind: "pattern", id: "p1" }, {});
    a.apply((await ie.up([100, 80], null, {})).ops, "internal");
    const ip = makeTool("internal-polygon", ctx());
    for (const p of [[20, 70], [40, 70], [30, 85]]) { ip.down(p, { kind: "pattern", id: "p1" }, {}); ip.up(p, null, {}); }
    ip.down([20, 70], null, {});
    a.apply(ip.up([20, 70], null, {}).ops, "internal");
    assert.deepEqual(a.drawing("p1").internal.map((l) => l.closed), [true, true, true]);
    a.apply(m.addInternal(a.nodes(), "p1", { start: [5, 5], segments: [{ type: "line", to: [15, 5] }] }), "line");
    assert.match(makeTool("to-hole", ctx()).down([10, 5], { kind: "internal", id: "p1", index: 3 }, {}).status, /closed/);
    const off = makeTool("internal-rectangle", ctx());
    off.down([300, 300], null, {});
    assert.match(off.up([320, 320], null, {}).status, /piece/);
    a.undo(); a.undo(); a.undo();
}
{   // a converted shape gets the hole checks: one crossing a hole is refused and changes nothing
    a.apply(m.addInternal(a.nodes(), "p1", m.rectPath(50, 40, 20, 20)), "internal");
    const before = JSON.stringify(a.nodes());
    const index = a.drawing("p1").internal.length - 1;
    assert.throws(() => a.apply(makeTool("to-hole", ctx()).down([50, 50], { kind: "internal", id: "p1", index }, {}).ops, "to hole"), /cross/);
    assert.equal(JSON.stringify(a.nodes()), before, "a refused conversion changes nothing");
    a.undo();
}
{   // a hole narrower than twice the allowance has no cut line: a warning names it (the hole is still added)
    let before = a.cutlessHoles();
    assert.equal(a.newCutlessHoles(before), null, "no new hole, no warning");
    const small = makeTool("hole-rectangle", ctx());
    small.down([170, 60], { kind: "pattern", id: "p1" }, {});
    a.apply(small.up([185, 75], null, {}).ops, "hole");
    assert.equal(a.drawing("p1").holes.length, 2, "the small hole is added");
    assert.equal(a.drawing("p1").holes[1].cut.length, 0, "with no cut line");
    assert.equal(a.newCutlessHoles(before), "Front: hole 2 is too small for a 10 mm allowance: it has no cut line");
    before = a.cutlessHoles();
    a.apply(m.addInternal(a.nodes(), "p1", m.rectPath(80, 60, 12, 12)), "internal");
    a.apply(makeTool("to-hole", ctx()).down([80, 65], { kind: "internal", id: "p1", index: 1 }, {}).ops, "to hole");
    assert.equal(a.newCutlessHoles(before), "Front: hole 3 is too small for a 10 mm allowance: it has no cut line", "a converted one too");
    before = a.cutlessHoles();
    a.apply(m.addHole(a.nodes(), "p1", m.rectPath(100, 60, 25, 25)), "hole");
    assert.equal(a.newCutlessHoles(before), null, "a hole wider than twice the allowance has its cut line");
    a.undo(); a.undo(); a.undo(); a.undo();
}
a.free();
console.log("holes-tools: ok");
