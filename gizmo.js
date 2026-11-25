// The 3D gizmo (spec §3): drawn in the 3D window over a placed piece, with the cloth not live.
// Three arrows translate along world X, Y and Z, three rings rotate about the piece frame's
// normal, x and y, and the centre square translates in the camera plane. The View has no gizmo:
// the worker draws these as lines and a point on a layer of their own, on top, pickable. The
// drag maths reads the View's camera as the cloth's Drag does (drape.js dragBasis). Pure (no
// View, no kernel), so Node tests it.
import { arrangedPoint } from "./arrange.js";
import { reslotOps } from "./reslot.js";
import { setPattern } from "./model.js";

export const GIZMO_LAYER = 2;
export const SNAP_MM = 10;
export const SNAP_DEG = 15;
export const PARTS = ["tx", "ty", "tz", "rn", "rx", "ry", "plane"];
export const GIZMO_COLOURS = {
    tx: "#e5534b", ty: "#57ab5a", tz: "#539bf5",
    rn: "#c678dd", rx: "#e0a045", ry: "#45c7d0", plane: "#f2f2f2",
};
export const GIZMO_HOVER = "#fff36b";      // the part under the pointer (the selection's accent is the piece's)
const WORLD = { tx: [1, 0, 0], ty: [0, 1, 0], tz: [0, 0, 1] };
const RING_SEGMENTS = 48;
export const RING = 0.55;      // the rings' radius, a fraction of the arrows' length

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const unit = (a) => mul(a, 1 / Math.hypot(...a));

// The piece frame's unit axes: x, y and the normal n = x cross y.
export function frameAxes(frame) {
    const x = unit(frame.x), y = unit(frame.y);
    return { x, y, n: unit(cross(x, y)) };
}

