// prints.js: the atlas (a print's pixels land where its placement says, turned with it, later
// prints on top, alpha laid over), the decal UVs, the ops (the slot kept, the last print naming
// an image taking the image with it), the corners and hits, the 2D specs and the Print tool.
import assert from "node:assert/strict";
import {
    composeAtlas, atlasPxPerMm, printUvs, pieceBounds, printOps, printCorners, onPrint, printSize, nextPrintId, printSpecs, printTool, sizeText, startOf, PRINT_WIDTH,
} from "../prints.js";
import { makeTool } from "../tools.js";
import { specs2d, Items2d } from "../scene2d.js";

const near = (a, b, msg, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${msg}: ${a} vs ${b}`);
// A w x h image filled by `fill(x, y)` -> [r, g, b, a] (rows top first)
function image(w, h, fill) {
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.set(fill(x, y), 4 * (y * w + x));
    return { rgba, width: w, height: h };
}
const px = (a, i, j) => Array.from(a.rgba.subarray(4 * (j * a.width + i), 4 * (j * a.width + i) + 4));
const RED = [255, 0, 0, 255], BLUE = [0, 0, 255, 255], CLEAR = [0, 0, 0, 0];

// ---- the atlas --------------------------------------------------------------------------------
{
    const bounds = [0, 0, 100, 100];
    assert.equal(atlasPxPerMm(bounds), 2);
    near(atlasPxPerMm([0, 0, 1000, 300]), 1.024, "a big piece: 1024 px a side");
    const images = new Map([["red", image(10, 10, () => RED)]]);
    // a 10 x 10 mm red square at (20, 30): x 15..25 -> columns 30..49; y 25..35 -> rows (100 - 35) * 2 = 130..149
    const a = composeAtlas(bounds, [{ id: "pr1", image: "red", at: [20, 30], rotation_deg: 0, width_mm: 10 }], images);
    assert.deepEqual([a.width, a.height, a.pxPerMm], [200, 200, 2]);
    for (const [i, j] of [[30, 130], [49, 149], [40, 140], [30, 149], [49, 130]]) assert.deepEqual(px(a, i, j), RED, `inside ${i},${j}`);
    for (const [i, j] of [[29, 140], [50, 140], [40, 129], [40, 150], [0, 0]]) assert.deepEqual(px(a, i, j), CLEAR, `outside ${i},${j}`);
    // bounds not at the origin: the same print 10 mm right of x0 = 10
    const b = composeAtlas([10, 0, 110, 100], [{ id: "pr1", image: "red", at: [20, 30], width_mm: 10 }], images);
    assert.deepEqual(px(b, 10, 140), RED); assert.deepEqual(px(b, 9, 140), CLEAR); assert.deepEqual(px(b, 29, 140), RED); assert.deepEqual(px(b, 30, 140), CLEAR);

    // a 2:1 image, red left half and blue right half, 20 mm wide (10 tall) at (50, 50)
    const halves = new Map([["lr", image(20, 10, (x) => (x < 10 ? RED : BLUE))]]);
    const flat = composeAtlas(bounds, [{ id: "pr1", image: "lr", at: [50, 50], rotation_deg: 0, width_mm: 20 }], halves);
    assert.deepEqual(px(flat, 85, 100), RED, "unturned: red on the left"); assert.deepEqual(px(flat, 115, 100), BLUE, "blue on the right");
    assert.deepEqual(px(flat, 100, 85), CLEAR, "10 mm tall: nothing 7.5 mm above");
    // turned 90 degrees counter-clockwise: 10 wide, 20 tall, its right (blue) now up (small rows)
    const turned = composeAtlas(bounds, [{ id: "pr1", image: "lr", at: [50, 50], rotation_deg: 90, width_mm: 20 }], halves);
    assert.deepEqual(px(turned, 100, 85), BLUE, "turned: blue on top"); assert.deepEqual(px(turned, 100, 115), RED, "red below");
    assert.deepEqual(px(turned, 85, 100), CLEAR, "turned: 10 mm wide");

    // two overlapping prints: the later one on top
    const two = new Map([["red", image(4, 4, () => RED)], ["blue", image(4, 4, () => BLUE)]]);
    const over = composeAtlas(bounds, [{ id: "a", image: "blue", at: [50, 50], width_mm: 20 }, { id: "b", image: "red", at: [55, 50], width_mm: 20 }], two);
    assert.deepEqual(px(over, 105, 100), RED, "the later print on top");
    assert.deepEqual(px(over, 85, 100), BLUE, "the earlier where the later is not");
    const under = composeAtlas(bounds, [{ id: "b", image: "red", at: [55, 50], width_mm: 20 }, { id: "a", image: "blue", at: [50, 50], width_mm: 20 }], two);
    assert.deepEqual(px(under, 105, 100), BLUE, "order is the list's");
    // 50 % alpha red over opaque blue: half and half, opaque
    const half = new Map([["blue", image(4, 4, () => BLUE)], ["red50", image(4, 4, () => [255, 0, 0, 128])]]);
    const mixed = px(composeAtlas(bounds, [{ id: "a", image: "blue", at: [50, 50], width_mm: 20 }, { id: "b", image: "red50", at: [50, 50], width_mm: 20 }], half), 100, 100);
    assert.ok(Math.abs(mixed[0] - 128) <= 1 && mixed[1] === 0 && Math.abs(mixed[2] - 127) <= 1 && mixed[3] === 255, `over: ${mixed}`);
    // 50 % alone over nothing: its own colour, its alpha
    assert.deepEqual(px(composeAtlas(bounds, [{ id: "b", image: "red50", at: [50, 50], width_mm: 20 }], half), 100, 100), [255, 0, 0, 128]);
    // an image not decoded: that print is left out
    assert.deepEqual(px(composeAtlas(bounds, [{ id: "x", image: "missing", at: [50, 50], width_mm: 20 }], half), 100, 100), CLEAR);
}

// ---- the decal UVs ---------------------------------------------------------------------------------
{
    // piece 0 starts at (100, 200), piece 1 has no prints; links absolute, bounds from them
    const vertexPatterns = Uint32Array.from([0, 0, 0, 1]);
    const starts = Float64Array.from([100, 200, 0, 0]);
    const links = Float64Array.from([100, 200, 200, 300, 120, 230, 5, 5]);
    const bounds = pieceBounds(links, vertexPatterns, starts, 2);
    assert.deepEqual(bounds, [[0, 0, 100, 100], [5, 5, 5, 5]]);
    const uv = printUvs(links, vertexPatterns, starts, [bounds[0], null]);
    // the vertex at local (20, 30) is a print's centre there: u 0.2, v 0.7, the centre pixel of
    // the 200 x 200 atlas the print landed on (column 40, row 140)
    near(uv[4], 0.2, "u", 1e-6); near(uv[5], 0.7, "v", 1e-6);
    const a = composeAtlas(bounds[0], [{ id: "pr1", image: "red", at: [20, 30], width_mm: 10 }], new Map([["red", image(2, 2, () => RED)]]));
    assert.deepEqual(px(a, Math.floor(uv[4] * a.width), Math.floor(uv[5] * a.height)), RED, "the decal UV of the print's centre is on the print");
    assert.deepEqual([uv[0], uv[1], uv[2], uv[3]], [0, 1, 1, 0], "the bounds' corners: top-left is (0, 0)");
    assert.deepEqual([uv[6], uv[7]], [0, 0], "a piece without prints");
}

// ---- nodes ------------------------------------------------------------------------------------------
const nodes = [
    { id: "p1_outline", kind: "profile.path", path: { start: [100, 200], segments: [{ type: "line", to: [300, 200] }, { type: "line", to: [300, 500] }, { type: "line", to: [100, 200] }] } },
    { id: "p1", kind: "garment.pattern", label: "Front", outline: "p1_outline", fabric: "f", layer: 0, meta: { atelier: { slot: "front", prints: [{ id: "pr1", image: "aaaa", at: [50, 100], rotation_deg: 0, width_mm: 40 }] } } },
    { id: "p2_outline", kind: "profile.path", path: { start: [400, 0], segments: [{ type: "line", to: [500, 0] }, { type: "line", to: [500, 100] }, { type: "line", to: [400, 0] }] } },
    { id: "p2", kind: "garment.pattern", label: "Back", outline: "p2_outline", fabric: "f", layer: 0 },
    { id: "f", kind: "garment.fabric", meta: { atelier: { material: { weave: null, maps: { diffuse: "bbbb" } } } } },
    { id: "garment", kind: "garment.garment", patterns: ["p1", "p2"], seams: [] },
];
{
    assert.deepEqual(startOf(nodes, "p1"), [100, 200]);
    assert.equal(nextPrintId(nodes), "pr2");
    // printOps keeps the slot
    const add = printOps(nodes, "p2", [{ id: "pr2", image: "aaaa", at: [1, 2], width_mm: 30 }]);
    assert.equal(add.length, 1);
    assert.deepEqual(add[0].fields.meta.atelier.prints, [{ id: "pr2", image: "aaaa", at: [1, 2], rotation_deg: 0, width_mm: 30 }]);
    const keep = printOps(nodes, "p1", [{ id: "pr1", image: "aaaa", at: [0, 0], rotation_deg: 10, width_mm: 40 }]);
    assert.equal(keep[0].fields.meta.atelier.slot, "front", "the slot kept");
    // removing the last print naming an image removes the image (one batch)
    const gone = printOps(nodes, "p1", []);
    assert.deepEqual(gone[0].fields.meta.atelier, { slot: "front" }, "an empty list drops the key");
    assert.deepEqual(gone.slice(1), [{ op: "meta", app: "atelier.image.aaaa", value: null }]);
    // ... unless another print still names it
    const both = nodes.map((n) => (n.id === "p2" ? { ...n, meta: { atelier: { prints: [{ id: "pr9", image: "aaaa", at: [0, 0], width_mm: 5 }] } } } : n));
    assert.equal(printOps(both, "p1", []).length, 1);
    assert.throws(() => printOps(nodes, "f", []), /no piece/);

    // corners and hits: a 40 x 20 mm print (2:1 image) at start + (50, 100) = (150, 300)
    const img = { width: 200, height: 100 };
    const p = { id: "pr1", image: "aaaa", at: [50, 100], rotation_deg: 0, width_mm: 40 };
    assert.deepEqual(printSize(p, img), [40, 20]);
    assert.deepEqual(printSize(p, null), [40, 40], "unknown: square");
    assert.deepEqual(printCorners(p, [100, 200], img), [[130, 290], [170, 290], [170, 310], [130, 310]]);
    const r = printCorners({ ...p, rotation_deg: 90 }, [100, 200], img).map((q) => q.map((v) => Math.round(v * 1e9) / 1e9 + 0));
    assert.deepEqual(r, [[160, 280], [160, 320], [140, 320], [140, 280]], "turned 90: bottom-left now bottom-right of the box");
    assert.ok(onPrint([165, 305], p, [100, 200], img)); assert.ok(!onPrint([165, 315], p, [100, 200], img));
    assert.ok(onPrint([145, 315], { ...p, rotation_deg: 90 }, [100, 200], img), "turned: taller");
    assert.equal(sizeText(p, img), "40.0 × 20.0 mm");

    // the 2D specs: an image between the fill and the lines, and its size label
    const bitmap = { rgba: new Uint8Array(200 * 100 * 4), width: 200, height: 100 };
    const specs = printSpecs({ id: "p1" }, nodes, (id) => (id === "aaaa" ? bitmap : null), { fill: 10, line: 11, seam: 12 });
    assert.deepEqual(specs.map((s) => [s.key, s.show]), [["p1/print/pr1", "image"], ["p1/print/pr1/size", "text"]]);
    assert.deepEqual(specs[0].corners[0], [130, 290, 10.5]);
    assert.equal(specs[0].bitmap.width, 200);
    assert.equal(specs[1].text, "40.0 × 20.0 mm");
    assert.deepEqual(specs[0].what, { kind: "fill", id: "p1" }, "a pick on a print reads as its piece");
    assert.deepEqual(printSpecs({ id: "p1" }, nodes, () => null, { fill: 10, line: 11 }), [], "not decoded yet: waits");
    // through specs2d's hook, and the View's showImage
    const drawing = { id: "p1", fabric: "f", layer: 0, sig: "s", beziers: [0, 0, 0, 1, 10, 0, 0, 1], bounds: [100, 200, 300, 500] };
    const all = specs2d({ drawings: [drawing], nodes, prints: (d, z) => printSpecs(d, nodes, () => bitmap, z) });
    assert.ok(all.some((s) => s.key === "p1/print/pr1" && s.corners[0][2] === 10.5), "the image in the piece's band");
    const calls = [];
    const fake = new Proxy({}, { get: (_, name) => (...args) => { calls.push([name, ...args]); return calls.length; } });
    new Items2d(fake).apply(all.filter((s) => s.key.startsWith("p1/print")));
    const shown = calls.find((c) => c[0] === "showImage");
    assert.deepEqual(shown[1].corners, specs[0].corners);
    assert.equal(shown[1].bitmap.rgba, bitmap.rgba);
    assert.ok(calls.some((c) => c[0] === "setItemLayer" && c[1] === 1 && c[2] === 1), "on the 2D layer");
}

// ---- the Print tool -------------------------------------------------------------------------------
{
    const images = { aaaa: { name: "logo.png", width: 200, height: 100 } };
    const keep = {};
    const ctx = { nodes, images, keep, pxToWorld: 0.5 };
    assert.equal(typeof makeTool("print", ctx).down, "function", "tools.js has it");
    // no image picked, a click off every print: says what to do
    let t = printTool(ctx);
    let r = t.down([450, 50], { kind: "pattern", id: "p2" });
    assert.match(r.status, /pick an image/);
    assert.equal(r.ops, undefined);
    // an image picked: a click on p2 places it there, 100 mm wide, centred; the image stored with it
    const op = { op: "meta", app: "atelier.image.cccc", value: { name: "new.png" } };
    keep.printNext = { id: "cccc", op, name: "new.png", width: 50, height: 50 };
    r = t.down([450, 50], { kind: "pattern", id: "p2" });
    assert.deepEqual(r.ops[0], op, "a new image is stored in the same batch");
    assert.deepEqual(r.ops[1].fields.meta.atelier.prints, [{ id: "pr2", image: "cccc", at: [50, 50], rotation_deg: 0, width_mm: PRINT_WIDTH }]);
    assert.equal(keep.printNext, null, "placed once");
    assert.deepEqual(keep.print, { pattern: "p2", id: "pr2" });
    // an image the document has already: not stored again
    keep.printNext = { id: "aaaa", op: { op: "meta", app: "atelier.image.aaaa", value: {} }, width: 200, height: 100 };
    r = printTool(ctx).down([450, 50], { kind: "pattern", id: "p2" });
    assert.equal(r.ops.length, 1);
    keep.printNext = null;

    // a drag on p1's print moves it: previews, then the release's preview and commit
    t = printTool(ctx);
    r = t.down([150, 300], { kind: "pattern", id: "p1" });
    assert.deepEqual(keep.print, { pattern: "p1", id: "pr1" });
    assert.equal(r.overlay.points.length, 5, "four corners and the rotate handle");
    r = t.move([160, 310]);
    assert.deepEqual(r.preview[0].fields.meta.atelier.prints[0].at, [60, 110]);
    assert.ok(r.preview.every((o) => o.op === "set"), "a preview never drops an image");
    r = t.up([170, 300]);
    assert.equal(r.endPreview, true);
    assert.deepEqual(r.preview[0].fields.meta.atelier.prints[0].at, [70, 100]);
    assert.equal(r.preview[0].fields.meta.atelier.slot, "front");
    // a click without a move commits nothing
    t = printTool(ctx);
    t.down([150, 300]);
    assert.deepEqual(t.up([150, 300]), {});
    // the corner handle scales about the centre, the aspect kept: twice as far, twice as wide
    t = printTool(ctx);
    r = t.down([170, 310]);                                       // the top-right corner (within 4 mm)
    t.move([180, 315]);
    r = t.up([190, 320]);
    near(r.preview[0].fields.meta.atelier.prints[0].width_mm, 80, "scaled x2");
    assert.deepEqual(r.preview[0].fields.meta.atelier.prints[0].at, [50, 100], "about its centre");
    // the rotate handle, 28 px x 0.5 mm above the top side's middle: a quarter turn
    t = printTool(ctx);
    t.down([150, 324]);
    t.move([140, 310]);
    r = t.up([136, 300]);
    near(r.preview[0].fields.meta.atelier.prints[0].rotation_deg, 90, "a quarter turn");
    t = printTool(ctx);
    t.down([150, 324]);
    t.move([145, 320]);
    r = t.up([140, 318], null, { shift: true });
    near(r.preview[0].fields.meta.atelier.prints[0].rotation_deg, 30, "15 degree steps with Shift");
    // Delete removes the selected print, and the image with it
    r = printTool(ctx).key("Delete");
    assert.deepEqual(r.ops.slice(1), [{ op: "meta", app: "atelier.image.aaaa", value: null }]);
    assert.equal(r.ops[0].fields.meta.atelier.prints, undefined);
    assert.equal(keep.print, null);
    assert.deepEqual(printTool(ctx).key("Delete"), {}, "nothing selected");
    assert.equal(printTool(ctx).key("Escape").done, true);
}
console.log("prints: ok");
