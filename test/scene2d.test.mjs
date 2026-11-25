// The 2D scene against a fake viewer: what each piece shows, that an unchanged scene shows
// nothing again, that a moved piece is updated in place, that the item map answers picks.
import assert from "node:assert/strict";
import { specs2d, Items2d, Overlay2d, fillColour, LAYER_2D, bandOf, ACCENT } from "../scene2d.js";
import { hitOf, pointsOf, xformHandles } from "../view2d.js";

function fakeViewer() {
    let next = 1;
    const calls = [];
    const show = (name) => (...args) => { calls.push([name, ...args]); return next++; };
    const call = (name) => (...args) => { calls.push([name, ...args]); return true; };
    return {
        calls,
        showCurves: show("showCurves"), showLines: show("showLines"), showPoints: show("showPoints"), showMesh: show("showMesh"),
        showGlyphs: show("showGlyphs"), showText: show("showText"),
        setCurves: call("setCurves"), setLines: call("setLines"), setPoints: call("setPoints"), setColour: call("setColour"),
        setItemLayer: call("setItemLayer"), setLineStyle: call("setLineStyle"), setPointStyle: call("setPointStyle"),
        setPointStates: call("setPointStates"), setOnTop: call("setOnTop"), setSnapPoints: call("setSnapPoints"),
        setText: call("setText"), setItemVisible: call("setItemVisible"), remove: call("remove"),
    };
}
const square = (x) => {
    const b = [];
    for (const [p, q] of [[[x, 0], [x + 100, 0]], [[x + 100, 0], [x + 100, 50]], [[x + 100, 50], [x, 50]], [[x, 50], [x, 0]]])
        for (let i = 0; i < 4; i++) { const t = i / 3; b.push(p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, 0, 1); }
    return Float64Array.from(b);
};
const drawing = (id, x, extra = {}) => ({
    id, label: id.toUpperCase(), fabric: "f_x", layer: 0, sew: [x, 0, x + 100, 0, x + 100, 50, x, 50, x, 0], cut: [x - 10, -10, x + 110, -10, x + 110, 60, x - 10, 60, x - 10, -10],
    samples: [0, x, 0, 100, x + 100, 0, 150, x + 100, 50, 250, x, 50], sides: [0, 100, 150, 250, 300],
    notches: [[x + 50, 0, 0]], notchLines: [[x + 50, 0, x + 50, 6]], internal: [], holes: [], grain: [x + 50, 10, x + 50, 40], bounds: [x, 0, x + 100, 50],
    beziers: square(x), fill: { positions: Float32Array.of(x, 0, -1, x + 100, 0, -1, x, 50, -1), indices: Uint32Array.of(0, 1, 2) }, sig: `${id}@${x}`, ...extra,
});
const nodes = [{ id: "f_x", kind: "garment.fabric" }, { id: "p1_outline", kind: "profile.path", path: { start: [0, 0], segments: [
    { type: "line", to: [100, 0] }, { type: "line", to: [100, 50] }, { type: "line", to: [0, 50] }, { type: "line", to: [0, 0] }] } }];
const seams = [{ id: "s1", a: "p1", b: "p2", points_a: [100, 0, 100, 50], points_b: [200, 0, 200, 50] }];
const colours = new Map([["f_x", "#5aa0d9"]]);
const state = (over = {}) => ({ drawings: [drawing("p1", 0), drawing("p2", 200)], seams, nodes, selection: null, pointSel: [], hover: null, colours, ...over });

