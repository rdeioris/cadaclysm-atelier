// The 3D gizmo's maths (gizmo.js, spec §3): an axis drag, a ring drag (facing the camera and
// edge on), the centre square, the Shift snaps, the slot made custom and the pieces "on" the
// moved one following it; a wrapped piece's wrap moving and turning with it.
import assert from "node:assert/strict";
import { gizmoDrag, gizmoOps, gizmoPivot, gizmoShapes, axisShift, ringAngle, rotation, moveRigid, ringHandle, frameAxes, SNAP_MM, SNAP_DEG, PARTS } from "../gizmo.js";
import { dragBasis } from "../drape.js";
import { arrangedPoint, onFrame } from "../arrange.js";
import { reslotOps } from "../reslot.js";

const near = (p, q, tol, what) => { assert.equal(p.length, q.length, what); p.forEach((v, i) => assert.ok(Math.abs(v - q[i]) < tol, `${what}: ${p} vs ${q}`)); };
const close = (a, b, tol, what) => assert.ok(Math.abs(a - b) < tol, `${what}: ${a} vs ${b}`);
const deg = Math.PI / 180;

// the View's orbit camera looking at the pivot from +z: right = +x, up = +y, forward = -z
const pivot = [0, 1200, 200];
const cam = { kind: "orbit", target: pivot, distance: 2000, yaw: 0, pitch: 0 };
const basis = dragBasis(cam, pivot, 800);
near(basis.right, [1, 0, 0], 1e-12, "right"); near(basis.up, [0, 1, 0], 1e-12, "up"); near(basis.forward, [0, 0, -1], 1e-12, "forward");
const pp = basis.perPixel;

// a front piece: its frame facing +z, its origin off its centre (as slotFrame puts it)
const frame = { origin: [-250, 900, 200], x: [1, 0, 0], y: [0, 1, 0] };
const start = { frame, wrap: null };
const piv = arrangedPoint(frame, null, 250, 300);

// ---- an axis drag ----
let r = gizmoDrag("tx", start, piv, { basis, grab: [40, 0], now: [140, 0] });
near(r.shift, [100 * pp, 0, 0], 1e-9, "X: 100 px right is 100 px of world x");
near(r.frame.origin, [frame.origin[0] + 100 * pp, frame.origin[1], frame.origin[2]], 1e-9, "X: the origin moves");
near(r.frame.x, frame.x, 1e-12, "X: the axes stay"); near(r.frame.y, frame.y, 1e-12, "X: the axes stay");
// a move across the axis's screen direction does nothing; Y follows the pointer up
r = gizmoDrag("tx", start, piv, { basis, grab: [40, 0], now: [40, -70] });
close(r.shift[0], 0, 1e-12, "X: a vertical move");
r = gizmoDrag("ty", start, piv, { basis, grab: [0, -40], now: [0, -90] });
near(r.shift, [0, 50 * pp, 0], 1e-9, "Y: 50 px up");
// Z points at the eye: no screen direction, no move
assert.equal(axisShift([0, 0, 1], basis, 30, 30), 0);
// a camera from the side (yaw 90 degrees): X runs into the screen, Z across it
const side = dragBasis({ ...cam, yaw: Math.PI / 2 }, pivot, 800);
close(axisShift([1, 0, 0], side, 100, 0), 0, 1e-9, "X edge on from the side");
close(Math.abs(axisShift([0, 0, 1], side, 100, 0)), 100 * side.perPixel, 1e-9, "Z across the side view");
console.log("ok - gizmo: an axis drag moves the frame along its world axis by the pointer's projection");

// ---- the centre square: the camera plane ----
r = gizmoDrag("plane", start, piv, { basis, grab: [0, 0], now: [30, 20] });
near(r.shift, [30 * pp, -20 * pp, 0], 1e-9, "the camera plane");
console.log("ok - gizmo: the centre square moves in the camera plane");

