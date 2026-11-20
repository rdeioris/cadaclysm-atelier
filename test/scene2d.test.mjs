// The 2D scene against a fake viewer: what each piece shows, that an unchanged scene shows
// nothing again, that a moved piece is updated in place, that the item map answers picks.
import assert from "node:assert/strict";
import { specs2d, Items2d, Overlay2d, fillColour, LAYER_2D } from "../scene2d.js";

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
    notches: [[x + 50, 0, 0]], internal: [], holes: [], grain: [x + 50, 10, x + 50, 40], bounds: [x, 0, x + 100, 50],
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
for (const k of ["p1/fill", "p1/sew", "p1/cut", "p1/notches", "p1/grain", "p1/grainhead", "p1/label", "seam/s1/a", "seam/s1/b", "seam/s1/no"]) assert.ok(keys.includes(k), `${k} in ${keys}`);
assert.ok(!keys.includes("p1/points"), "handles only on the selected piece");
const sew = specs.find((s) => s.key === "p1/sew");
assert.equal(sew.show, "curves"); assert.deepEqual(sew.what, { kind: "sew", id: "p1" });
assert.deepEqual(Array.from(sew.snapPoints), [50, 0, 0]); assert.equal(sew.snapLabel, "notch");
assert.deepEqual(specs.find((s) => s.key === "p1/cut").dash, { dash: 4, gap: 4 });
assert.deepEqual(specs.find((s) => s.key === "seam/s1/b").what, { kind: "seam", id: "s1", pattern: "p2" });
assert.equal(specs.find((s) => s.key === "p1/fill").colour, fillColour("#5aa0d9"));
const sel = specs2d(state({ selection: { kind: "pattern", id: "p1" }, pointSel: [2] }));
const pts = sel.find((s) => s.key === "p1/points");
assert.deepEqual(Array.from(pts.data), [0, 0, 0, 100, 0, 0, 100, 50, 0, 0, 50, 0]);
assert.deepEqual(pts.states, [0, 0, 2, 0], "point 2 selected");
assert.equal(pts.onTop, true);

// apply: everything once on layer 1, nothing again for the same scene
const v = fakeViewer(), items = new Items2d(v);
items.apply(specs);
const shows = v.calls.filter((c) => c[0].startsWith("show")).length;
assert.equal(shows, specs.length);
assert.ok(v.calls.filter((c) => c[0] === "setItemLayer").every((c) => c[2] === LAYER_2D));
v.calls.length = 0;
items.apply(specs2d(state()));
assert.deepEqual(v.calls, [], "an unchanged scene calls nothing");
// hover recolours in place
items.apply(specs2d(state({ hover: "p1" })));
assert.ok(v.calls.length >= 1 && v.calls.every((c) => c[0] === "setColour"), "the sew line and the notches recoloured, nothing shown again");
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
items.apply(specs2d(state({ drawings: [drawing("p2", 200)], seams: [] })));
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
console.log("scene2d: ok");
