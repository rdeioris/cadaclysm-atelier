// Place on avatar (spec §4): the frame from a known hit point and normal, an arm hit wrapping
// round that arm, the at: slot through slotFields, and the slot refresh after an outline edit
// keeping the piece on its avatar point. The normal lookup from the collider's triangles.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadKernel } from "./package.mjs";
import { Atelier } from "../kernel.js";
import { arrangedPoint, atFields, atSlot, parseAt, armAt, nearestTriangle, slotFields, sceneBox, PLACE_GAP, LAYER_GAP, AT_LABEL } from "../arrange.js";
import { avatarMesh } from "../drape.js";
import { translatePath } from "../drape.js";
import { fieldsFor } from "../props.js";
import * as m from "../model.js";

const near = (p, q, tol, what) => p.forEach((v, i) => assert.ok(Math.abs(v - q[i]) < tol, `${what}: ${p} vs ${q}`));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// ---- the frame from a known point and normal ----
const pb = [100, 50, 300, 250];             // a piece 200 x 200, centre (200, 150)
const hit = [40, 1200, 140], n = [0.6, 0, 0.8];
const f = atFields(hit, n, pb);
assert.equal(f.wrap, null);
near(cross(f.frame.x, f.frame.y), n, 1e-12, "the frame faces out along the normal");
near(f.frame.y, [0, 1, 0], 1e-12, "y is the world's up on the tangent plane");
near(arrangedPoint(f.frame, null, 200, 150), hit.map((v, i) => v + PLACE_GAP * n[i]), 1e-9, "the bounds centre over the hit, 30 mm out");
// a layer stands out one gap more
const f2 = atFields(hit, n, pb, { layer: 2 });
near(arrangedPoint(f2.frame, null, 200, 150), hit.map((v, i) => v + (PLACE_GAP + 2 * LAYER_GAP) * n[i]), 1e-9, "layer 2");
// a tilted normal: y is world up projected, still unit and in the tangent plane
const tilt = [0, 0.5, Math.sqrt(0.75)], ft = atFields(hit, tilt, pb);
assert.ok(Math.abs(dot(ft.frame.y, tilt)) < 1e-12 && ft.frame.y[1] > 0 && Math.abs(Math.hypot(...ft.frame.y) - 1) < 1e-12);
// near vertical (a shoulder's top): the camera's up instead
const fv = atFields(hit, [0, 1, 0], pb, { up: [0, 0, -1] });
near(fv.frame.y, [0, 0, -1], 1e-12, "the camera's up on a vertical normal");
near(cross(fv.frame.x, fv.frame.y), [0, 1, 0], 1e-12, "facing up");
console.log("ok - Place on avatar: the frame from a point and a normal (flat, layered, tilted, vertical)");

// ---- the slot string ----
const s = atSlot(hit, n);
assert.equal(s, "at:40,1200,140,0.6,0,0.8");
assert.deepEqual(parseAt(s), { point: hit, normal: n, wrap: true });
assert.equal(parseAt(atSlot(hit, n, false)).wrap, false);
assert.equal(parseAt("at:1,2,3"), null);
assert.equal(parseAt("front"), null);
const viaSlot = slotFields({ id: "p", meta: { atelier: { x: 1 } } }, s, [0, 0, 0, 1, 1, 1], pb);
assert.equal(viaSlot.meta.atelier.slot, s);
assert.equal(viaSlot.meta.atelier.x, 1, "the rest of the app's meta kept");
near(viaSlot.frame.origin, f.frame.origin, 1e-9, "slotFields reads the at: slot");
// a custom slot keeps the frame
const kept = slotFields({ id: "p", frame: f.frame, wrap: null, meta: {} }, "custom", [0, 0, 0, 1, 1, 1], pb);
assert.deepEqual(kept.frame, f.frame);
assert.equal(kept.meta.atelier.slot, "custom");
console.log("ok - the at: slot round-trips and slotFields places from it");

// ---- an arm hit wraps ----
const fM = JSON.parse(readFileSync(new URL("../assets/forms.json", import.meta.url), "utf8")).forms.find((x) => x.name === "f-M");
const arm = fM.arms.find((x) => x.side === "left");
const d = arm.dir.map((v) => v / Math.hypot(...arm.dir));
const side = cross(d, [0, 0, 1]).map((v, _, a) => v / Math.hypot(...a));
const armHit = arm.shoulder.map((v, i) => v + 250 * d[i] + 55 * side[i]);   // 250 mm down the arm, 55 mm off its axis
assert.equal(armAt(fM.arms, armHit).arm, arm);
const sleeveB = [0, 0, 400, 300];
const w = atFields(armHit, side, sleeveB, { landmarks: fM });
assert.ok(w.wrap, "an arm hit wraps");
near(w.wrap.origin, arm.shoulder, 1e-9, "round that arm's axis");
near(w.wrap.dir, d, 1e-9, "along the arm");
assert.equal(w.wrap.radius, arm.radius + 15);
// the piece's centre lands on the arm at the hit's side and height
const c = arrangedPoint(w.frame, w.wrap, 200, 150);
const rel = c.map((v, i) => v - arm.shoulder[i]);
assert.ok(Math.abs(dot(rel, d) - 250) < 1e-6, `the centre 250 mm down the arm (${dot(rel, d)})`);
const radial = rel.map((v, i) => v - d[i] * dot(rel, d));
assert.ok(Math.abs(Math.hypot(...radial) - (arm.radius + 15)) < 1e-6, "on the wrap's radius");
near(radial.map((v) => v / Math.hypot(...radial)), side, 1e-9, "on the side the hit was");
// Wrap off, or a hit too far from the axis: flat
assert.equal(atFields(armHit, side, sleeveB, { landmarks: fM, wrap: false }).wrap, null);
const far = arm.shoulder.map((v, i) => v + 250 * d[i] + 1.6 * arm.radius * side[i]);
assert.equal(atFields(far, side, sleeveB, { landmarks: fM }).wrap, null, "past 1.5 radii: flat");
assert.equal(armAt(fM.arms, arm.shoulder.map((v, i) => v + 20 * d[i] + 10 * side[i])), null, "the shoulder joint is the body's");
// the slot keeps "flat" through a refresh
assert.equal(slotFields({ id: "p", meta: {} }, atSlot(armHit, side, false), [0, 0, 0, 1, 1, 1], sleeveB, { landmarks: fM }).wrap, null);
assert.ok(slotFields({ id: "p", meta: {} }, atSlot(armHit, side), [0, 0, 0, 1, 1, 1], sleeveB, { landmarks: fM }).wrap);
console.log("ok - an arm hit wraps round that arm (its centre at the hit's height and side); Wrap off or far: flat");