// ---- a ring drag ----
// the normal ring faces the camera: a quarter turn counter-clockwise on the screen is +90
// degrees about the normal (toward the eye), about the pivot
r = gizmoDrag("rn", start, piv, { basis, grab: [100, 0], now: [0, -100] });
close(r.angle, 90 * deg, 1e-12, "a quarter turn");
near(r.frame.x, [0, 1, 0], 1e-12, "x turned to y");
near(r.frame.y, [-1, 0, 0], 1e-12, "y turned to -x");
near(arrangedPoint(r.frame, null, 250, 300), piv, 1e-9, "about the pivot: the centre stays");
const R = rotation([0, 0, 1], 90 * deg);
near(r.frame.origin, [piv[0] - (frame.origin[1] - piv[1]), piv[1] + (frame.origin[0] - piv[0]), frame.origin[2]], 1e-9, "the origin turned about the pivot");
near([R[0][0], R[0][1], R[1][0]], [0, -1, 1], 1e-12, "Rodrigues");
// a piece seen from the back (its normal away from the eye): the same pointer turns it the other way
const back = { frame: { origin: [250, 900, -200], x: [-1, 0, 0], y: [0, 1, 0] }, wrap: null };
close(gizmoDrag("rn", back, piv, { basis, grab: [100, 0], now: [0, -100] }).angle, -90 * deg, 1e-12, "seen from behind");
// the x ring is edge on: the pointer along its tangent at the grabbed point (the front one)
const ringR = 120;
const a0 = Math.acos((20 * pp) / ringR);
const tangentPx = ringR * Math.sin(a0) / pp;
const edge = ringAngle([1, 0, 0], basis, [0, -20], [0, -40], ringR);
close(edge, -20 / tangentPx, 1e-2, "edge on: the tangent's share");
assert.ok(edge < 0, "a front point pulled up turns it back about +x");
r = gizmoDrag("rx", start, piv, { basis, grab: [0, -20], now: [0, -40], radius: ringR });
near(r.frame.x, [1, 0, 0], 1e-12, "x about x stays");
close(Math.hypot(...r.frame.y), 1, 1e-12, "y still unit");
close(r.frame.y[2], Math.sin(r.angle), 1e-12, "y tilts toward z");
console.log("ok - gizmo: a ring drag turns the frame about its axis through the pivot (facing and edge on)");

// ---- the snaps ----
r = gizmoDrag("tx", start, piv, { basis, grab: [0, 0], now: [13.7 / pp, 0], shift: true });
near(r.shift, [10, 0, 0], 1e-9, "Shift: 13.7 mm snaps to 10");
r = gizmoDrag("tx", start, piv, { basis, grab: [0, 0], now: [16 / pp, 0], shift: true });
near(r.shift, [20, 0, 0], 1e-9, "Shift: 16 mm snaps to 20");
r = gizmoDrag("plane", start, piv, { basis, grab: [0, 0], now: [24 / pp, -6 / pp], shift: true });
near(r.shift, [20, 10, 0], 1e-9, "Shift: the camera plane snaps each world axis");
const turn = (d) => [100 * Math.cos(d * deg), -100 * Math.sin(d * deg)];
r = gizmoDrag("rn", start, piv, { basis, grab: [100, 0], now: turn(37), shift: true });
close(r.angle, 2 * SNAP_DEG * deg, 1e-12, "Shift: 37 degrees snaps to 30");
r = gizmoDrag("rn", start, piv, { basis, grab: [100, 0], now: turn(-52), shift: true });
close(r.angle, -45 * deg, 1e-12, "Shift: -52 degrees snaps to -45");
assert.equal(SNAP_MM, 10);
console.log("ok - gizmo: Shift snaps translation to 10 mm and rotation to 15 degrees");

// ---- the ops: the slot custom, a piece on it following, keeping its offset ----
const nodes = [
    { id: "garment", kind: "garment", patterns: ["p1", "p2", "p3"] },
    { id: "p1", kind: "garment.pattern", frame, layer: 0, meta: { atelier: { slot: "front", note: 1 } } },
    { id: "p2", kind: "garment.pattern", frame: onFrame(frame, 1), layer: 1, meta: { atelier: { slot: "on:p1" } } },
    { id: "p3", kind: "garment.pattern", frame: onFrame(onFrame(frame, 1), 1), layer: 2, meta: { atelier: { slot: "on:p2" } } },
];
const drawings = new Map(["p1", "p2", "p3"].map((id) => [id, { bounds: [0, 0, 500, 600] }]));
const avatar = { bounds: [-500, 0, -200, 500, 1700, 200], landmarks: null };
r = gizmoDrag("rn", start, piv, { basis, grab: [100, 0], now: turn(30) });
const ops = gizmoOps(nodes, "p1", r, drawings, avatar);
const set = (id) => ops.filter((o) => o.id === id).map((o) => o.fields);
assert.equal(set("p1").length, 1);
assert.equal(set("p1")[0].meta.atelier.slot, "custom", "a gizmo move makes the slot custom");
assert.equal(set("p1")[0].meta.atelier.note, 1, "the rest of the meta kept");
near(set("p1")[0].frame.x, r.frame.x, 1e-12, "the moved frame");
const f2 = set("p2")[0]?.frame, f3 = set("p3")[0]?.frame;
assert.ok(f2 && f3, "the pieces on it (and on those) follow");
near(f2.origin, onFrame(r.frame, 1).origin, 1e-9, "p2 one layer out from the moved p1");
near(f2.x, r.frame.x, 1e-12, "p2 turned with it");
near(f3.origin, onFrame(r.frame, 2).origin, 1e-9, "p3 two layers out");
assert.equal(set("p2")[0].meta, undefined, "the followers keep their on: slots");
// a custom piece is not re-placed by a refresh, but brings its on: pieces when the caller moves it
const after = nodes.map((n) => (n.id === "p1" ? { ...n, frame: r.frame, meta: set("p1")[0].meta } : n));
assert.equal(reslotOps(after, drawings, avatar).ops.filter((o) => o.id === "p1").length, 0, "a refresh leaves a custom piece");
console.log("ok - gizmo: the ops make the slot custom; the pieces on it follow, keeping their layer offset");

