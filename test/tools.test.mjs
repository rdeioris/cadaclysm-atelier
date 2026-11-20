import assert from "node:assert/strict";
import { makeTool } from "../tools.js";
import { SHORTCUTS, toolOfKey } from "../shortcuts.js";
import * as m from "../model.js";

const base = m.newDocumentOps({ slug: "x", label: "X", params: Object.fromEntries(m.FABRIC_FIELDS.map((n) => [n, 1])) }).map((o) => o.node);
const ctx = (extra = {}) => ({ nodes: base, drawings: new Map(), selection: null, fabric: "f_x", request: async () => { throw new Error("no kernel"); }, ...extra });

// rectangle: drag gives one pattern
{
    const t = makeTool("rectangle", ctx());
    t.down([10, 10], null, {});
    const mv = t.move([60, 40], null, {});
    assert.ok(mv.overlay.lines.length === 1);
    const r = t.up([60, 40], null, {});
    const add = r.ops.find((o) => o.op === "add" && o.node.kind === "profile.path");
    assert.deepEqual(m.pathPoints(add.node.path), [[10, 10], [60, 10], [60, 40], [10, 40]]);
    assert.equal(r.ops.find((o) => o.node?.kind === "garment.pattern").node.fabric, "f_x");
}
// polygon: three corners and a curve, closed on the first point
{
    const t = makeTool("polygon", ctx());
    const click = (p) => { t.down(p, null, {}); return t.up(p, null, {}); };
    click([0, 0]);
    click([100, 0]);
    t.down([100, 50], null, {}); t.move([120, 50], null, {}); t.up([120, 50], null, {}); // a drag: a curve into this point
    const r = click([0, 0]);
    const path = r.ops.find((o) => o.node?.kind === "profile.path").node.path;
    assert.deepEqual(m.pathPoints(path), [[0, 0], [100, 0], [100, 50]]);
    assert.equal(path.segments[1].type, "bezier");
    assert.equal(r.done, true);
}
// edit: drag a point previews then commits
{
    const nodes = [...base, { id: "p1_outline", kind: "profile.path", path: m.rectPath(0, 0, 100, 50) }, { id: "p1", kind: "garment.pattern", outline: "p1_outline" }];
    const t = makeTool("edit", ctx({ nodes, selection: { kind: "pattern", id: "p1" } }));
    t.down([100, 0], { kind: "point", id: "p1", index: 1 }, {});
    const mv = t.move([110, -5], null, {});
    assert.deepEqual(m.pathPoints(mv.preview[0].fields.path)[1], [110, -5]);
    const up = t.up([110, -5], null, {});
    assert.equal(up.endPreview, true);
}
// edit: moving a point drags the handles attached to it, and the closing segment for point 0
{
    const path = m.polyPath([[0, 0], [100, 0], [100, 50]], [null, { c1: [100, 10], c2: [100, 40] }, null]);
    const nodes = [...base, { id: "p1_outline", kind: "profile.path", path }, { id: "p1", kind: "garment.pattern", outline: "p1_outline" }];
    const t = makeTool("edit", ctx({ nodes, selection: { kind: "pattern", id: "p1" } }));
    t.down([100, 0], { kind: "point", id: "p1", index: 1 }, {});
    const p = t.move([105, 3], null, {}).preview[0].fields.path;
    assert.deepEqual(p.segments[0].to, [105, 3]);
    assert.deepEqual(p.segments[1].c1, [105, 13]);
    assert.deepEqual(p.segments[1].c2, [100, 40]);
    t.up([105, 3], null, {});
    const t2 = makeTool("edit", ctx({ nodes, selection: { kind: "pattern", id: "p1" } }));
    t2.down([0, 0], { kind: "point", id: "p1", index: 0 }, {});
    const q = t2.move([2, 3], null, {}).preview[0].fields.path;
    assert.deepEqual(q.start, [2, 3]);
    assert.deepEqual(q.segments[2].to, [2, 3]);
    // a handle moves alone
    const t3 = makeTool("edit", ctx({ nodes, selection: { kind: "pattern", id: "p1" } }));
    t3.down([100, 10], { kind: "handle", id: "p1", index: 1, which: "c1" }, {});
    const h = t3.move([90, 10], null, {}).preview[0].fields.path;
    assert.deepEqual(h.segments[1].c1, [90, 10]);
    assert.deepEqual(h.segments[1].c2, [100, 40]);
    assert.deepEqual(h.segments[0].to, [100, 0]);
}
// notch on an edge
{
    const nodes = [...base, { id: "p1", kind: "garment.pattern", notches: [] }];
    const t = makeTool("notch", ctx({ nodes }));
    const r = t.down([40, 0], { kind: "edge", id: "p1", s: 40, side: 0 }, {});
    assert.deepEqual(r.ops[0].fields.notches, [{ at: 40, kind: "slit", depth: 6 }]);
}
// allowance per side
{
    const nodes = [...base, { id: "p1", kind: "garment.pattern", allowance: [10] }];
    const drawings = new Map([["p1", { sides: [0, 100, 150, 250, 300] }]]);
    const t = makeTool("allowance", ctx({ nodes, drawings }));
    t.down([40, 0], { kind: "edge", id: "p1", s: 40, side: 0 }, {});
    t.key("2"); t.key("5");
    const r = t.key("Enter");
    assert.deepEqual(r.ops[0].fields.allowance, [25, 10, 10, 10]);
}
// grain
{
    const nodes = [...base, { id: "p1", kind: "garment.pattern", grain: [0, 1] }];
    const t = makeTool("grain", ctx({ nodes, selection: { kind: "pattern", id: "p1" } }));
    t.down([0, 0], null, {});
    const r = t.up([3, 4], null, {});
    assert.deepEqual(r.ops[0].fields.grain, [0.6, 0.8]);
}
// mirror asks the kernel
{
    const nodes = [...base, { id: "p1_outline", kind: "profile.path", path: m.rectPath(0, 0, 100, 50) }, { id: "p1", kind: "garment.pattern", label: "Front", outline: "p1_outline", fabric: "f_x", layer: 0 }];
    let asked = null;
    const t = makeTool("mirror", ctx({ nodes, selection: { kind: "pattern", id: "p1" }, request: async (k, p) => { asked = [k, p]; return m.rectPath(-100, 0, 100, 50); } }));
    t.down([0, 0], null, {}); t.up([0, 0], null, {});
    t.down([0, 50], null, {});
    const r = await t.up([0, 50], null, {});
    assert.deepEqual(asked, ["mirror", { id: "p1", axis: [0, 0, 0, 50] }]);
    assert.equal(r.ops.find((o) => o.node?.kind === "garment.pattern").node.label, "Front (mirror)");
}
// mirror: a taken label gets " 2", " 3"
{
    const nodes = [...base, { id: "p1_outline", kind: "profile.path", path: m.rectPath(0, 0, 100, 50) },
        { id: "p1", kind: "garment.pattern", label: "Front", outline: "p1_outline", fabric: "f_x", layer: 0 },
        { id: "p2", kind: "garment.pattern", label: "Front (mirror)" }, { id: "p3", kind: "garment.pattern", label: "Front (mirror) 2" }];
    const t = makeTool("mirror", ctx({ nodes, selection: { kind: "pattern", id: "p1" }, request: async () => m.rectPath(-100, 0, 100, 50) }));
    t.down([0, 0], null, {}); t.up([0, 0], null, {});
    t.down([0, 50], null, {});
    const r = await t.up([0, 50], null, {});
    assert.equal(r.ops.find((o) => o.node?.kind === "garment.pattern").node.label, "Front (mirror) 3");
}
// transform: kernel translate, row-major matrix, one request in flight
{
    const nodes = [...base, { id: "p1_outline", kind: "profile.path", path: m.rectPath(0, 0, 100, 50) }, { id: "p1", kind: "garment.pattern", outline: "p1_outline" }];
    const asked = []; let inflight = 0, maxInflight = 0;
    const request = async (k, p) => { asked.push([k, p]); maxInflight = Math.max(maxInflight, ++inflight); await new Promise((r) => setTimeout(r, 5)); inflight--; return m.rectPath(p.matrix[2], p.matrix[5], 100, 50); };
    const t = makeTool("transform", ctx({ nodes, selection: { kind: "pattern", id: "p1" }, request }));
    t.down([5, 5], { kind: "pattern", id: "p1" }, {});
    t.move([10, 5], null, {}); t.move([15, 5], null, {}); const last = t.move([25, 15], null, {});
    await last;
    const up = await t.up([25, 15], null, {});
    assert.equal(maxInflight, 1);
    assert.deepEqual(asked[0], ["transform", { id: "p1", matrix: [1, 0, 5, 0, 1, 0] }]);
    assert.deepEqual(asked.at(-1), ["transform", { id: "p1", matrix: [1, 0, 20, 0, 1, 10] }]);
    assert.equal(up.endPreview, true);
    assert.deepEqual(m.pathPoints(up.preview[0].fields.path)[0], [20, 10]);
}
// internal, dart, unknown tool
{
    const nodes = [...base, { id: "p1", kind: "garment.pattern", internal: [] }];
    const t = makeTool("internal", ctx({ nodes, selection: { kind: "pattern", id: "p1" } }));
    for (const p of [[10, 10], [20, 20]]) { t.down(p, null, {}); t.up(p, null, {}); }
    const r = t.key("Enter");
    assert.deepEqual(r.ops[0].fields.internal, [{ kind: "line", path: { start: [10, 10], segments: [{ type: "line", to: [20, 20] }] } }]);
    const d = makeTool("dart", ctx({ nodes: [...base, { id: "p1", kind: "garment.pattern", internal: [], notches: [] }], selection: { kind: "pattern", id: "p1" } }));
    d.down([20, 0], { kind: "edge", id: "p1", s: 20, side: 0 }, {}); d.up([20, 0], null, {});
    d.down([40, 0], { kind: "edge", id: "p1", s: 40, side: 0 }, {}); d.up([40, 0], null, {});
    d.down([30, 30], null, {});
    const dr = d.up([30, 30], null, {});
    assert.equal(dr.ops[0].fields.internal[0].kind, "dart");
    assert.deepEqual(dr.ops[0].fields.notches.map((n) => n.at), [20, 40]);
    assert.throws(() => makeTool("nope", ctx()), /unknown tool nope/);
}
// fix round 1: screen-space tolerances
{
    const poly = (px, closeAt) => {
        const t = makeTool("polygon", ctx(px ? { pxToWorld: px } : {}));
        const click = (p) => { t.down(p, null, {}); return t.up(p, null, {}); };
        click([0, 0]); click([100, 0]);
        t.down([100, 50], null, {}); t.move([101, 50], null, {}); t.up([101, 50], null, {}); // 1 unit jitter: a corner
        click([100, 100]);
        return click(closeAt);
    };
    const r = poly(1, [5, 0]);
    const path = r.ops.find((o) => o.node?.kind === "profile.path").node.path;
    assert.equal(path.segments.every((s) => s.type === "line"), true);
    assert.equal(r.done, true);
    assert.equal(poly(0.5, [5, 0]).ops, undefined); // 5 units is 10 px at 0.5: too far
    const few = makeTool("polygon", ctx());
    few.down([0, 0], null, {}); few.up([0, 0], null, {});
    few.down([2, 0], null, {}); assert.deepEqual(few.up([2, 0], null, {}), {}); // fewer than 3 points: ignored
    const rc = makeTool("rectangle", ctx());
    rc.down([0, 0], null, {});
    assert.equal(rc.up([2, 2], null, {}).ops, undefined);
}
// fix round 1: transform and edit robustness
{
    const nodes = [...base, { id: "p1_outline", kind: "profile.path", path: m.rectPath(0, 0, 100, 50) }, { id: "p1", kind: "garment.pattern", outline: "p1_outline" }];
    const sel = { kind: "pattern", id: "p1" };
    const bad = makeTool("transform", ctx({ nodes, selection: sel, request: async () => { throw new Error("boom"); } }));
    bad.down([0, 0], { kind: "pattern", id: "p1" }, {});
    assert.deepEqual(await bad.move([10, 0], null, {}), {});
    // no preview went out: nothing to commit (M4)
    assert.deepEqual(await bad.up([10, 0], null, {}), {});
    // Escape cancels; a reply arriving after the cancel is never a preview
    let release;
    const slow = makeTool("transform", ctx({ nodes, selection: sel, request: () => new Promise((r) => { release = () => r(m.rectPath(10, 0, 100, 50)); }) }));
    slow.down([0, 0], { kind: "pattern", id: "p1" }, {});
    const pending = slow.move([10, 0], null, {});
    assert.deepEqual(slow.key("Escape"), { cancel: true });
    release();
    assert.deepEqual(await pending, {});
    const ed = makeTool("edit", ctx({ nodes, selection: sel }));
    ed.down([100, 0], { kind: "point", id: "p1", index: 1 }, {});
    assert.deepEqual(ed.key("Escape"), { cancel: true });
    assert.deepEqual(ed.up([100, 0], null, {}), {});
}
// fix round 1: mirror reflects grain, keeps allowance order (the kernel keeps segment order), falls back to "Piece"
{
    const nodes = [...base, { id: "p1_outline", kind: "profile.path", path: m.rectPath(0, 0, 100, 50) },
        { id: "p1", kind: "garment.pattern", outline: "p1_outline", fabric: "f_x", layer: 0, allowance: [1, 2, 3, 4], grain: [1, 0] }];
    // Kernel-shaped reply for a mirror across x = 0: side i of the original is side i of the result.
    const reply = { start: [0, 0], segments: [{ type: "line", to: [-100, 0] }, { type: "line", to: [-100, 50] }, { type: "line", to: [0, 50] }, { type: "line", to: [0, 0] }] };
    const t = makeTool("mirror", ctx({ nodes, selection: { kind: "pattern", id: "p1" }, request: async () => reply }));
    t.down([0, 0], null, {}); t.up([0, 0], null, {});
    assert.deepEqual(t.up([0, 0.5], null, {}), {}); // zero-length axis ignored
    const r = await t.up([0, 50], null, {});
    const node = r.ops.find((o) => o.node?.kind === "garment.pattern").node;
    assert.equal(node.label, "Piece (mirror)");
    assert.deepEqual(node.allowance, [1, 2, 3, 4]);
    assert.deepEqual(node.grain.map((v) => Math.round(v * 1e9) / 1e9 + 0), [-1, 0]);
    // the real kernel does keep the segment order
    const { loadKernel } = await import("./package.mjs");
    const { Atelier } = await import("../kernel.js");
    const a = new Atelier(await loadKernel());
    a.apply(m.newDocumentOps({ slug: "x", label: "X", params: Object.fromEntries(m.FABRIC_FIELDS.map((n) => [n, 1])) }), "new");
    a.apply(m.addPattern(a.nodes(), { label: "F", path: m.rectPath(0, 0, 100, 50), fabric: "f_x" }).ops, "r");
    assert.deepEqual(await a.mirrored("p1", [0, 0, 0, 1]), reply);
}
// fix round 1: allowance takes one dot; internal double-click drops the duplicate point
{
    const nodes = [...base, { id: "p1", kind: "garment.pattern", allowance: [10] }];
    const t = makeTool("allowance", ctx({ nodes, drawings: new Map([["p1", { sides: [0, 1, 2] }]]) }));
    t.down([0, 0], { kind: "edge", id: "p1", s: 0, side: 1 }, {});
    for (const k of ["1", ".", ".", "5"]) t.key(k);
    assert.deepEqual(t.key("Enter").ops[0].fields.allowance, [10, 1.5]);
    const n2 = [...base, { id: "p1", kind: "garment.pattern" }];
    const i = makeTool("internal", ctx({ nodes: n2, selection: { kind: "pattern", id: "p1" } }));
    for (const p of [[0, 0], [10, 0], [10, 0.5]]) { i.down(p, null, {}); i.up(p, null, {}); }
    assert.equal(i.key("Enter").ops[0].fields.internal[0].path.segments.length, 1);
}
// fix round 2: a duplicate move after the reply, then a new move and up
{
    const nodes = [...base, { id: "p1_outline", kind: "profile.path", path: m.rectPath(0, 0, 100, 50) }, { id: "p1", kind: "garment.pattern", outline: "p1_outline" }];
    const request = async (k, p) => m.rectPath(p.matrix[2], p.matrix[5], 100, 50);
    const t = makeTool("transform", ctx({ nodes, selection: { kind: "pattern", id: "p1" }, request }));
    t.down([0, 0], { kind: "pattern", id: "p1" }, {});
    await t.move([10, 0], null, {});
    assert.deepEqual(m.pathPoints((await t.move([10, 0], null, {})).preview[0].fields.path)[0], [10, 0]);
    const mv = await t.move([20, 0], null, {});
    assert.deepEqual(m.pathPoints(mv.preview[0].fields.path)[0], [20, 0]);
    assert.equal((await t.up([20, 0], null, {})).endPreview, true);
    // a rejected mirror request adds nothing and resets the gesture
    const mn = [...nodes.slice(0, -1), { id: "p1", kind: "garment.pattern", label: "A", outline: "p1_outline", fabric: "f_x" }];
    const mi = makeTool("mirror", ctx({ nodes: mn, selection: { kind: "pattern", id: "p1" }, request: async () => { throw new Error("boom"); } }));
    mi.down([0, 0], null, {}); mi.up([0, 0], null, {});
    mi.down([0, 50], null, {});
    assert.deepEqual(await mi.up([0, 50], null, {}), {});
}
// M4: a click without a drag sends no empty endPreview; I2: drawn pieces never repeat a label
{
    const nodes = [...base, { id: "p1_outline", kind: "profile.path", path: m.rectPath(0, 0, 100, 50) },
        { id: "p1", kind: "garment.pattern", label: "Piece 2", outline: "p1_outline" }];
    const sel = { kind: "pattern", id: "p1" };
    const ed = makeTool("edit", ctx({ nodes, selection: sel }));
    ed.down([100, 0], { kind: "point", id: "p1", index: 1 }, {});
    assert.deepEqual(ed.move([101, 0], null, {}), {}, "less than a drag: no preview");
    assert.deepEqual(ed.up([101, 0], null, {}), {});
    let asked = 0;
    const tr = makeTool("transform", ctx({ nodes, selection: sel, request: async (k, p) => { asked++; return m.rectPath(p.matrix[2], p.matrix[5], 100, 50); } }));
    tr.down([5, 5], { kind: "pattern", id: "p1" }, {});
    assert.deepEqual(await tr.up([5, 5], null, {}), {});
    assert.equal(asked, 0);
    const labelOf = (r) => r.ops.find((o) => o.node?.kind === "garment.pattern").node.label;
    const rc = makeTool("rectangle", ctx({ nodes }));
    rc.down([0, 0], null, {});
    assert.equal(labelOf(rc.up([50, 50], null, {})), "Piece 3");
    const pg = makeTool("polygon", ctx({ nodes }));
    for (const p of [[0, 0], [100, 0], [100, 50], [0, 0]]) { pg.down(p, null, {}); var pr = pg.up(p, null, {}); }
    assert.equal(labelOf(pr), "Piece 3");
    assert.equal(m.freeLabel(nodes, "Piece 2"), "Piece 2 2");
    assert.equal(m.freeLabel(nodes, "Front"), "Front");
}
// snapping tools and their last point (the angle lock's base, the typed length's origin)
{
    const { SNAPPING } = await import("../tools.js");
    for (const n of ["rectangle", "polygon", "internal", "dart", "mirror", "grain"]) assert.ok(SNAPPING.has(n), n);
    assert.ok(!SNAPPING.has("edit") && !SNAPPING.has("transform"));
    const t = makeTool("polygon", ctx());
    assert.equal(t.lastPoint(), null);
    t.down([0, 0], null, {}); t.up([0, 0], null, {});
    t.down([10, 5], null, {}); t.up([10, 5], null, {});
    assert.deepEqual(t.lastPoint(), [10, 5]);
    const r = makeTool("rectangle", ctx());
    r.down([3, 4], null, {});
    assert.deepEqual(r.lastPoint(), [3, 4]);
}
// box select: the edit tool's empty-space drag asks for the selected piece's points in the box,
// and a drag of a selected point moves them all; the transform tool's box selects pieces
{
    const nodes = [...base, { id: "p1_outline", kind: "profile.path", path: m.rectPath(0, 0, 100, 50) }, { id: "p1", kind: "garment.pattern", outline: "p1_outline" }];
    const asked = [];
    const request = async (kind, p) => { asked.push([kind, p]); return kind === "pickRect" ? { indices: [1, 2] } : null; };
    const t = makeTool("edit", ctx({ nodes, selection: { kind: "pattern", id: "p1" }, request }));
    t.down([120, -10], null, { px: [400, 300] });
    const mv = t.move([90, 60], null, { px: [300, 100] });
    assert.equal(mv.overlay.lines[0].length, 5, "the box drawn");
    const up = await t.up([90, 60], null, { px: [300, 100] });
    assert.deepEqual(asked[0], ["pickRect", { from: [400, 300], to: [300, 100], kind: "points" }]);
    assert.deepEqual(up.pointSel, [1, 2]);
    const t2 = makeTool("edit", ctx({ nodes, selection: { kind: "pattern", id: "p1" }, pointSel: [1, 2], request }));
    t2.down([100, 0], { kind: "point", id: "p1", index: 1 }, {});
    const pts = m.pathPoints(t2.move([110, 0], null, {}).preview[0].fields.path);
    assert.deepEqual([pts[1], pts[2]], [[110, 0], [110, 50]], "both selected points move");
    assert.deepEqual(pts[0], [0, 0]);
}
{
    const request = async (kind, p) => (kind === "pickRect" ? { ids: ["p1", "p2"] } : null);
    const t = makeTool("transform", ctx({ request }));
    t.down([0, 0], null, { px: [10, 10] });
    t.move([500, 500], null, { px: [600, 400] });
    const up = await t.up([500, 500], null, { px: [600, 400] });
    assert.deepEqual(up.select, { kind: "pattern", id: "p1", ids: ["p1", "p2"] });
}
// B6: with a piece selected, a Move press on empty space still starts the box, never a move;
// B4: a press on a piece of a multi-selection moves them all through one transformAll
{
    const nodes = [...base, { id: "p1_outline", kind: "profile.path", path: m.rectPath(0, 0, 100, 50) }, { id: "p1", kind: "garment.pattern", outline: "p1_outline" },
        { id: "p2_outline", kind: "profile.path", path: m.rectPath(200, 0, 100, 50) }, { id: "p2", kind: "garment.pattern", outline: "p2_outline" }];
    const asked = [];
    const request = async (kind, p) => {
        asked.push([kind, p]);
        if (kind === "pickRect") return { ids: [] };
        if (kind === "transformAll") return Object.fromEntries(p.ids.map((id) => [id, m.rectPath((id === "p1" ? 0 : 200) + p.matrix[2], p.matrix[5], 100, 50)]));
        return m.rectPath(p.matrix[2], p.matrix[5], 100, 50);
    };
    const t = makeTool("transform", ctx({ nodes, selection: { kind: "pattern", id: "p1" }, request }));
    t.down([500, 500], null, { px: [10, 10] });
    assert.ok(t.move([520, 500], null, { px: [30, 10] }).overlay, "the box, not a move");
    const up = await t.up([520, 500], null, { px: [30, 10] });
    assert.deepEqual(asked.map((a) => a[0]), ["pickRect"]);
    assert.deepEqual(up.select, null, "an empty box clears the selection");
    asked.length = 0;
    const t2 = makeTool("transform", ctx({ nodes, selection: { kind: "pattern", id: "p1", ids: ["p1", "p2"] }, request }));
    assert.deepEqual(t2.down([5, 5], { kind: "pattern", id: "p2" }, {}), {}, "the multi-selection kept");
    await t2.move([15, 5], null, {});
    const up2 = await t2.up([15, 5], null, {});
    assert.deepEqual(asked, [["transformAll", { ids: ["p1", "p2"], matrix: [1, 0, 10, 0, 1, 0] }]]);
    assert.equal(up2.endPreview, true);
    assert.deepEqual(up2.preview.map((o) => m.pathPoints(o.fields.path)[0]), [[10, 0], [210, 0]]);
}
assert.equal(SHORTCUTS.S.tool, "rectangle");
assert.deepEqual(toolOfKey({ key: "z", ctrlKey: true }), { command: "undo" });
console.log("tools: ok");
