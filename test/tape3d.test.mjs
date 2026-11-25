// tape3d.js: lengths and segments of a tape, the label's place; the Tape tool's state (Path:
// points, a double click or Enter ends, Escape drops; Girth: one click; the Hull box per target,
// re-measuring the last girth; Clear); the worker's measures drawn on a fake View (lines on top
// and a label, replaced and removed); and the kernel's girth on sized dress forms at their waist
// landmark, within 3 % of the waist in tools/dressform.py's size chart.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadKernel } from "./package.mjs";
import { avatarMesh } from "../drape.js";
import { tapeLength, segmentsOf, labelPoint, cmText, TapeTool, TapeMeasures, TAPE_COLOUR, UP } from "../tape3d.js";

// ---- the pure parts ---------------------------------------------------------------------------
const square = [0, 0, 0, 10, 0, 0, 10, 0, 10, 0, 0, 10];
assert.equal(tapeLength(square), 30);
assert.equal(tapeLength(square, true), 40, "closed: back to the first");
assert.equal(tapeLength([1, 2, 3]), 0);
assert.equal(cmText(742.46), "74.2 cm");
assert.equal(cmText(5), "0.5 cm");
assert.deepEqual(Array.from(segmentsOf(square)), [0, 0, 0, 10, 0, 0, 10, 0, 0, 10, 0, 10, 10, 0, 10, 0, 0, 10]);
assert.equal(segmentsOf(square, true).length, 24);
assert.deepEqual(Array.from(segmentsOf(square, true).slice(18)), [0, 0, 10, 0, 0, 0]);
assert.deepEqual(labelPoint(square, false), [10, 0, 5], "a path's label halfway along it");
assert.deepEqual(labelPoint(square, true, [1, 0, 9]), [0, 0, 10], "a girth's at the loop point nearest the click");
assert.deepEqual(UP, [0, 1, 0]);

// ---- the tool's state ---------------------------------------------------------------------------
{
    const t = new TapeTool();
    assert.equal(t.on, false);
    t.toggle();
    assert.equal(t.on, true);
    assert.equal(t.mode, "path");
    assert.equal(t.hullOn, true, "the avatar's hull on by default");
    // nothing hit
    const miss = t.click(null, null);
    assert.equal(miss.error, true); assert.deepEqual(miss.post, []);
    // a path: the first point says what next, the second measures
    assert.equal(t.press(0, [100, 100]), "pick");
    assert.deepEqual(t.click("cloth", [0, 0, 0]).post, []);
    assert.equal(t.press(1000, [200, 100]), "pick");
    const two = t.click("cloth", [10, 0, 0]);
    assert.deepEqual(two.post, [{ kind: "tape", op: "path", id: 1, target: "cloth", points: [0, 0, 0, 10, 0, 0] }]);
    // a point on the other target is refused
    t.press(2000, [300, 100]);
    assert.equal(t.click("avatar", [5, 5, 5]).error, true);
    assert.equal(t.current.points.length, 2);
    // the second click of a double click ends it, with no new point
    assert.equal(t.press(3000, [400, 100]), "pick");
    t.click("cloth", [20, 0, 0]);
    assert.equal(t.press(3200, [401, 100]), "end", "a double click");
    t.end();
    assert.equal(t.current, null);
    assert.deepEqual(t.ids, [1]);
    // Escape drops the path being drawn (its drawing too)
    t.click("cloth", [0, 0, 0]);
    t.click("cloth", [0, 5, 0]);
    assert.deepEqual(t.escape().post, [{ kind: "tape", op: "remove", id: 2 }]);
    assert.equal(t.escape(), null, "nothing being drawn");
    // a single point is dropped by Enter
    t.click("avatar", [0, 0, 0]);
    t.end();
    assert.deepEqual(t.ids, [1]);
    // girth: one click, the hull per target
    t.setMode("girth");
    assert.deepEqual(t.click("avatar", [0, 1060, 120]).post, [{ kind: "tape", op: "girth", id: 4, target: "avatar", point: [0, 1060, 120], hull: true }]);
    assert.deepEqual(t.click("cloth", [0, 1000, 150]).post, [{ kind: "tape", op: "girth", id: 5, target: "cloth", point: [0, 1000, 150], hull: false }], "the garment's: the actual loop");
    assert.equal(t.hullOn, false, "the Hull box shows the garment's choice");
    // the Hull box re-measures the last girth, and is remembered for its target
    assert.deepEqual(t.setHull(true).post, [{ kind: "tape", op: "girth", id: 5, target: "cloth", point: [0, 1000, 150], hull: true }]);
    assert.equal(t.hull.cloth, true); assert.equal(t.hull.avatar, true);
    assert.equal(t.click("cloth", [0, 900, 150]).post[0].hull, true);
    // a double click in girth mode is two girths, never "end"
    t.press(9000, [10, 10]);
    assert.equal(t.press(9100, [10, 10]), "pick");
    assert.deepEqual(t.ids, [1, 4, 5, 6]);
    assert.deepEqual(t.clear().post, [{ kind: "tape", op: "clear" }]);
    assert.deepEqual(t.ids, []);
    assert.deepEqual(t.setHull(false).post, [], "no girth to re-measure");
    // switching the mode keeps a path being drawn
    t.setMode("path");
    t.click("avatar", [0, 0, 0]); t.click("avatar", [1, 0, 0]);
    t.setMode("girth");
    assert.equal(t.current, null); assert.deepEqual(t.ids, [7]);
    t.toggle();
    assert.equal(t.on, false);
}

