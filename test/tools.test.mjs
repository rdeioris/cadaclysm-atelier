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
    const t = makeTool("mirror", ctx({ nodes, selection: { kind: "pattern", id: "p1" }, request: async (k, p) => { asked = [k, p]; return { path: m.rectPath(-100, 0, 100, 50), internal: [], notches: [] }; } }));
    t.down([0, 0], null, {}); t.up([0, 0], null, {});
    t.down([0, 50], null, {});
    const r = await t.up([0, 50], null, {});
    assert.deepEqual(asked, ["mirror", { id: "p1", axis: [0, 0, 0, 50] }]);
    assert.equal(r.ops.find((o) => o.node?.kind === "garment.pattern").node.label, "Front (mirror)");
    assert.equal(r.ops.find((o) => o.node?.kind === "garment.pattern").node.internal, undefined, "no internal lines: none set");
}
// mirror: the kernel's internal lines and notches go on the new piece
{
    const nodes = [...base, { id: "p1_outline", kind: "profile.path", path: m.rectPath(0, 0, 100, 50) }, { id: "p1", kind: "garment.pattern", label: "Front", outline: "p1_outline", fabric: "f_x", layer: 0 }];
    const internal = [{ kind: "line", path: { start: [-20, 10], segments: [{ type: "line", to: [-60, 40] }] } }], notches = [{ at: 70, kind: "slit", depth: 6 }];
    const t = makeTool("mirror", ctx({ nodes, selection: { kind: "pattern", id: "p1" }, request: async () => ({ path: m.rectPath(-100, 0, 100, 50), internal, notches }) }));
    t.down([0, 0], null, {}); t.up([0, 0], null, {});
    t.down([0, 50], null, {});
    const node = (await t.up([0, 50], null, {})).ops.find((o) => o.node?.kind === "garment.pattern").node;
    assert.deepEqual(node.internal, internal);
    assert.deepEqual(node.notches, notches);
}
// mirror: a taken label gets " 2", " 3"
{
    const nodes = [...base, { id: "p1_outline", kind: "profile.path", path: m.rectPath(0, 0, 100, 50) },
        { id: "p1", kind: "garment.pattern", label: "Front", outline: "p1_outline", fabric: "f_x", layer: 0 },
        { id: "p2", kind: "garment.pattern", label: "Front (mirror)" }, { id: "p3", kind: "garment.pattern", label: "Front (mirror) 2" }];
    const t = makeTool("mirror", ctx({ nodes, selection: { kind: "pattern", id: "p1" }, request: async () => ({ path: m.rectPath(-100, 0, 100, 50) }) }));
    t.down([0, 0], null, {}); t.up([0, 0], null, {});
    t.down([0, 50], null, {});
    const r = await t.up([0, 50], null, {});
    assert.equal(r.ops.find((o) => o.node?.kind === "garment.pattern").node.label, "Front (mirror) 3");
}
// transform: kernel translate, row-major matrix, one request in flight; the kernel answers
// whole pieces (kernel.js transformedPiece)
{
    const nodes = [...base, { id: "p1_outline", kind: "profile.path", path: m.rectPath(0, 0, 100, 50) }, { id: "p1", kind: "garment.pattern", outline: "p1_outline" }];
    const asked = []; let inflight = 0, maxInflight = 0;
    const request = async (k, p) => { asked.push([k, p]); maxInflight = Math.max(maxInflight, ++inflight); await new Promise((r) => setTimeout(r, 5)); inflight--; return ({ path: m.rectPath(p.matrix[2], p.matrix[5], 100, 50) }); };
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
    const slow = makeTool("transform", ctx({ nodes, selection: sel, request: () => new Promise((r) => { release = () => r({ path: m.rectPath(10, 0, 100, 50) }); }) }));
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
    const t = makeTool("mirror", ctx({ nodes, selection: { kind: "pattern", id: "p1" }, request: async () => ({ path: reply, internal: [], notches: [] }) }));
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
    assert.deepEqual(a.mirroredPiece("p1", [0, 0, 0, 1]), { path: reply, internal: [], notches: [] }, "the piece the worker answers");
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
    const request = async (k, p) => ({ path: m.rectPath(p.matrix[2], p.matrix[5], 100, 50) });
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
    const tr = makeTool("transform", ctx({ nodes, selection: sel, request: async (k, p) => { asked++; return ({ path: m.rectPath(p.matrix[2], p.matrix[5], 100, 50) }); } }));
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
        if (kind === "transformAll") return Object.fromEntries(p.ids.map((id) => [id, { path: m.rectPath((id === "p1" ? 0 : 200) + p.matrix[2], p.matrix[5], 100, 50) }]));
        return ({ path: m.rectPath(p.matrix[2], p.matrix[5], 100, 50) });
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
// the ellipse tool: a drag asks the kernel for the path; Shift a circle; a click asks for a size
{
    const asked = [];
    const request = async (kind, p) => { asked.push([kind, p]); return m.rectPath(0, 0, 1, 1); };
    const t = makeTool("ellipse", ctx({ request }));
    t.down([0, 0], null, {});
    assert.deepEqual(t.move([60, 20], null, {}).overlay.ellipse, [30, 10, 30, 10]);
    assert.deepEqual(t.move([60, 20], null, { shift: true }).overlay.ellipse, [30, 10, 30, 30]);
    // Shift is the circle here: no 45 degree snap base from the first corner (it would bend the drag)
    assert.equal(t.lastPoint(), null);
    const r = await t.up([60, 20], null, {});
    assert.deepEqual(asked[0], ["ellipse", { cx: 30, cy: 10, rx: 30, ry: 10 }]);
    assert.ok(r.ops.some((o) => o.node?.kind === "garment.pattern"));
    const c = makeTool("ellipse", ctx({ request }));
    c.down([5, 5], null, {});
    assert.deepEqual(c.up([5, 5], null, {}), { ask: { kind: "size", shape: "ellipse" } });
    await c.sized(40, 20);
    assert.deepEqual(asked[1], ["ellipse", { cx: 5, cy: 5, rx: 20, ry: 10 }], "a dialog ellipse is centred on the click");
    const bad = makeTool("ellipse", ctx());
    bad.down([0, 0], null, {});
    const failed = await bad.up([10, 10], null, {});
    assert.match(failed.status, /^ellipse: no kernel/);
    assert.equal(failed.ops, undefined);
    const rc = makeTool("rectangle", ctx());
    rc.down([5, 5], null, {});
    assert.deepEqual(rc.up([5, 5], null, {}), { ask: { kind: "size", shape: "rectangle" } });
    const placed = rc.sized(40, 20);
    assert.deepEqual(m.pathPoints(placed.ops.find((o) => o.node?.kind === "profile.path").node.path), [[5, 5], [45, 5], [45, 25], [5, 25]], "a dialog rectangle's lower-left corner is the click");
    assert.deepEqual(rc.sized(40, 20), {}, "one size per click");
    assert.equal(SHORTCUTS.E.tool, "ellipse");
}
// the edit tool: a conic's control point moves; an arc's ends are locked (ruling 13)
{
    const conic = { start: [10, 0], segments: [{ type: "conic", control: [10, 10], to: [0, 10], weight: 0.7 }, { type: "line", to: [0, 0] }, { type: "line", to: [10, 0] }] };
    const nodes = [...base, { id: "p1_outline", kind: "profile.path", path: conic }, { id: "p1", kind: "garment.pattern", outline: "p1_outline" }];
    const t = makeTool("edit", ctx({ nodes, selection: { kind: "pattern", id: "p1" } }));
    t.down([10, 10], { kind: "handle", id: "p1", index: 0, which: "control" }, {});
    assert.deepEqual(t.move([13, 13], null, {}).preview[0].fields.path.segments[0].control, [13, 13], "past the click tolerance (DRAG 3 at pxToWorld 1)");
    const arc = { start: [0, 0], segments: [{ type: "line", to: [10, 0] }, { type: "arc", to: [0, 10], centre: [0, 0], ccw: true }, { type: "line", to: [0, 0] }] };
    const an = [...base, { id: "p1_outline", kind: "profile.path", path: arc }, { id: "p1", kind: "garment.pattern", outline: "p1_outline" }];
    const e = makeTool("edit", ctx({ nodes: an, selection: { kind: "pattern", id: "p1" } }));
    assert.match(e.down([10, 0], { kind: "point", id: "p1", index: 1 }, {}).status, /arc/);
    assert.deepEqual(e.move([20, 0], null, {}), {}, "a refused press drags nothing");
    const e2 = makeTool("edit", ctx({ nodes: an, selection: { kind: "pattern", id: "p1" } }));
    assert.match(e2.down([5, 5], { kind: "edge", id: "p1", side: 1 }, {}).status, /arc/);
    // a line ending on the arc moves that end too: refused; the free corner still moves
    const e3 = makeTool("edit", ctx({ nodes: an, selection: { kind: "pattern", id: "p1" } }));
    assert.match(e3.down([5, 0], { kind: "edge", id: "p1", side: 0 }, {}).status, /arc/);
    const e4 = makeTool("edit", ctx({ nodes: an, selection: { kind: "pattern", id: "p1" } }));
    assert.equal(e4.down([0, 0], { kind: "point", id: "p1", index: 0 }, {}).status, undefined);
    assert.deepEqual(e4.move([-5, -5], null, {}).preview[0].fields.path.start, [-5, -5]);
    // a click on a seamed arc still selects its seam; a drag on it moves nothing
    const e5 = makeTool("edit", ctx({ nodes: an, selection: { kind: "pattern", id: "p1" } }));
    e5.down([5, 5], { kind: "edge", id: "p1", side: 1, seam: "s1" }, {});
    assert.deepEqual(e5.up([5, 5], null, {}), { select: { kind: "seam", id: "s1" } });
    const e6 = makeTool("edit", ctx({ nodes: an, selection: { kind: "pattern", id: "p1" } }));
    assert.deepEqual(e6.down([5, 5], { kind: "edge", id: "p1", side: 1, seam: "s1" }, {}), {}, "a press may be the seam's click");
    assert.match(e6.move([20, 20], null, {}).status, /arc/, "the drag is refused");
    assert.deepEqual(e6.move([25, 20], null, {}), {}, "once");
    assert.deepEqual(e6.up([20, 20], null, {}), {}, "a drag on a locked seam edge selects nothing");
}
{
    const { typedPoint, readout } = await import("../tools.js");
    assert.deepEqual(typedPoint([10, 10], [20, 10], 100), [110, 10], "along the current direction");
    const up = typedPoint([0, 0], [5, 5], 50, 90);
    assert.ok(Math.abs(up[0]) < 1e-9 && Math.abs(up[1] - 50) < 1e-9, "a typed angle wins");
    assert.deepEqual(typedPoint([1, 2], [1, 2], 3), [4, 2], "no direction yet: along +x");
    assert.equal(readout([0, 0], [30, 40]), "50.0 mm");
    assert.equal(readout(null, [1, 1]), null);
}
{
    // the typed box's text: a finite length above 0, a blank or finite angle; anything else places no point
    const { typedValues, typedPoint } = await import("../tools.js");
    assert.deepEqual(typedValues("100", ""), { length: 100, angle: null });
    assert.deepEqual(typedValues("2.5", " 90 "), { length: 2.5, angle: 90 });
    assert.deepEqual(typedValues("50", "-45"), { length: 50, angle: -45 });
    for (const bad of ["", " ", "0", "-5", "1,5", "abc", "1e999", "Infinity", "-Infinity", "NaN", "."])
        assert.equal(typedValues(bad, ""), null, `length ${JSON.stringify(bad)} refused`);
    for (const bad of ["abc", "1,5", "1e999", "Infinity", "."])
        assert.equal(typedValues("10", bad), null, `angle ${JSON.stringify(bad)} refused`);
    // the next typed length after a commit, the pointer still: from the new point toward the pointer
    // (the rubber band's direction), so a pointer behind the new point turns the shape back
    assert.deepEqual(typedPoint([100, 0], [40, 0], 30), [70, 0], "toward the still pointer");
}
{
    const nodes = [...base, { id: "p1_outline", kind: "profile.path", path: m.rectPath(0, 0, 100, 50) },
        { id: "p1", kind: "garment.pattern", outline: "p1_outline", internal: [{ kind: "line", path: { start: [50, -5], segments: [{ type: "line", to: [50, 55] }] } }] }];
    const t = makeTool("cut", ctx({ nodes }));
    assert.deepEqual(t.up([50, 10], { kind: "internal", id: "p1", index: 0 }, {}).cut,
        { id: "p1", cutter: { start: [50, -5], segments: [{ type: "line", to: [50, 55] }] }, sew: false, consume: 0 }, "a picked internal line is the cutter");
    const d = makeTool("cut-sew", ctx({ nodes, selection: { kind: "pattern", id: "p1" } }));
    d.up([20, -10], null, {}); d.up([20, 60], null, {});
    assert.deepEqual(d.key("Enter").cut, { id: "p1", cutter: { start: [20, -10], segments: [{ type: "line", to: [20, 60] }] }, sew: true, consume: null });
    assert.match(makeTool("cut", ctx({ nodes })).key("Enter").status, /select/);
}
// fillet: a corner, then a dragged or typed radius
{
    const nodes = [...base, { id: "p1_outline", kind: "profile.path", path: m.rectPath(0, 0, 100, 50) }, { id: "p1", kind: "garment.pattern", outline: "p1_outline" }];
    const t = makeTool("fillet", ctx({ nodes, selection: { kind: "pattern", id: "p1" } }));
    t.down([100, 0], { kind: "point", id: "p1", index: 1 }, {});
    assert.deepEqual(t.up([108, 6], null, {}).fillet, { id: "p1", corner: 1, radius: 10 }, "drag out the radius");
    const u = makeTool("fillet", ctx({ nodes, selection: { kind: "pattern", id: "p1" } }));
    u.down([100, 0], { kind: "point", id: "p1", index: 1 }, {});
    assert.equal(u.up([100, 0], null, {}).error, false);
    assert.deepEqual(u.lastPoint(), [100, 0]);
    assert.deepEqual(u.typed([112, 0], 12).fillet, { id: "p1", corner: 1, radius: 12 }, "or type it");
    assert.equal(u.lastPoint(), null, "one radius per corner");
    const w = makeTool("fillet", ctx({ nodes, selection: { kind: "pattern", id: "p1" } }));
    w.down([101, 1], { kind: "point", id: "p1", index: 1 }, {});
    assert.deepEqual(w.up([108, 6], null, {}).fillet.radius, 10, "the radius runs from the corner, not from the press beside it");
    const v = makeTool("fillet", ctx({ nodes }));
    assert.deepEqual(v.down([50, 25], { kind: "pattern", id: "p1" }, {}).select, { kind: "pattern", id: "p1" }, "a first click selects the piece");
}
// the edit lock on a filleted outline: hit.side is a segment index (an arc is a side of its own),
// so the side after the arc's far end is locked and the next one is free
{
    const filleted = { start: [0, 0], segments: [{ type: "line", to: [90, 0] }, { type: "arc", to: [100, 10], centre: [90, 10], ccw: true },
        { type: "line", to: [100, 50] }, { type: "line", to: [0, 50] }, { type: "line", to: [0, 0] }] };
    const nodes = [...base, { id: "p1_outline", kind: "profile.path", path: filleted }, { id: "p1", kind: "garment.pattern", outline: "p1_outline" }];
    const tool = () => makeTool("edit", ctx({ nodes, selection: { kind: "pattern", id: "p1" } }));
    assert.match(tool().down([100, 30], { kind: "edge", id: "p1", side: 2 }, {}).status, /arc/, "the side leaving the arc");
    const free = tool();
    assert.equal(free.down([50, 50], { kind: "edge", id: "p1", side: 3 }, {}).status, undefined, "the top side is free");
    assert.deepEqual(m.pathPoints(free.move([50, 60], null, {}).preview[0].fields.path).slice(3), [[100, 60], [0, 60]]);
}
assert.equal(SHORTCUTS.S.tool, "rectangle");
assert.deepEqual(toolOfKey({ key: "z", ctrlKey: true }), { command: "undo" });
// A2: Move previews the whole piece the kernel answers -- outline, internal lines, notches, grain
{
    const line = { kind: "line", path: { start: [10, 10], segments: [{ type: "line", to: [40, 10] }] } };
    const nodes = [...base, { id: "p1_outline", kind: "profile.path", path: m.rectPath(0, 0, 100, 50) },
        { id: "p1", kind: "garment.pattern", outline: "p1_outline", internal: [line], notches: [{ at: 30, kind: "slit", depth: 5 }], grain: [0, 1] }];
    const request = async (k, p) => ({ path: m.rectPath(p.matrix[2], p.matrix[5], 100, 50), internal: [{ ...line, path: { start: [10 + p.matrix[2], 10], segments: [{ type: "line", to: [40 + p.matrix[2], 10] }] } }], notches: [{ at: 30, kind: "slit", depth: 5 }], grain: [0, 1] });
    const t = makeTool("transform", ctx({ nodes, selection: { kind: "pattern", id: "p1" }, request }));
    t.down([0, 0], { kind: "pattern", id: "p1" }, {});
    await t.move([7, 0], null, {});
    const up = await t.up([7, 0], null, {});
    assert.equal(up.endPreview, true);
    assert.equal(up.preview[0].id, "p1_outline", "the outline first: the page's preview pattern");
    const set = up.preview.find((o) => o.id === "p1").fields;
    assert.deepEqual(set.internal[0].path.start, [17, 10]);
    assert.deepEqual(set.notches, [{ at: 30, kind: "slit", depth: 5 }]);
    assert.deepEqual(set.grain, [0, 1]);
}
assert.deepEqual(toolOfKey({ key: "c", ctrlKey: true }), { command: "copy" });
assert.deepEqual(toolOfKey({ key: "v", ctrlKey: true }), { command: "paste" });
assert.deepEqual(toolOfKey({ key: "d", ctrlKey: true }), { command: "duplicate" });
console.log("tools: ok");
