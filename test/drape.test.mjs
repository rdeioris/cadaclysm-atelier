// drape.js: the per-pattern split, nearest vertex, the drag plane from the View's camera, what
// an edit does to a live cloth, sewing's end, the health line and the step rate.
import assert from "node:assert/strict";
import { splitByPattern, gather, nearestVertex, dragBasis, dragTarget, garmentChange, sewingDone, healthOf, RateMeter, SEW_FRAMES, pathOffset, translatePath, frameOps } from "../drape.js";

const close = (a, b, eps = 1e-9) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < eps);

// split: two patterns, their own vertices, local indices in first-seen order
{
    const tris = Uint32Array.from([0, 1, 2, 3, 4, 5, 2, 1, 6]);
    const vp = Uint32Array.from([0, 0, 0, 1, 1, 1, 0]);
    const m = splitByPattern(tris, vp);
    assert.deepEqual([...m.keys()], [0, 1]);
    assert.deepEqual([...m.get(0).verts], [0, 1, 2, 6]);
    assert.deepEqual([...m.get(0).indices], [0, 1, 2, 2, 1, 3]);
    assert.deepEqual([...m.get(1).verts], [3, 4, 5]);
    assert.deepEqual([...m.get(1).indices], [0, 1, 2]);
    const pos = Float32Array.from({ length: 21 }, (_, i) => i);
    assert.deepEqual([...gather(pos, m.get(1).verts)], [9, 10, 11, 12, 13, 14, 15, 16, 17]);
}

// nearest: over all, and among a subset
{
    const pos = Float32Array.from([0, 0, 0, 10, 0, 0, 20, 0, 0]);
    assert.equal(nearestVertex(pos, [9, 1, 0]), 1);
    assert.equal(nearestVertex(pos, [9, 1, 0], Uint32Array.from([0, 2])), 0);
    assert.equal(nearestVertex(new Float32Array(0), [0, 0, 0]), -1);
}

// the camera: yaw 0, pitch 0 under y up looks down -z from +z; right +x, up +y
{
    const cam = { kind: "orbit", target: [0, 0, 0], distance: 1000, yaw: 0, pitch: 0, orthographic: false };
    const b = dragBasis(cam, [0, 0, 0], 800);
    assert.ok(close(b.right, [1, 0, 0]) && close(b.up, [0, 1, 0]), JSON.stringify(b));
    assert.ok(Math.abs(b.perPixel - (2 * 1000 * Math.tan(0.4)) / 800) < 1e-9);
    // a point 500 nearer the eye: half the depth, half the world per pixel
    assert.ok(Math.abs(dragBasis(cam, [0, 0, 500], 800).perPixel - b.perPixel / 2) < 1e-9);
    // 10 px right and 10 px down (screen y down)
    const t = dragTarget([1, 2, 3], b, 10, 10);
    assert.ok(close(t, [1 + 10 * b.perPixel, 2 - 10 * b.perPixel, 3]));
    // yaw a quarter turn: the eye goes round to +x (orbit offset (sy, -cy, 0) -> model (1, 0, 0))
    const q = dragBasis({ ...cam, yaw: Math.PI / 2 }, [0, 0, 0], 800);
    assert.ok(close(q.right, [0, 0, -1], 1e-12), JSON.stringify(q.right));
    // looking down (pitch up 90 degrees): screen up is world -z... at yaw 0 it is (0, 0, -1)
    const d = dragBasis({ ...cam, pitch: Math.PI / 2 }, [0, 0, 0], 800);
    assert.ok(close(d.up, [0, 0, -1], 1e-12), JSON.stringify(d.up));
    assert.equal(dragBasis({ kind: "fixed" }, [0, 0, 0], 800), null);
}

// garment changes
{
    const base = () => [
        { id: "f1", kind: "garment.fabric", label: "Jersey", stretch_warp: 1 },
        { id: "garment", kind: "garment.garment", patterns: ["p1", "p2"], seams: ["s1"] },
        { id: "p1_outline", kind: "profile.path", path: { start: [0, 0] } },
        { id: "p2_outline", kind: "profile.path", path: { start: [5, 0] } },
        { id: "p1", kind: "garment.pattern", outline: "p1_outline", fabric: "f1", label: "Front", grain: [0, 1], frame: "xy" },
        { id: "p2", kind: "garment.pattern", outline: "p2_outline", fabric: "f1", label: "Back", grain: [0, 1], frame: "xy" },
        { id: "s1", kind: "garment.seam", a: "p1", b: "p2", a_from: 0, a_to: 10, b_from: 0, b_to: 10, reversed: true },
    ];
    const edit = (fn) => { const n = base(); fn(new Map(n.map((x) => [x.id, x]))); return n; };
    assert.deepEqual(garmentChange(base(), base()), { kind: "same" });
    assert.deepEqual(garmentChange(base(), edit((m) => { m.get("p1").label = "F"; m.get("p1").frame = { origin: [1, 2, 3] }; m.get("f1").label = "J"; })), { kind: "same" });
    assert.deepEqual(garmentChange(base(), edit((m) => { m.get("p2_outline").path.start = [6, 0]; m.get("s1").b_from = 1; })), { kind: "remesh", patterns: ["p2"] });
    assert.deepEqual(garmentChange(base(), edit((m) => { m.get("p1").grain = [1, 0]; })), { kind: "remesh", patterns: ["p1"] });
    assert.deepEqual(garmentChange(base(), edit((m) => { m.get("p1").particle_distance = 10; })), { kind: "remesh", patterns: ["p1"] });
    assert.deepEqual(garmentChange(base(), edit((m) => { m.get("s1").a_to = 9; })).patterns.sort(), ["p1", "p2"]);
    assert.equal(garmentChange(base(), edit((m) => { m.get("f1").stretch_warp = 2; })).kind, "stale");
    assert.equal(garmentChange(base(), edit((m) => { m.get("p1").fabric = "f2"; })).kind, "stale");
    assert.equal(garmentChange(base(), base().filter((n) => n.id !== "s1")).kind, "stale");
    assert.equal(garmentChange(base(), [...base(), { id: "p3", kind: "garment.pattern" }]).kind, "stale");
}