// what a piece shows
const specs = specs2d(state());
const keys = specs.map((s) => s.key);
for (const k of ["p1/fill", "p1/sew", "p1/cut", "p1/notch/0", "p1/grain", "p1/grainhead", "p1/label", "seam/s1/a", "seam/s1/b", "seam/s1/no"]) assert.ok(keys.includes(k), `${k} in ${keys}`);
assert.ok(!keys.includes("p1/points"), "handles only on the selected piece");
const sew = specs.find((s) => s.key === "p1/sew");
assert.equal(sew.show, "curves"); assert.deepEqual(sew.what, { kind: "sew", id: "p1" });
assert.deepEqual(Array.from(sew.snapPoints), [50, 0, bandOf(0).line]); assert.equal(sew.snapLabel, "notch");
assert.deepEqual(specs.find((s) => s.key === "p1/cut").dash, { dash: 4, gap: 4 });
assert.deepEqual(specs.find((s) => s.key === "seam/s1/b").what, { kind: "seam", id: "s1", pattern: "p2" });
assert.equal(specs.find((s) => s.key === "p1/fill").colour, fillColour("#5aa0d9"));
const sel = specs2d(state({ selection: { kind: "pattern", id: "p1" }, pointSel: [2] }));
const pts = sel.find((s) => s.key === "p1/points");
assert.deepEqual(Array.from(pts.data), [0, 0, 12, 100, 0, 12, 100, 50, 12, 0, 50, 12]);
assert.deepEqual(pts.states, [0, 0, 2, 0], "point 2 selected");
assert.equal(pts.onTop, true);

