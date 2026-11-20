// Trace (spec §4): an internal closed shape copied out as a new piece beside the original, which
// keeps it; one undo; an open line is refused.
import assert from "node:assert/strict";
import { loadKernel } from "./package.mjs";
import { Atelier } from "../kernel.js";
import * as m from "../model.js";

const k = await loadKernel();
const params = Object.fromEntries(m.FABRIC_FIELDS.map((n) => [n, 1]));
const a = new Atelier(k);
a.reset(m.newDocumentOps({ slug: "x", label: "X", params }));
const add = m.addPattern(a.nodes(), { label: "Front", path: m.rectPath(0, 0, 200, 100), fabric: "f_x", grain: [1, 0] });
add.ops.find((o) => o.node?.kind === "garment.pattern").node.internal = [
    { kind: "line", path: m.rectPath(20, 20, 40, 30) }, { kind: "line", path: { start: [0, 0], segments: [{ type: "line", to: [5, 5] }] } }];
a.apply(add.ops, "front");
a.apply(a.traceOps("p1", 0), "trace");
const t = a.nodes().find((n) => n.kind === "garment.pattern" && n.label === "Front trace");
assert.ok(t, "the traced piece");
assert.equal(t.fabric, "f_x"); assert.deepEqual(t.grain, [1, 0]);
const b = a.drawing(t.id).bounds.map((v) => Math.round(v * 1e6) / 1e6);
assert.deepEqual(b, [240, 20, 280, 50], "beside the original: its width + 20 mm along x");
assert.equal(m.byId(a.nodes()).get("p1").internal.length, 2, "the original keeps the shape");
assert.throws(() => a.traceOps("p1", 1), /closed/);
assert.equal(a.undo(), true);
assert.equal(a.nodes().filter((n) => n.kind === "garment.pattern").length, 1);
// an internal ellipse traces as the kernel's four exact conic quarters, not a flattened ring
{
    const e = a.ellipsePath(100, 50, 30, 20);
    a.apply(m.setPattern(a.nodes(), "p1", { internal: [{ kind: "line", path: { start: e.start, segments: e.segments } }] }), "ellipse");
    a.apply(a.traceOps("p1", 0), "trace");
    const t2 = a.nodes().filter((n) => n.kind === "garment.pattern").at(-1);
    const tp = m.byId(a.nodes()).get(t2.outline).path;
    assert.deepEqual(tp.segments.map((s) => s.type), ["conic", "conic", "conic", "conic"]);
    assert.deepEqual(a.drawing(t2.id).bounds.map((v) => Math.round(v * 1e6) / 1e6), [290, 30, 350, 70], "beside the piece: 200 + 20 mm along x");
}
a.free();
console.log("trace-kernel: ok");