// sewing ends when every pair is welded, at SEW_FRAMES, or at once with no seams
{
    const st = (frame, pairs, welded) => [frame, 100, 150, pairs, welded, 0, 0, 0];
    assert.equal(sewingDone(st(5, 40, 20)), false);
    assert.equal(sewingDone(st(5, 40, 40)), true);
    assert.equal(sewingDone(st(SEW_FRAMES, 40, 20)), true);
    assert.equal(sewingDone(st(0, 0, 0)), true);
}

// health
{
    const ok = healthOf([12, 900, 1600, 80, 60, 0, 0, 812.4], "sewing");
    assert.equal(ok.text, "frame 12 · sewing · seams 60/80 · 900 vertices · 1600 triangles · max 812 mm/s");
    assert.equal(ok.warn, false); assert.equal(ok.stop, false);
    const bad = healthOf([12, 900, 1600, 80, 60, 3, 1, 0], "draping");
    assert.ok(bad.text.endsWith("3 non-finite · 1 dropped"));
    assert.equal(bad.warn, true); assert.equal(bad.stop, true);
    assert.equal(healthOf([1, 1, 1, 0, 0, 0, 2, 0], "draping").stop, false);
    const wild = healthOf([40, 9, 9, 0, 0, 0, 0, 56703], "sewing");
    assert.ok(wild.text.endsWith("unstable") && wild.warn && wild.stop, JSON.stringify(wild));
    const fast = healthOf([40, 9, 9, 0, 0, 0, 0, 21858], "sewing");
    assert.ok(fast.text.endsWith("fast") && fast.warn && !fast.stop, JSON.stringify(fast));
}

// rate: four steps 300 ms apart are 3.33 fps
{
    const r = new RateMeter();
    assert.equal(r.fps, 0);
    for (let i = 0; i < 4; i++) r.add(1000 + 300 * i, 290);
    assert.ok(Math.abs(r.fps - 10 / 3) < 1e-9);
    assert.equal(r.ms, 290);
    r.add(10000, 100);   // the window drops the old marks
    assert.equal(r.marks.length, 2);
}
// a 2D move is told apart from a shape edit, and put back into the cloth's frame
{
    const path = { start: [0, 0], segments: [{ type: "line", to: [100, 0] }, { type: "bezier", c1: [110, 20], c2: [90, 40], to: [100, 50] }, { type: "line", to: [0, 0] }] };
    const moved = translatePath(path, [30, -5]);
    assert.deepEqual(moved.segments[1].c2, [120, 35]);
    assert.deepEqual(pathOffset(path, moved), [30, -5]);
    assert.deepEqual(pathOffset(path, path), [0, 0]);
    const edited = translatePath(path, [0, 0]); edited.segments[0].to = [101, 0];
    assert.equal(pathOffset(path, edited), null);
    assert.equal(pathOffset(path, { ...path, segments: path.segments.slice(1) }), null);

    const nodes = (p1) => [{ id: "p1", kind: "garment.pattern", outline: "p1_outline" }, { id: "p1_outline", kind: "profile.path", path: p1 }];
    const offsets = new Map();
    // moved: the outline is set back where it was meshed, the offset kept
    assert.deepEqual(frameOps(nodes(path), nodes(moved), offsets), [{ op: "set", id: "p1_outline", fields: { path } }]);
    assert.deepEqual(offsets.get("p1"), [30, -5]);
    // then a shape edit where it now stands: the edited outline moved back by the offset
    const movedEdit = translatePath(edited, [30, -5]);
    const [op] = frameOps(nodes(path), nodes(movedEdit), offsets);
    assert.ok(pathOffset(edited, op.fields.path).every((v) => Math.abs(v) < 1e-9));
    // moved back home: nothing to set, the offset gone
    assert.deepEqual(frameOps(nodes(path), nodes(path), offsets), []);
    assert.equal(offsets.size, 0);
    // the piece's internal lines and saved pins move with it (kernel.js transformedPiece): set back too
    const line = { kind: "fold", path: { start: [10, 10], segments: [{ type: "line", to: [60, 40] }] } };
    const withLines = (p1, d) => [{ id: "p1", kind: "garment.pattern", outline: "p1_outline", internal: [{ ...line, path: translatePath(line.path, d) }], pins: [[20 + d[0], 20 + d[1]]] },
        { id: "p1_outline", kind: "profile.path", path: p1 }];
    const ops = frameOps(withLines(path, [0, 0]), withLines(moved, [30, -5]), offsets);
    assert.deepEqual(ops[1], { op: "set", id: "p1", fields: { internal: [line], pins: [[20, 20]] } });
    // a tack's end on the moved piece goes back with it; its end on an unmoved piece stays
    offsets.clear();
    const tack = (d) => ({ id: "t1", kind: "garment.tack", a: "p1", a_at: [20 + d[0], 30 + d[1]], b: "p2", b_at: [300, 40] });
    const tops = frameOps([...nodes(path), tack([0, 0])], [...nodes(moved), tack([30, -5])], offsets);
    assert.deepEqual(tops.at(-1), { op: "set", id: "t1", fields: { a_at: [20, 30] } });
}
console.log("drape: ok");