// ---- the normal from the collider's triangles ----
const k = await loadKernel();
const sc = k.open(new Uint8Array(readFileSync(new URL("../assets/f-M.stp", import.meta.url))), "step", undefined, "native");
const collider = avatarMesh(sc.vertices(), sc.origin(), sc.indices());
const fMBounds = sceneBox(sc.vertices(), sc.origin());
sc.free();
// a point on a triangle's face: that triangle, its normal
const I = collider.indices, P = collider.positions, t = Math.floor(I.length / 3 / 2);
const corner = (j) => [0, 1, 2].map((a) => P[3 * I[3 * t + j] + a]);
const onTri = [0, 1, 2].map((a) => (corner(0)[a] + corner(1)[a] + corner(2)[a]) / 3);
const nt = nearestTriangle(P, I, onTri);
assert.ok(nt.distance < 1e-6, `on the surface (${nt.distance})`);
const tn = cross(corner(1).map((v, a) => v - corner(0)[a]), corner(2).map((v, a) => v - corner(0)[a]));
near(nt.normal, tn.map((v) => v / Math.hypot(...tn)), 1e-9, "the triangle's normal");
console.log(`ok - the collider lookup: the hit's triangle and its normal (${I.length / 3} triangles)`);

// ---- refresh after an outline edit keeps the piece on its avatar point ----
const a = new Atelier(k);
a.load(readFileSync(new URL("../assets/tshirt.json", import.meta.url), "utf8"));
a.setAvatar({ bounds: fMBounds, landmarks: fM });
const node = (label) => a.nodes().find((x) => x.label === label);
const boundsOf = (id) => a.drawings().find((x) => x.id === id).bounds;
const centre3d = (x) => { const b = boundsOf(x.id); return arrangedPoint(x.frame, x.wrap ?? null, (b[0] + b[2]) / 2, (b[1] + b[3]) / 2); };
const front = node("Front");
const at = atSlot([0, 1150, 150], [0, 0, 1]);
a.apply(m.setPattern(a.nodes(), front.id, slotFields(front, at, fMBounds, boundsOf(front.id), { landmarks: fM })), "place on avatar");
const placed = node("Front");
assert.equal(placed.meta.atelier.slot, at);
near(centre3d(placed), [0, 1150, 150 + PLACE_GAP], 1e-6, "placed: the centre 30 mm out from the point");
assert.equal(fieldsFor({ kind: "pattern", id: front.id }, a.nodes(), {}).find((x) => x.key === "slot").options.find((o) => o.value === at)?.label, AT_LABEL, "the Slot select shows it");
// a 2D move and an outline edit: re-centred on the point, in the edit's undo step
const outline = () => a.nodes().find((x) => x.id === `${front.id}_outline`).path;
a.apply(m.setOutline(a.nodes(), front.id, translatePath(outline(), [80, -30])), "move");
near(centre3d(node("Front")), [0, 1150, 150 + PLACE_GAP], 1e-6, "after a 2D move");
// the hem 100 mm lower: the bounds' centre moves 50 mm in 2D
const wide = JSON.parse(JSON.stringify(outline())), n0 = wide.segments.length;
wide.start = [wide.start[0], wide.start[1] - 100];
wide.segments[0].to = [wide.segments[0].to[0], wide.segments[0].to[1] - 100];
wide.segments[n0 - 1].to = [...wide.start];
const b0 = boundsOf(front.id);
a.apply(m.setOutline(a.nodes(), front.id, wide), "edit");
assert.ok(Math.abs(boundsOf(front.id)[1] - (b0[1] - 100)) < 1e-6, "the hem moved");
near(centre3d(node("Front")), [0, 1150, 150 + PLACE_GAP], 1e-6, "after an outline edit");
assert.equal(node("Front").meta.atelier.slot, at, "the slot kept");
assert.ok(a.undo());
near(centre3d(node("Front")), [0, 1150, 150 + PLACE_GAP], 1e-6, "undone");
console.log("ok - an at: slot refreshes after a 2D move and an outline edit: the piece stays on its avatar point");