// Where the gizmo stands: the piece's 2D bounds centre, arranged (round its wrap when it has
// one); for a wrapped piece the point of the wrap axis level with it, so its rotations turn
// the piece about the axis it is wrapped round.
export function gizmoPivot(node, bounds) {
    const c = arrangedPoint(node.frame, node.wrap ?? null, (bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2);
    const w = node.wrap;
    if (!w || !(w.radius > 0)) return c;
    const d = unit(w.dir);
    return add(w.origin, mul(d, dot(sub(c, w.origin), d)));
}
// The arrows' length (mm): from the piece's size, so the gizmo reads at the piece's scale.
export const gizmoSize = (bounds) => Math.min(Math.max(0.45 * Math.max(bounds[2] - bounds[0], bounds[3] - bounds[1]), 80), 260);

// A unit vector perpendicular to `a`.
function perp(a) {
    const p = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    return unit(sub(p, mul(a, dot(p, a))));
}
// The ring about `axis` through `pivot`, radius r: its points (RING_SEGMENTS, closed).
export function ringPoints(pivot, axis, r, segments = RING_SEGMENTS) {
    const u = perp(axis), v = cross(axis, u), out = [];
    for (let i = 0; i < segments; i++) {
        const a = (2 * Math.PI * i) / segments;
        out.push(add(pivot, add(mul(u, r * Math.cos(a)), mul(v, r * Math.sin(a)))));
    }
    return out;
}
// The parts as showLines' segments (the plane square a point): {tx, ty, tz, rn, rx, ry: segs,
// plane: [x, y, z]}, and `handles`: a point on each part a press can grab.
export function gizmoShapes(pivot, frame, size) {
    const out = { plane: [...pivot], handles: { plane: [...pivot] } };
    for (const part of ["tx", "ty", "tz"]) {
        const a = WORLD[part], tip = add(pivot, mul(a, size)), p = perp(a), q = cross(a, p);
        const back = add(pivot, mul(a, 0.82 * size)), h = 0.06 * size, segs = [...pivot, ...tip];
        for (const s of [p, mul(p, -1), q, mul(q, -1)]) segs.push(...tip, ...add(back, mul(s, h)));
        out[part] = segs;
        out.handles[part] = add(pivot, mul(a, 0.92 * size));     // past the rings
    }
    const ax = frameAxes(frame), r = RING * size;
    for (const [part, axis] of [["rn", ax.n], ["rx", ax.x], ["ry", ax.y]]) {
        const pts = ringPoints(pivot, axis, r), segs = [];
        for (let i = 0; i < pts.length; i++) segs.push(...pts[i], ...pts[(i + 1) % pts.length]);
        out[part] = segs;
        out.handles[part] = pts;          // every ring point: the worker shows the one most in view
    }
    return out;
}

// The screen point (device px) to grab a ring by: of its points on the screen (`pts`), one well
// out from the pivot's (`centre`, at least 70% of the farthest) and farthest from the arrows'
// screen segments (`arrows`, [[x0, y0, x1, y1]]), so a press there picks the ring alone.
export function ringHandle(pts, centre, arrows) {
    const far = Math.max(...pts.map((p) => Math.hypot(p[0] - centre[0], p[1] - centre[1])));
    const toSeg = (p, [x0, y0, x1, y1]) => {
        const dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy;
        const t = l2 > 0 ? Math.min(Math.max(((p[0] - x0) * dx + (p[1] - y0) * dy) / l2, 0), 1) : 0;
        return Math.hypot(p[0] - x0 - t * dx, p[1] - y0 - t * dy);
    };
    let best = null, bd = -1;
    for (const p of pts) {
        if (Math.hypot(p[0] - centre[0], p[1] - centre[1]) < 0.7 * far) continue;
        const d = Math.min(Infinity, ...arrows.map((a) => toSeg(p, a)));
        if (d > bd) { bd = d; best = p; }
    }
    return best;
}

// A world vector on the screen, in device pixels (x right, y down) per its length, from the
// camera basis ({right, up, perPixel} at the pivot's depth).
export const toPx = (w, basis) => [dot(w, basis.right) / basis.perPixel, -dot(w, basis.up) / basis.perPixel];

// The distance (mm) along unit `axis` that a pointer move of (dx, dy) device pixels asks for:
// the move projected on the axis's screen direction. 0 when the axis points at the eye.
export function axisShift(axis, basis, dx, dy) {
    const a = toPx(axis, basis), l2 = a[0] * a[0] + a[1] * a[1];
    return l2 < 1e-6 ? 0 : (dx * a[0] + dy * a[1]) / l2;
}

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
// The angle (radians, right-handed about `axis`) a ring drag turns: `grab` and `now` are the
// pointer's device pixels from the pivot's on the screen. A ring facing the camera turns with
// the pointer's angle about the pivot; one seen edge on (its axis across the view) follows the
// pointer along the ring's tangent at the grabbed point (`pivot`, `radius` the ring's).
export function ringAngle(axis, basis, grab, now, radius) {
    const forward = basis.forward ?? cross(basis.up, basis.right);
    const facing = dot(axis, forward);
    if (Math.abs(facing) > 0.3) {
        const a0 = Math.atan2(-grab[1], grab[0]), a1 = Math.atan2(-now[1], now[0]);
        // counter-clockwise on the screen is a positive turn about the axis toward the eye
        return -Math.sign(facing) * wrapAngle(a1 - a0);
    }
    // the ring's point nearest the grab on the screen (of two, the nearer the eye), and its
    // tangent there
    let best = null, bd = Infinity, bz = Infinity;
    for (const p of ringPoints([0, 0, 0], axis, radius, 720)) {
        const s = toPx(p, basis), d = Math.hypot(s[0] - grab[0], s[1] - grab[1]), z = dot(p, forward);
        if (d < bd - 1 || (d < bd + 1 && z < bz)) { bd = Math.min(d, bd); bz = z; best = p; }
    }
    const t = toPx(cross(axis, best), basis), l2 = t[0] * t[0] + t[1] * t[1];
    return l2 < 1e-6 ? 0 : ((now[0] - grab[0]) * t[0] + (now[1] - grab[1]) * t[1]) / l2;
}

export const snapTo = (v, step) => Math.round(v / step) * step;

// The rotation matrix (rows) of `angle` radians about unit `axis` (Rodrigues).
export function rotation(axis, angle) {
    const [x, y, z] = unit(axis), c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
    return [
        [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
        [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
        [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
    ];
}
const apply = (R, v) => [dot(R[0], v), dot(R[1], v), dot(R[2], v)];

// A frame and wrap moved rigidly: turned by R about `pivot`, then shifted by `t`. The wrap's
// axis moves and turns with the piece.
export function moveRigid(frame, wrap, pivot, R, t) {
    const pt = (p) => add(add(pivot, apply(R, sub(p, pivot))), t);
    const f = { origin: pt(frame.origin), x: apply(R, frame.x), y: apply(R, frame.y) };
    const w = wrap ? { ...wrap, origin: pt(wrap.origin), dir: apply(R, wrap.dir) } : null;
    return { frame: f, wrap: w };
}
const IDENTITY = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

/**
 * The piece's frame and wrap for a drag of gizmo `part` from `start` ({frame, wrap}, as at the
 * press): `basis` the camera at the pivot (dragBasis), `grab` and `now` the pointer's device
 * pixels from the pivot's on the screen at the press and now, `radius` the rings', `shift`
 * snapping (10 mm, 15 degrees). -> {frame, wrap, shift: [x, y, z] mm, angle: radians}
 */
export function gizmoDrag(part, start, pivot, { basis, grab, now, radius = 100, shift = false }) {
    const dx = now[0] - grab[0], dy = now[1] - grab[1];
    if (WORLD[part]) {
        let s = axisShift(WORLD[part], basis, dx, dy);
        if (shift) s = snapTo(s, SNAP_MM);
        const t = mul(WORLD[part], s);
        return { ...moveRigid(start.frame, start.wrap, pivot, IDENTITY, t), shift: t, angle: 0 };
    }
    if (part === "plane") {
        const k = basis.perPixel;
        let t = [0, 1, 2].map((i) => basis.right[i] * dx * k - basis.up[i] * dy * k);
        if (shift) t = t.map((v) => snapTo(v, SNAP_MM));
        return { ...moveRigid(start.frame, start.wrap, pivot, IDENTITY, t), shift: t, angle: 0 };
    }
    const ax = frameAxes(start.frame), axis = { rn: ax.n, rx: ax.x, ry: ax.y }[part];
    if (!axis) throw new Error(`no gizmo part ${part}`);
    let angle = ringAngle(axis, basis, grab, now, radius);
    if (shift) angle = snapTo(angle, (SNAP_DEG * Math.PI) / 180);
    return { ...moveRigid(start.frame, start.wrap, pivot, rotation(axis, angle), [0, 0, 0]), shift: [0, 0, 0], angle };
}

/**
 * The ops of a gizmo move: the piece's frame and wrap (`fields`), its slot "custom", and the
 * pieces "on" it (and on those) following it, keeping their offset. `drawings` id -> {bounds}
 * (anything with get), `avatar` {bounds, landmarks} as reslotOps takes it.
 */
export function gizmoOps(nodes, id, fields, drawings, avatar) {
    const node = nodes.find((n) => n.id === id);
    if (!node) throw new Error(`no piece ${id}`);
    const meta = { ...(node.meta ?? {}), atelier: { ...(node.meta?.atelier ?? {}), slot: "custom" } };
    const moved = { frame: fields.frame, wrap: fields.wrap ?? null, meta };
    const after = nodes.map((n) => (n.id === id ? { ...n, ...moved } : n));
    const follow = reslotOps(after, drawings, avatar ?? { bounds: [0, 0, 0, 0, 0, 0], landmarks: null }, new Set([id])).ops;
    return [...setPattern(nodes, id, moved), ...follow];
}