// ---- a wrapped piece: the pivot on its axis, the wrap moving and turning with it ----
const wrap = { origin: [182, 1352, -8], dir: [0.667, -0.7408, 0.0797], radius: 65 };
const sleeveFrame = { origin: [300, 1200, 60], x: [0, 0, -1], y: wrap.dir.map((v) => -v / Math.hypot(...wrap.dir)) };
const sb = [0, 0, 300, 400];
const sp = gizmoPivot({ frame: sleeveFrame, wrap }, sb);
const d = wrap.dir.map((v) => v / Math.hypot(...wrap.dir));
const off = sp.map((v, i) => v - wrap.origin[i]), along = off[0] * d[0] + off[1] * d[1] + off[2] * d[2];
near(off, d.map((v) => v * along), 1e-9, "the pivot is on the wrap axis");
const ws = { frame: sleeveFrame, wrap };
r = gizmoDrag("ty", ws, sp, { basis, grab: [0, 0], now: [0, -50] });
near(r.wrap.origin, [wrap.origin[0], wrap.origin[1] + 50 * pp, wrap.origin[2]], 1e-9, "a translate moves the wrap axis");
near(r.wrap.dir, wrap.dir, 1e-12, "and keeps its direction");
assert.equal(r.wrap.radius, wrap.radius);
// a turn about the frame's y (the wrap axis): the axis stays, the sleeve spins round it
r = gizmoDrag("ry", ws, sp, { basis, grab: [0, -20], now: [10, -30], radius: 100 });
assert.ok(Math.abs(r.angle) > 1e-3, "it turned");
near(r.wrap.dir, wrap.dir, 1e-9, "the axis keeps its direction");
const w0 = r.wrap.origin.map((v, i) => v - wrap.origin[i]);
near(w0.map((v, i) => v - d[i] * (w0[0] * d[0] + w0[1] * d[1] + w0[2] * d[2])), [0, 0, 0], 1e-9, "and stays on its line");
// a turn about the normal tilts the axis with the piece (rigidly)
r = gizmoDrag("rn", ws, sp, { basis, grab: [100, 0], now: turn(20), radius: 100 });
const n = frameAxes(sleeveFrame).n, Rn = rotation(n, r.angle);
near(r.wrap.dir, [0, 1, 2].map((i) => Rn[i][0] * wrap.dir[0] + Rn[i][1] * wrap.dir[1] + Rn[i][2] * wrap.dir[2]), 1e-9, "the wrap turns with it");
const moved = moveRigid(sleeveFrame, wrap, sp, Rn, [0, 0, 0]);
near(arrangedPoint(moved.frame, moved.wrap, 150, 200), (() => {
    const q = arrangedPoint(sleeveFrame, wrap, 150, 200).map((v, i) => v - sp[i]);
    return [0, 1, 2].map((i) => sp[i] + Rn[i][0] * q[0] + Rn[i][1] * q[1] + Rn[i][2] * q[2]);
})(), 1e-6, "the arranged sleeve turns rigidly");
console.log("ok - gizmo: a wrapped piece turns about its wrap axis; a translate moves the axis, a tilt turns it");

// ---- the drawing: every part, the ring handles clear of the arrows ----
const shapes = gizmoShapes(piv, frame, 200);
for (const p of PARTS) assert.ok(shapes[p] && shapes.handles[p], `part ${p}`);
assert.equal(shapes.tx.length % 6, 0);
const pts = [[100, 0], [0, -100], [-100, 0], [0, 100], [71, -71], [10, 0]];
// arrows to the right and up: of the far points, the one down-left is clearest of both
const h = ringHandle(pts, [0, 0], [[0, 0, 150, 0], [0, 0, 0, -150]]);
assert.deepEqual(h, [-100, 0], `the handle away from the arrows: ${h}`);
console.log("ok - gizmo: shapes for every part; a ring's handle stays clear of the arrows");