// ---- the worker's measures on the real kernel, a fake View --------------------------------------
const k = await loadKernel();
class FakeView {
    constructor() { this.calls = []; this.next = 1; }
    named(n) { return this.calls.filter((c) => c[0] === n); }
    showLines(seg, colour) { this.calls.push(["showLines", seg, colour]); return this.next++; }
    showText(text, opts) { this.calls.push(["showText", text, opts]); return this.next++; }
    setOnTop(id, on) { this.calls.push(["setOnTop", id, on]); return true; }
    remove(id) { this.calls.push(["remove", id]); }
}
{
    const view = new FakeView();
    const tapes = new TapeMeasures(view, k);
    // a 100 mm cube: its mid-height girth is the square, 400 mm
    const cube = { positions: [0, 0, 0, 100, 0, 0, 100, 100, 0, 0, 100, 0, 0, 0, 100, 100, 0, 100, 100, 100, 100, 0, 100, 100], indices: [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7] };
    const len = tapes.measure({ op: "girth", id: 1, point: [50, 50, 50], hull: true }, cube);
    assert.ok(Math.abs(len - 400) < 1e-6, `the cube's girth: ${len}`);
    assert.deepEqual(view.named("setOnTop"), [["setOnTop", 1, true]], "the tape on top");
    assert.equal(view.named("showLines")[0][2], TAPE_COLOUR);
    assert.equal(view.named("showLines")[0][1].length % 6, 0);
    assert.equal(view.named("showText")[0][1], "40.0 cm");
    assert.equal(view.named("showText")[0][2].onTop, true);
    assert.equal(tapes.owns(1), true); assert.equal(tapes.owns(2), true); assert.equal(tapes.owns(3), false);
    // measured again (the Hull box): the old drawing goes first
    tapes.measure({ op: "girth", id: 1, point: [50, 50, 50], hull: false }, cube);
    assert.deepEqual(view.named("remove").map((c) => c[1]), [1, 2]);
    // a path across the top
    const path = tapes.measure({ op: "path", id: 2, points: [10, 100, 50, 90, 100, 50] }, cube);
    assert.ok(Math.abs(path - 80) < 1e-6, `a straight path: ${path}`);
    assert.equal(tapes.shown.size, 2);
    tapes.remove(2);
    assert.equal(tapes.shown.size, 1);
    tapes.clear();
    assert.equal(tapes.shown.size, 0);
    assert.throws(() => tapes.measure({ op: "girth", id: 3, point: [50, 500, 50], hull: false }, cube), /cloth_tape_girth/);
    assert.equal(tapes.shown.size, 0, "a refusal draws nothing");
}

// ---- the kernel's girth on sized dress forms, at their waist landmark ------------------------------
// tools/dressform.py: the female chart's waist (cm), the waist section's base height (mm), its
// grading about THIGH_CUT by the size's height over M's.
const WAIST = { "f-S": 68, "f-M": 74, "f-L": 82 }, HEIGHT = { "f-S": 164, "f-M": 168, "f-L": 171 };
const WAIST_Y = 1060, THIGH_CUT = 640;
for (const name of ["f-M", "f-L"]) {
    const scene = k.open(new Uint8Array(readFileSync(new URL(`../assets/${name}.stp`, import.meta.url))), "step", undefined, "native");
    const mesh = avatarMesh(scene.vertices(), scene.origin(), scene.indices());
    scene.free();
    const y = THIGH_CUT + (WAIST_Y - THIGH_CUT) * (HEIGHT[name] / HEIGHT["f-M"]);
    const tapes = new TapeMeasures(new FakeView(), k);
    for (const hull of [true, false]) {
        // a click in front of the waist: the loop through the torso, not an arm's
        const mm = tapes.measure({ op: "girth", id: 1, point: [0, y, 300], hull }, mesh);
        const err = Math.abs(mm / 10 - WAIST[name]) / WAIST[name];
        console.log(`  ${name} waist at y ${y.toFixed(1)}${hull ? " (hull)" : ""}: ${cmText(mm)}, chart ${WAIST[name]} cm, ${(err * 100).toFixed(2)} %`);
        assert.ok(err < 0.03, `${name}'s waist girth ${mm} mm against the chart's ${WAIST[name]} cm`);
    }
}
console.log("tape3d: ok");