// depth: the grid (z = 0) under every fill; each piece a band above the last in layer order
const zOf = (sp) => (sp.show === "mesh" ? sp.data.positions.filter((_, i) => i % 3 === 2) : sp.show === "curves" ? sp.data.filter((_, i) => i % 4 === 2) : sp.data.filter((_, i) => i % 3 === 2));
const zs = (list, key) => [...new Set(Array.from(zOf(list.find((x) => x.key === key))))];
assert.deepEqual(bandOf(0), { fill: 10, line: 11, seam: 12 }); assert.deepEqual(bandOf(1), { fill: 14, line: 15, seam: 16 });
assert.deepEqual(zs(specs, "p1/fill"), [10], "the fill over the grid");
assert.deepEqual(Array.from(specs.find((x) => x.key === "p1/fill").data.positions).filter((_, i) => i % 3 !== 2), [0, 0, 100, 0, 0, 50], "its x, y kept");
// every fill triangle faces the camera (+z, counter-clockwise from above), whichever way the kernel wound it
const ccwTris = (m) => { const p = m.positions, t = m.indices, out = [];
    for (let i = 0; i < t.length; i += 3) { const [a, b, c] = [t[i], t[i + 1], t[i + 2]].map((k) => [p[3 * k], p[3 * k + 1]]);
        out.push((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 0); } return out; };
const cwFill = { positions: Float32Array.of(0, 0, -1, 0, 50, -1, 100, 0, -1, 100, 50, -1), indices: Uint32Array.of(0, 1, 2, 2, 3, 1) };
const flipped = specs2d(state({ drawings: [drawing("p1", 0, { fill: cwFill })], seams: [] })).find((x) => x.key === "p1/fill");
assert.deepEqual(ccwTris(cwFill), [false, true], "the fixture mixes both windings");
assert.deepEqual(ccwTris(flipped.data), [true, true], "every triangle turned to face +z");
assert.deepEqual(zs(specs, "p1/sew"), [11]); assert.deepEqual(zs(specs, "p1/cut"), [11]); assert.deepEqual(zs(specs, "seam/s1/a"), [12]);
assert.deepEqual(zs(specs, "p2/sew"), [15], "the next piece a band higher");
const stacked = specs2d(state({ drawings: [drawing("p1", 0, { layer: 2 }), drawing("p2", 200, { layer: -1 })] }));
assert.ok(zs(stacked, "p1/fill")[0] > Math.max(...zs(stacked, "p2/sew")), "a higher layer's fill covers a lower layer's lines");
assert.notEqual(stacked.find((x) => x.key === "p1/fill").sig, specs.find((x) => x.key === "p1/fill").sig, "a new depth is a new look");
// a seam's number: out of piece a by 8 px (p1 runs counter-clockwise; s1 is its right side), on a box
const no = specs.find((x) => x.key === "seam/s1/no");
assert.deepEqual(no.offset, [8, 0], "out of the piece: +x on its right side");
assert.equal(no.box, "#1e2024"); assert.deepEqual(Array.from(no.data), [100, 25, 12], "at the seam's middle");
const cwSeam = specs2d(state({ drawings: [drawing("p1", 0, { sew: [0, 0, 0, 50, 100, 50, 100, 0, 0, 0] }), drawing("p2", 200)], seams: [{ ...seams[0], points_a: [100, 50, 100, 0] }] }));
assert.deepEqual(cwSeam.find((x) => x.key === "seam/s1/no").offset, [8, 0], "a clockwise piece: still out of it");
const against = specs2d(state({ seams: [{ ...seams[0], points_a: [100, 50, 100, 0] }] }));
assert.deepEqual(against.find((x) => x.key === "seam/s1/no").offset, [8, 0], "a seam range running against the outline: still out of it");
const top = specs2d(state({ seams: [{ ...seams[0], points_a: [100, 50, 0, 50] }] }));
assert.deepEqual(top.find((x) => x.key === "seam/s1/no").offset, [0, 8], "on the top side: up the screen (the View's offset y runs up)");
// a notch: the kernel's mark as lines, picked as that notch; the selected one in the accent
const mark = specs.find((x) => x.key === "p1/notch/0");
assert.equal(mark.show, "lines");
assert.deepEqual(mark.data, [50, 0, bandOf(0).line, 50, 6, bandOf(0).line]);
assert.deepEqual(mark.what, { kind: "notch", id: "p1", index: 0 });
assert.equal(specs2d(state({ selection: { kind: "notch", id: "p1", index: 0 } })).find((x) => x.key === "p1/notch/0").colour, ACCENT);
assert.notEqual(specs2d(state({ selection: { kind: "notch", id: "p2", index: 0 } })).find((x) => x.key === "p1/notch/0").colour, ACCENT);

// apply: everything once on layer 1, nothing again for the same scene
const v = fakeViewer(), items = new Items2d(v);
items.apply(specs);
const shows = v.calls.filter((c) => c[0].startsWith("show")).length;
assert.equal(shows, specs.length);
assert.ok(v.calls.filter((c) => c[0] === "setItemLayer").every((c) => c[2] === LAYER_2D));
// a seam number's text options reach the View
const shownNo = v.calls.find((c) => c[0] === "showText" && c[1] === "1");
assert.deepEqual(shownNo[2].offset, [8, 0]); assert.equal(shownNo[2].box, "#1e2024");
v.calls.length = 0;
items.apply(specs2d(state()));
assert.deepEqual(v.calls, [], "an unchanged scene calls nothing");
// hover recolours in place
items.apply(specs2d(state({ hover: "p1" })));
assert.ok(v.calls.length >= 1 && v.calls.every((c) => c[0] === "setColour"), "the sew line and the notches recoloured, nothing shown again");
const recoloured = v.calls.map((c) => c[1]);
for (const k of ["p1/sew", "p1/notch/0"]) assert.ok(recoloured.includes(items.item(k)), `${k} recoloured on hover`);
v.calls.length = 0;
// a moved piece: its curves and lines in place, its fill and glyphs shown again
const moved = state({ drawings: [drawing("p1", 10), drawing("p2", 200)] });
items.apply(specs2d(moved));
const names = v.calls.map((c) => c[0]);
assert.ok(names.includes("setCurves") && names.includes("setLines"), names.join());
assert.ok(names.includes("showMesh") && names.includes("remove"), names.join());
// the map answers a pick on the sew line, and forgets removed items
const sewItem = items.item("p1/sew");
assert.deepEqual(items.what(sewItem), { kind: "sew", id: "p1" });
const gen0 = items.gen;
items.apply(specs2d(state({ drawings: [drawing("p2", 200)], seams: [] })));
assert.ok(items.gen > gen0, "a removal moves the generation on (a pick across it is asked again)");
assert.equal(items.what(sewItem), null);
assert.equal(items.item("p1/sew"), 0);

// the overlay: one item a kind, hidden when empty
const o = new Overlay2d(v);
v.calls.length = 0;
o.set({ lines: [[[0, 0], [10, 0], [10, 10]]], points: [[0, 0]] });
assert.ok(v.calls.some((c) => c[0] === "showLines" && c[1].length === 12), "two segments");
v.calls.length = 0;
o.set({ lines: [[[0, 0], [20, 0]]], points: [] });
assert.ok(v.calls.some((c) => c[0] === "setLines"));
assert.ok(v.calls.some((c) => c[0] === "setItemVisible" && c[2] === false), "no points: hidden");
// the read-out: shown once, its text replaced in place while the anchor stays, shown again when it moves
v.calls.length = 0;
o.set({ text: { text: "10 mm", at: [5, 5] } });
assert.equal(v.calls.filter((c) => c[0] === "showText").length, 1);
assert.deepEqual(v.calls.find((c) => c[0] === "showText")[2].offset, [12, 12], "above right of the pointer: the View's text offset y runs up");
v.calls.length = 0;
o.set({ text: { text: "12 mm", at: [5, 5] } });
assert.deepEqual(v.calls.filter((c) => c[0].includes("Text") || c[0] === "remove").map((c) => c[0]), ["setText"]);
v.calls.length = 0;
o.set({ text: { text: "12 mm", at: [5, 5] } });
assert.ok(!v.calls.some((c) => c[0].includes("Text") || c[0] === "remove"), "unchanged read-out: no call");
o.set({ text: { text: "12 mm", at: [9, 5] } });
assert.ok(v.calls.some((c) => c[0] === "remove") && v.calls.some((c) => c[0] === "showText"), "moved: shown again");
v.calls.length = 0;
o.set({});
assert.ok(v.calls.some((c) => c[0] === "remove"), "no text: removed");
// the Ruler's labels: a text each, left alone while unchanged, shown again when they change
v.calls.length = 0;
o.set({ labels: [{ at: [0, 0], text: "50.0 mm" }, { at: [10, 0], text: "20.0 mm" }] });
assert.deepEqual(v.calls.filter((c) => c[0] === "showText").map((c) => c[1]), ["50.0 mm", "20.0 mm"]);
v.calls.length = 0;
o.set({ labels: [{ at: [0, 0], text: "50.0 mm" }, { at: [10, 0], text: "20.0 mm" }] });
assert.ok(!v.calls.some((c) => c[0] === "showText" || c[0] === "remove"), "unchanged labels: no call");
o.set({});
assert.equal(v.calls.filter((c) => c[0] === "remove").length, 2, "no labels: both removed");
// holes, internal lines: a holed piece's items
const holeCut = [430, 10, 470, 10, 470, 40, 430, 40];
const holed = drawing("p3", 400, {
    holes: [{ beziers: square(440), cut: [holeCut] }],
    internal: [{ kind: "fold", beziers: square(400) }, { kind: "dart", beziers: square(410) }],
    fill: { positions: Float32Array.of(400, 0, -1, 500, 0, -1, 400, 50, -1, 440, 10, -1), indices: Uint32Array.of(0, 1, 3, 1, 2, 3) },
});
const hs = specs2d(state({ drawings: [holed], seams: [], hover: "p3" }));
const hk = (k) => { const s = hs.find((x) => x.key === k); assert.ok(s, `${k} in ${hs.map((x) => x.key)}`); return s; };
const hole = hk("p3/hole/0");
assert.equal(hole.show, "curves");
assert.deepEqual(Array.from(hole.data).filter((_, i) => i % 4 !== 2), Array.from(holed.holes[0].beziers).filter((_, i) => i % 4 !== 2), "the kernel's hole, x, y and weights");
assert.deepEqual(zs(hs, "p3/hole/0"), [11]);
assert.deepEqual(hole.what, { kind: "hole", id: "p3", index: 0 });
assert.equal(hole.colour, hk("p3/sew").colour, "a hole is drawn as the sew line, hover included");
assert.notEqual(hole.colour, specs2d(state({ drawings: [holed], seams: [] })).find((x) => x.key === "p3/hole/0").colour, "hover recolours the hole");
const hc = hk("p3/holecut/0/0");
assert.equal(hc.show, "lines"); assert.deepEqual(hc.dash, { dash: 4, gap: 4 }); assert.deepEqual(hc.what, { kind: "cut", id: "p3" });
assert.deepEqual(Array.from(hc.data), [430, 10, 11, 470, 10, 11, 470, 10, 11, 470, 40, 11, 470, 40, 11, 430, 40, 11, 430, 40, 11, 430, 10, 11], "the hole cut ring closed");
const fold = hk("p3/internal/0");
assert.equal(fold.show, "curves");
assert.deepEqual(Array.from(fold.data).filter((_, i) => i % 4 !== 2), Array.from(holed.internal[0].beziers).filter((_, i) => i % 4 !== 2));
assert.deepEqual(fold.dash, { dash: 6, gap: 4 }); assert.deepEqual(fold.what, { kind: "internal", id: "p3", index: 0 });
assert.equal(hk("p3/internal/1").dash, null, "only a fold is dashed");
assert.deepEqual(hk("p3/internal/1").what, { kind: "internal", id: "p3", index: 1 });
assert.deepEqual(hk("p3/fill").data.indices.length, holed.fill.indices.length, "the fill with its hole reaches the View as the kernel made it, lifted");
assert.deepEqual(Array.from(hk("p3/fill").data.positions).filter((_, i) => i % 3 !== 2), Array.from(holed.fill.positions).filter((_, i) => i % 3 !== 2));
const hv = fakeViewer(), hItems = new Items2d(hv);
hItems.apply(hs);
const mesh = hv.calls.find((c) => c[0] === "showMesh");
assert.equal(mesh[1].positions, hk("p3/fill").data.positions); assert.equal(mesh[1].indices, hk("p3/fill").data.indices);
const holeItem = hItems.item("p3/hole/0"), holeCutItem = hItems.item("p3/holecut/0/0");
assert.ok(holeItem && holeCutItem);
assert.deepEqual(hItems.what(holeItem), { kind: "hole", id: "p3", index: 0 });
hv.calls.length = 0;
hItems.apply(specs2d(state({ drawings: [{ ...holed, holes: [] }], seams: [], hover: "p3" })));
const removed = hv.calls.filter((c) => c[0] === "remove").map((c) => c[1]);
assert.ok(removed.includes(holeItem) && removed.includes(holeCutItem), "the hole's items removed");
assert.equal(hItems.what(holeItem), null); assert.equal(hItems.item("p3/hole/0"), 0);

// handles and tangents on a selected piece with a bezier and a conic side
const curvy = [{ id: "f_x", kind: "garment.fabric" }, { id: "p1_outline", kind: "profile.path", path: { start: [0, 0], segments: [
    { type: "bezier", c1: [30, -10], c2: [70, -10], to: [100, 0] }, { type: "conic", control: [120, 25], to: [100, 50] },
    { type: "line", to: [0, 50] }, { type: "line", to: [0, 0] }] } }];
const cs = specs2d(state({ nodes: curvy, selection: { kind: "pattern", id: "p1" } }));
const p = pointsOf(curvy, "p1");
const handles = cs.find((s) => s.key === "p1/handles");
assert.equal(handles.show, "points"); assert.equal(handles.onTop, true);
assert.deepEqual(Array.from(handles.data), p.handles.flatMap((h) => [h.at[0], h.at[1], 12]), "the handles in pointsOf order");
const tangents = cs.find((s) => s.key === "p1/tangents");
assert.equal(tangents.show, "lines"); assert.deepEqual(tangents.what, { kind: "tangents", id: "p1", handles: p.handles, points: p.points });
const ends = p.handles.reduce((n, h) => n + (h.from !== undefined) + (h.to !== undefined), 0);
assert.equal(ends, 4, "c1, c2 and the conic's two ends");
assert.equal(tangents.data.length, 6 * ends);
assert.deepEqual(tangents.data.slice(0, 6), [0, 0, 12, 30, -10, 12], "c1 hangs off the bezier's start");
const dmap = new Map([["p1", drawing("p1", 0)]]);
p.handles.forEach((h, k) => assert.deepEqual(hitOf(handles.what, { node: k }, dmap), { kind: "handle", id: "p1", index: h.index, which: h.which }));
// a pick on a tangent line grabs its handle: the conic's tangent from its end (100, 50) to (120, 25)
assert.deepEqual(hitOf(tangents.what, { node: 0, point: [110, 37.5, 3] }, dmap), { kind: "handle", id: "p1", index: 1, which: "control" });
assert.deepEqual(hitOf(tangents.what, { node: 0, point: [15, -5, 3] }, dmap), { kind: "handle", id: "p1", index: 0, which: "c1" });

// A3: the Move tool's box and handles round the selection's union bounds, above every piece
{
    assert.deepEqual(xformHandles([0, 0, 100, 50], 10).map((h) => [h.handle, h.at]), [
        ["nw", [0, 50]], ["n", [50, 50]], ["ne", [100, 50]], ["e", [100, 25]], ["se", [100, 0]], ["s", [50, 0]], ["sw", [0, 0]], ["w", [0, 25]], ["rot", [50, 60]]]);
    const multi = { kind: "pattern", id: "p1", ids: ["p1", "p2"] };
    assert.ok(!specs2d(state({ selection: multi })).some((s) => s.key.startsWith("xform/")), "no box without the Move tool");
    assert.ok(!specs2d(state({ selection: null, xform: true })).some((s) => s.key.startsWith("xform/")), "no box without a selection");
    const xs = specs2d(state({ selection: multi, xform: true, mmPerPx: 0.5 }));
    const top = bandOf(2).seam;
    const frame = xs.find((s) => s.key === "xform/box"), scale = xs.find((s) => s.key === "xform/scale"), rot = xs.find((s) => s.key === "xform/rot");
    assert.equal(frame.show, "lines"); assert.deepEqual(frame.what, { kind: "xformBox", id: "p1" });
    assert.deepEqual([...new Set(zOf(frame))], [top], "the frame above every piece's band");
    assert.equal(scale.show, "points"); assert.equal(scale.onTop, true);
    assert.deepEqual(Array.from(scale.data), [[0, 50], [150, 50], [300, 50], [300, 25], [300, 0], [150, 0], [0, 0], [0, 25]].flatMap((p) => [...p, top]), "the union [0, 0, 300, 50]");
    assert.deepEqual(Array.from(rot.data), [150, 50 + 28 * 0.5, top], "28 px above the top side");
    // the pick answers which handle; a press on the frame is the selection
    ["nw", "n", "ne", "e", "se", "s", "sw", "w"].forEach((h, k) => assert.deepEqual(hitOf(scale.what, { node: k }, dmap), { kind: "xform", id: "p1", handle: h }));
    assert.deepEqual(hitOf(rot.what, { node: 0 }, dmap), { kind: "xform", id: "p1", handle: "rot" });
    assert.equal(hitOf(rot.what, { node: 3 }, dmap), null);
    assert.deepEqual(hitOf(frame.what, { node: 0, point: [0, 10, top] }, dmap), { kind: "pattern", id: "p1" });
    // the edit points stand down under the Move tool (a rectangle's corners are the box's)
    assert.ok(!specs2d(state({ selection: { kind: "pattern", id: "p1" }, xform: true })).some((s) => s.key === "p1/points"));
    // no scale known: a 20 mm offset
    assert.deepEqual(Array.from(specs2d(state({ selection: { kind: "pattern", id: "p1" }, xform: true })).find((s) => s.key === "xform/rot").data).slice(0, 2), [50, 70]);
}
// an unfolded piece's fold (spec §6): a dashed guide, picked as its piece
{
    const specs = specs2d(state({ drawings: [drawing("p1", 0, { fold: [0, 0, 0, 50] })] }));
    const fold = specs.find((s) => s.key === "p1/fold");
    assert.deepEqual(Array.from(fold.data), [0, 0, bandOf(0).line, 0, 50, bandOf(0).line]);
    assert.ok(fold.dash);
    assert.deepEqual(hitOf(fold.what, { point: [0, 10, 0] }, new Map()), { kind: "pattern", id: "p1" });
    assert.ok(!specs2d(state()).some((s) => s.key.endsWith("/fold")));
}
console.log("scene2d: ok");
