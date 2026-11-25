// Notches (A1 task A6, spec §5) against the kernel: every kind's mark drawn from
// garment_pattern_notch_lines, picked as that notch; Edit selects one; its panel sets kind,
// depth, at, or removes it; a kind or depth chosen there is the Notch tool's next.
import assert from "node:assert/strict";
import { loadKernel } from "./package.mjs";
import { Atelier, forPage } from "../kernel.js";
import * as m from "../model.js";
import { specs2d } from "../scene2d.js";
import { hitOf } from "../view2d.js";
import { makeTool, NOTCH_DEFAULT } from "../tools.js";
import { fieldsFor, opsFor, validate, nextNotch, NOTCH_KINDS } from "../props.js";

const k = await loadKernel();
const params = Object.fromEntries(m.FABRIC_FIELDS.map((n) => [n, 1]));
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} vs ${b}`);
const a = new Atelier(k);
a.reset(m.newDocumentOps({ slug: "x", label: "X", params }));
const add = m.addPattern(a.nodes(), { label: "A", path: m.rectPath(0, 0, 100, 50), fabric: "f_x" });
const kinds = NOTCH_KINDS.map(([kind]) => kind);
add.ops.find((o) => o.node?.kind === "garment.pattern").node.notches = kinds.map((kind, i) => ({ at: 10 + 20 * i, kind, depth: 6 }));
a.apply(add.ops, "a");
const piece = () => m.byId(a.nodes()).get("p1");
const drawn = () => a.drawing("p1");
const pairs = (pl) => { const o = []; for (let i = 0; i + 1 < pl.length; i += 2) o.push([pl[i], pl[i + 1]]); return o; };

// every kind draws, on the bottom side, cut inward (+y) to its depth, from the sew line
{
    const d = drawn();
    assert.equal(d.notchLines.length, 5);
    const counts = d.notchLines.map((pl) => pl.length / 2);
    assert.deepEqual(counts.slice(0, 4), [2, 3, 4, 4], "slit, V, T, castle");
    assert.ok(counts[4] >= 5, "the U is a half round");
    d.notchLines.forEach((pl, i) => {
        const pts = pairs(pl);
        near(Math.max(...pts.map((p) => p[1])), 6, kinds[i] === "u" ? 0.25 : 1e-9);      // the U's round flattened to 0.25 mm
        assert.ok(pts.every((p) => p[1] >= -1e-9 && Math.abs(p[0] - (10 + 20 * i)) <= 2 + 1e-9), `${kinds[i]} at its place`);
    });
    // the page's copy carries them, and the 2D window shows a lines item each, picked as that notch
    assert.deepEqual(forPage(d).notchLines, d.notchLines);
    const specs = specs2d({ drawings: [d], nodes: a.nodes() }).filter((s) => s.what?.kind === "notch");
    assert.deepEqual(specs.map((s) => s.what.index), [0, 1, 2, 3, 4]);
    assert.ok(specs.every((s) => s.show === "lines"));
    assert.deepEqual(hitOf(specs[1].what, { point: [30, 3, 0] }, new Map()), { kind: "notch", id: "p1", index: 1 });
}

// Edit: a click on the mark selects the notch; the Move tool reads it as its piece
{
    const ctx = { nodes: a.nodes(), drawings: new Map([["p1", drawn()]]), selection: null, request: async () => ({}) };
    assert.deepEqual(makeTool("edit", ctx).down([30, 3], { kind: "notch", id: "p1", index: 1 }, {}), { select: { kind: "notch", id: "p1", index: 1 } });
    assert.deepEqual(makeTool("transform", ctx).down([30, 3], { kind: "notch", id: "p1", index: 1 }, {}), { select: { kind: "pattern", id: "p1" } });
}

// the panel: kind, depth, at, remove
const sel = { kind: "notch", id: "p1", index: 0 };
{
    const fields = fieldsFor(sel, a.nodes(), new Map());
    assert.deepEqual(fields.map((f) => f.key), ["kind", "depth", "at", "remove"]);
    assert.deepEqual(fields[0].options.map((o) => o.value), kinds);
    assert.equal(fields[0].value, "slit"); assert.equal(fields[1].value, 6); assert.equal(fields[2].value, 10);
    assert.ok(validate(sel, a.nodes(), "kind", "w")); assert.ok(validate(sel, a.nodes(), "depth", 0)); assert.ok(validate(sel, a.nodes(), "at", -1));
    assert.equal(validate(sel, a.nodes(), "kind", "v"), null);
}
let next = { ...NOTCH_DEFAULT };
assert.deepEqual(next, { kind: "slit", depth: 6 });
// kind V: the notch is a V (three points), and the Notch tool's next is a V
a.apply(opsFor(sel, a.nodes(), "kind", "v"), "set kind");
next = nextNotch(next, "kind", "v");
assert.equal(piece().notches[0].kind, "v");
assert.equal(drawn().notchLines[0].length / 2, 3);
// depth 9: the mark reaches 9 mm in; the next depth is 9
a.apply(opsFor(sel, a.nodes(), "depth", 9), "set depth");
next = nextNotch(next, "depth", 9);
near(Math.max(...pairs(drawn().notchLines[0]).map((p) => p[1])), 9, 1e-9);
assert.deepEqual(next, { kind: "v", depth: 9 });
assert.deepEqual(nextNotch(next, "at", 40), next, "at is the notch's own");
// at 25 mm: the mark moves along the side
a.apply(opsFor(sel, a.nodes(), "at", 25), "set at");
assert.ok(pairs(drawn().notchLines[0]).every((p) => Math.abs(p[0] - 25) <= 1 + 1e-9));
assert.throws(() => opsFor(sel, a.nodes(), "at", 300, { drawings: new Map([["p1", drawn()]]) }), /300\.0 mm round/);
// the next notch placed has the chosen kind and depth
{
    const t = makeTool("notch", { nodes: a.nodes(), drawings: new Map(), notchNext: next });
    const r = t.down([60, 50], { kind: "edge", id: "p1", s: 190, side: 2 }, {});
    a.apply(r.ops, "notch");
    assert.deepEqual(piece().notches.at(-1), { at: 190, kind: "v", depth: 9 });
    assert.equal(drawn().notchLines.at(-1).length / 2, 3);
    // a fresh session's tool: a slit, 6 mm
    const t0 = makeTool("notch", { nodes: a.nodes(), drawings: new Map() });
    assert.deepEqual(t0.down([0, 0], { kind: "edge", id: "p1", s: 5, side: 0 }, {}).ops[0].fields.notches.at(-1), { at: 5, kind: "slit", depth: 6 });
}
// Remove: the notch goes, the others keep their order
a.apply(opsFor({ kind: "notch", id: "p1", index: 1 }, a.nodes(), "remove", null), "remove notch");
assert.deepEqual(piece().notches.map((n) => n.kind), ["v", "t", "castle", "u", "v"]);
assert.equal(drawn().notchLines.length, 5);
assert.deepEqual(a.problems(), []);
a.free();
console.log("notches-kernel: ok");
