// Where a flat pattern stands around the avatar, and the pure helpers the worker draws with.
// No kernel and no View in here, so Node can test it.
import { seamColour } from "./sewing.js";

// Slot origins are fractions of the avatar's bounds (min xyz, max xyz); x and y are the
// pattern's 2D axes in world space (y up, the avatar facing +z, the panel facing outward).
// The bounds' width takes in the form's arms (f-M is 968 mm across), so the side and arm
// slots sit just past it: a fraction well beyond 1 would put them metres away. The front and
// back stand about 50 mm clear of f-M's bust (its depth is 300 mm, z -156 to 144): the
// cloth sews them together before it drapes, so a slot far out is a seam that never closes.
export const SLOTS = {
    front:      { label: "Front",      origin: [0.5, 0.72, 1.15],  x: [1, 0, 0],  y: [0, 1, 0] },
    back:       { label: "Back",       origin: [0.5, 0.72, -0.12], x: [-1, 0, 0], y: [0, 1, 0] },
    left_side:  { label: "Left side",  origin: [1.05, 0.62, 0.5],  x: [0, 0, -1], y: [0, 1, 0] },
    right_side: { label: "Right side", origin: [-0.05, 0.62, 0.5], x: [0, 0, 1],  y: [0, 1, 0] },
    left_arm:   { label: "Left arm",   origin: [1.2, 0.8, 0.5],    x: [0, 0, -1], y: [0, 1, 0] },
    right_arm:  { label: "Right arm",  origin: [-0.2, 0.8, 0.5],   x: [0, 0, 1],  y: [0, 1, 0] },
};

// The reader's format for an avatar file: "stl" for .stl, else "step" (.stp, .step).
export const avatarFormat = (name) => (/\.stl$/i.test(name) ? "stl" : "step");

// A read scene's axis-aligned box (min xyz, max xyz) in the file's coordinates: its
// vertices are nine floats each (position, normal, colour), relative to origin().
export function sceneBox(vertices, origin, stride = 9) {
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = 0; i + 2 < vertices.length; i += stride)
        for (let a = 0; a < 3; a++) { const v = vertices[i + a] + origin[a]; if (v < b[a]) b[a] = v; if (v > b[a + 3]) b[a + 3] = v; }
    return b;
}

const vadd = (p, q) => p.map((v, i) => v + q[i]), vmul = (p, s) => p.map((v) => v * s);
const vdot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
const vunit = (p) => vmul(p, 1 / Math.hypot(...p));

// A sleeve wrapped round a limb: the pattern's y runs up the limb toward `shoulder` (its hem
// `dist` mm down the axis `dir`, which points away from the body), its width wraps round the
// axis at `radius` with its centre on the limb's top, its outer face outward. The kernel's
// arrangement (frame, then wrap) puts pattern x along the cylinder from the frame's origin,
// so the origin sits at the angle that lands the piece's centre on top.
// -> the `frame` and `wrap` fields of the garment.pattern.
export function limbFields(shoulder, dir, radius, dist, patternBounds) {
    const d = vunit(dir), back = vmul(d, -1);
    const up = vunit(vadd([0, 1, 0], vmul(d, -vdot([0, 1, 0], d))));   // the limb's top
    const t = cross(back, up);
    const th = (patternBounds[0] + patternBounds[2]) / 2 / radius;
    const rr = vadd(vmul(up, Math.cos(th)), vmul(t, -Math.sin(th)));
    return {
        frame: { origin: vadd(vadd(shoulder, vmul(d, dist)), vmul(rr, radius)), x: cross(back, rr), y: back },
        wrap: { origin: [...shoulder], dir: d, radius },
    };
}

// The `garment.pattern` frame field for `slot`: the piece's 2D bounds centre lands on the slot point.
export function slotFrame(slot, avatarBounds, patternBounds) {
    const s = SLOTS[slot];
    if (!s) throw new Error(`no slot ${slot}`);
    const point = [0, 1, 2].map((i) => avatarBounds[i] + s.origin[i] * (avatarBounds[i + 3] - avatarBounds[i]));
    const cx = (patternBounds[0] + patternBounds[2]) / 2, cy = (patternBounds[1] + patternBounds[3]) / 2;
    return {
        origin: point.map((v, i) => v - cx * s.x[i] - cy * s.y[i]),
        x: [...s.x], y: [...s.y],
    };
}

// ---- landmarks: assets/forms.json (tools/dressform.py), on the avatar when it has them ----

// The bounds the slot fractions scale with: the body's, the head left out (a head lifts the
// bounds' top 150 mm, which would lift every slot with it).
export function bodyBounds(bounds, lm) {
    if (lm?.slot_bounds) bounds = lm.slot_bounds;   // a built form's pose-independent box (form-pose.js)
    if (!lm?.body_top) return bounds;
    return [bounds[0], bounds[1], bounds[2], bounds[3], Math.min(bounds[4], lm.body_top), bounds[5]];
}

// Beside the head, one a side, facing out: a hood half drawn with its face edge at 2D x min
// (the left half) or x max (its mirror, the right half) and its neck edge at 2D y min.
export const HOOD_SLOTS = {
    hood_left:  { label: "Hood left",  side: 1 },
    hood_right: { label: "Hood right", side: -1 },
};
const HOOD_GAP = 40;     // mm between the head's side and the hood
const HOOD_FRONT = 30;   // mm the face edge stands in front of the face

export function hoodFrame(side, head, hpsY, pb) {
    const x = side > 0 ? [0, 0, -1] : [0, 0, 1], y = [0, 1, 0];
    const corner = [head.centre[0] + side * (head.half[0] + HOOD_GAP), hpsY, head.centre[2] + head.half[2] + HOOD_FRONT];
    const fx = side > 0 ? pb[0] : pb[2];
    return { origin: [0, 1, 2].map((i) => corner[i] - fx * x[i] - pb[1] * y[i]), x, y };
}

// A sleeve on a form's arm, wrapped as the T-shirt sample's are: its cap's top 40 mm past the
// shoulder joint, the wrap 15 mm out from the joint's ball. limbFields puts pattern y = 0 at the
// hem; a drawn piece's hem is at its bounds' y min.
export function armFields(arm, pb) {
    const f = limbFields(arm.shoulder, arm.dir, arm.radius + 15, pb[3] - pb[1] + 40, pb);
    f.frame.origin = f.frame.origin.map((v, i) => v - pb[1] * f.frame.y[i]);
    return f;
}

// A piece on another piece: its frame, moved out along its normal 8 mm a layer.
export const LAYER_GAP = 8;
export function onFrame(frame, dLayer) {
    if (!dLayer) return frame;
    const n = cross(frame.x, frame.y);
    return { origin: frame.origin.map((v, i) => v + LAYER_GAP * dLayer * n[i]), x: [...frame.x], y: [...frame.y] };
}

// Arrange: each piece not yet placed goes to the next free named slot -- the SLOTS in order,
// then the hood slots on a form with a head. An "on:<id>" slot is only ever the user's pick:
// a piece sewn to a placed one is not put on it (a back sewn to a front is not a pocket).
// avatar: {bounds, landmarks}; drawings: id -> {bounds}. -> [{id, fields}] in pattern order.
export function arrangeSlots(nodes, drawings, avatar) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const patterns = byId.get("garment")?.patterns ?? [];
    const lm = avatar.landmarks ?? null;
    const names = [...Object.keys(SLOTS), ...(lm?.head ? Object.keys(HOOD_SLOTS) : [])];
    const taken = new Set(patterns.map((id) => byId.get(id)?.meta?.atelier?.slot).filter(Boolean));
    const free = names.filter((s) => !taken.has(s));
    const out = [];
    for (const id of patterns) {
        const n = byId.get(id), d = drawings.get(id);
        if (!n || n.meta?.atelier?.slot || !d || !free.length) continue;
        out.push({ id, fields: slotFields(n, free.shift(), avatar.bounds, d.bounds, { landmarks: lm }) });
    }
    return out;
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// A frame as the extrude call takes it: origin, x, y, z (z = x cross y), twelve doubles.
// `frame` is {origin,x,y}, twelve numbers already, or absent / "xy" (the floor plane).
export function frame12(frame) {
    if ((Array.isArray(frame) || frame instanceof Float64Array) && frame.length === 12) return Float64Array.from(frame);
    if (frame && typeof frame === "object" && frame.origin) return Float64Array.from([...frame.origin, ...frame.x, ...frame.y, ...cross(frame.x, frame.y)]);
    return Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
}

// An unarranged pattern lies on the floor (the world x-z plane, y up) beside the avatar,
// keeping its 2D layout: 2D (x, y) -> world (x0 + x, floor, z0 - y), x0/z0 fixed beside the
// avatar and not depending on the pattern, so pieces keep their 2D distances.
export function floorFrame(avatarBounds) {
    const gap = 150;
    return { origin: [avatarBounds[3] + gap, avatarBounds[1], avatarBounds[5]], x: [1, 0, 0], y: [0, 0, -1] };
}

// A frame for drawing: the node's own, or the floor one.
export function drawFrame(node, avatarBounds) {
    return node.frame && node.frame !== "xy" ? node.frame : floorFrame(avatarBounds);
}

// The arranged 3D point of pattern point (x, y): through the frame, then round the wrap (a
// sleeve's cylinder) when there is one -- the kernel's arrangement (cadaclysm-cloth simmesh.rs
// `arrange`), so what the 3D window draws before Simulate stands where the cloth starts. A
// wrap measures its angle from the frame origin's side of the axis, the arc as the 2D distance
// along x from the origin: a sleeve drawn far along x in 2D still lands round its arm, where
// the flat frame alone would put it that far off.
export function arrangedPoint(frame, wrap, x, y) {
    const f = frame12(frame), o = [f[0], f[1], f[2]], fx = [f[3], f[4], f[5]];
    const q = [0, 1, 2].map((k) => f[k] + x * f[3 + k] + y * f[6 + k]);
    if (!wrap || !(wrap.radius > 0)) return q;
    const kl = Math.hypot(...wrap.dir);
    if (!(kl > 0)) return q;
    const kk = wrap.dir.map((v) => v / kl), a = wrap.origin;
    const oa = o.map((v, i) => v - a[i]), radial = oa.map((v, i) => v - kk[i] * vdot(oa, kk));
    const tx = fx.map((v, i) => v - kk[i] * vdot(fx, kk)), rl = Math.hypot(...radial), tl = Math.hypot(...tx);
    if (!(rl > 0) || !(tl > 0)) return q;
    const rr = vmul(radial, 1 / rl), tt = vmul(tx, 1 / tl);
    const dd = q.map((v, i) => v - o[i]), theta = vdot(dd, tt) / wrap.radius;
    // the kernel's radius + ww, ww = d.rr + (|radial| - radius): the frame origin's own distance from the axis
    const hgt = vdot(q.map((v, i) => v - a[i]), kk), rad = vdot(dd, rr) + rl;
    return [0, 1, 2].map((i) => a[i] + kk[i] * hgt + (rr[i] * Math.cos(theta) + tt[i] * Math.sin(theta)) * rad);
}

// A wrapped piece's mesh for the 3D window: its 2D fill ({positions xyz at z = 0, indices},
// kernel.js fillOf) refined by longest-edge bisection until no 2D edge is over `maxEdge` mm,
// then each point arranged. Each triangle is cut only as much as its own edges need (a small
// one is left alone), and an edge's midpoint is one shared point, so the mesh stays conforming:
// an edge over maxEdge is split at its midpoint by both triangles on it, one at most maxEdge by
// neither. -> {positions (Float32Array xyz), indices, uv (Float64Array, the 2D points)}.
export function wrappedMesh(fill, frame, wrap, maxEdge = 15) {
    const P = fill.positions, I = fill.indices;
    const nv = P.length / 3;
    let uv = new Float64Array(Math.max(16, nv * 4)), n = nv;
    for (let v = 0; v < nv; v++) { uv[2 * v] = P[3 * v]; uv[2 * v + 1] = P[3 * v + 1]; }
    const mids = new Map();       // edge (lo * 2^26 + hi) -> its midpoint's index
    const mid = (a, b) => {
        const lo = a < b ? a : b, hi = a < b ? b : a, key = lo * 67108864 + hi;
        let m = mids.get(key);
        if (m === undefined) {
            if (2 * n + 2 > uv.length) { const g = new Float64Array(uv.length * 2); g.set(uv); uv = g; }
            m = n++;
            uv[2 * m] = (uv[2 * a] + uv[2 * b]) / 2; uv[2 * m + 1] = (uv[2 * a + 1] + uv[2 * b + 1]) / 2;
            mids.set(key, m);
        }
        return m;
    };
    const len2 = (a, b) => { const dx = uv[2 * a] - uv[2 * b], dy = uv[2 * a + 1] - uv[2 * b + 1]; return dx * dx + dy * dy; };
    const max2 = maxEdge * maxEdge, out = [], stack = Array.from(I);
    while (stack.length) {
        const c = stack.pop(), b = stack.pop(), a = stack.pop();
        const ab = len2(a, b), bc = len2(b, c), ca = len2(c, a);
        if (ab <= max2 && bc <= max2 && ca <= max2) { out.push(a, b, c); continue; }
        // split the longest edge at its midpoint: two triangles, the same winding
        if (ab >= bc && ab >= ca) { const m = mid(a, b); stack.push(a, m, c, m, b, c); }
        else if (bc >= ca) { const m = mid(b, c); stack.push(a, b, m, a, m, c); }
        else { const m = mid(c, a); stack.push(a, b, m, m, b, c); }
    }
    const positions = new Float32Array(3 * n);
    for (let v = 0; v < n; v++) positions.set(arrangedPoint(frame, wrap, uv[2 * v], uv[2 * v + 1]), 3 * v);
    return { positions, indices: Uint32Array.from(out), uv: uv.slice(0, 2 * n) };
}

// The wrapped meshes drawn, one a piece, kept while the piece's drawing (its `sig`), frame and
// wrap stay the same: a redraw after an edit elsewhere reuses them. `builds` counts the meshes made.
export class WrappedMeshCache {
    constructor(build = wrappedMesh) { this.build = build; this.byId = new Map(); this.builds = 0; }
    get(id, sig, frame, wrap, fill) {
        const key = JSON.stringify([sig, frame, wrap]), hit = this.byId.get(id);
        if (hit && hit.key === key) return hit.mesh;
        const mesh = this.build(fill, frame, wrap);
        this.builds++;
        this.byId.set(id, { key, mesh });
        return mesh;
    }
    // forget the pieces not in `ids` (removed, or no longer wrapped)
    keep(ids) { for (const id of this.byId.keys()) if (!ids.has(id)) this.byId.delete(id); }
}

// 2D points (x, y pairs) through a frame (and its wrap, if any), as 3D segments for showLines:
// consecutive points join, x0,y0,z0,x1,y1,z1 per segment. Display only.
export function polylineSegments(pts, frame, wrap = null) {
    const out = [];
    const at = (i) => arrangedPoint(frame, wrap, pts[2 * i], pts[2 * i + 1]);
    for (let i = 0; i + 1 < pts.length / 2; i++) out.push(...at(i), ...at(i + 1));
    return out;
}

// One seam as 3D segments: both placed ranges as polylines along the outlines, and
// connectors joining evenly spaced points of the two ranges. Both ranges are in path order,
// so a reversed seam pairs the first point of one with the last of the other.
export function seamSegments(seam, frameA, frameB, wrapA = null, wrapB = null) {
    const pa = seam.points_a, pb = seam.points_b;
    const out = [...polylineSegments(pa, frameA, wrapA), ...polylineSegments(pb, frameB, wrapB)];
    const na = pa.length / 2, nb = pb.length / 2;
    if (!na || !nb) return out;
    const fa = { frame: frameA, wrap: wrapA }, fb = { frame: frameB, wrap: wrapB };
    const at = (pts, f, i) => arrangedPoint(f.frame, f.wrap, pts[2 * i], pts[2 * i + 1]);
    const steps = Math.min(Math.max(na, nb), 6);
    for (let s = 0; s < steps; s++) {
        const u = steps > 1 ? s / (steps - 1) : 0;
        const i = Math.round(u * (na - 1));
        const j = Math.round((seam.reversed ? 1 - u : u) * (nb - 1));
        out.push(...at(pa, fa, i), ...at(pb, fb, j));
    }
    return out;
}

// Whether `selection` ({kind, id} or null) is the item of that kind and id.
// The selection after a document change: the ids that still exist (`has`), the primary id kept
// when it survives; one survivor is a plain selection, none is null. Unchanged: the same object.
export function survivingSelection(selection, has) {
    if (!selection) return null;
    if (!selection.ids) return has(selection.id) ? selection : null;
    const ids = selection.ids.filter(has);
    if (ids.length === selection.ids.length && has(selection.id)) return selection;
    if (!ids.length) return null;
    const id = ids.includes(selection.id) ? selection.id : ids[0];
    return ids.length > 1 ? { kind: selection.kind, id, ids } : { kind: selection.kind, id };
}
export const isSelected = (selection, kind, id) => !!selection && selection.kind === kind && (selection.id === id || !!selection.ids?.includes(id));

// The seams in the 3D window: one lines item per seam, in its 2D colour (the accent when
// selected), so a seam is picked and highlighted on its own. -> {shown: [{item, id, colour}], error}
// `wraps`: pattern id -> its wrap (the wrapped pieces only).
export function showSeams(viewer, seams, frames, selection, wraps = new Map()) {
    const shown = [];
    let error = null;
    seams.forEach((s, i) => {
        const colour = seamColour(i);
        try {
            const segs = seamSegments(s, frames.get(s.a), frames.get(s.b), wraps.get(s.a) ?? null, wraps.get(s.b) ?? null);
            if (segs.length) shown.push({ item: viewer.showLines(segs, isSelected(selection, "seam", s.id) ? ACCENT : colour), id: s.id, colour });
        } catch (e) { error ??= e; }
    });
    return { shown, error };
}

// View item ids -> what they are, for pick3d.
export class ItemMap {
    constructor() { this.items = new Map(); }
    set(item, what) { this.items.set(item, what); }
    clear() { this.items.clear(); }
    resolve(item) { return this.items.get(item) ?? null; }
}

const PALETTE = ["#d96c5a", "#5aa0d9", "#d9c05a", "#7fbf7a", "#b07fd9", "#d98fb4"];
// A fabric's own colour ("#rrggbb", set in the property panel: the document keeps it in the
// node's meta.atelier.colour), or null for the palette's.
export const fabricColourOf = (n) => (COLOUR.test(n?.meta?.atelier?.colour ?? "") ? n.meta.atelier.colour.toLowerCase() : null);
export const COLOUR = /^#[0-9a-fA-F]{6}$/;
// Each fabric's colour: its own, else the palette's by its place among the fabrics.
export function fabricColours(nodes) {
    const m = new Map();
    for (const n of nodes) if (n.kind === "garment.fabric") m.set(n.id, fabricColourOf(n) ?? PALETTE[m.size % PALETTE.length]);
    return m;
}
export const ACCENT = "#ffb347";

// The `set` fields that put a pattern in `slot` (frame, wrap and meta.atelier.slot), or back on
// the floor for a null/"none" slot. `ctx.landmarks` (the avatar's, or null) makes the body
// slots hang from the shoulder line and the arm slots wrap; `ctx.host` is the piece an
// "on:<id>" slot puts it on. Shared by Arrange and the property editor.
export function slotFields(node, slot, avatarBounds, patternBounds, ctx = {}) {
    const atelier = { ...(node.meta?.atelier ?? {}) };
    const meta = () => ({ ...(node.meta ?? {}), atelier });
    if (!slot || slot === "none") {
        delete atelier.slot;
        return { frame: "xy", wrap: null, meta: meta() };
    }
    atelier.slot = slot;
    const lm = ctx.landmarks ?? null;
    if (slot.startsWith("on:")) {
        const hostId = slot.slice(3), host = ctx.host;
        if (node.id !== undefined && hostId === node.id) throw new Error("a piece cannot go on itself");
        if (!host) throw new Error(`no piece ${hostId}`);
        if (!host.frame || host.frame === "xy") throw new Error("place the piece it goes on first");
        // a wrapped host: the wrap grows with the layer, so the piece keeps its length round the limb
        const dLayer = (node.layer ?? 0) - (host.layer ?? 0);
        const wrap = host.wrap ? { ...host.wrap, radius: host.wrap.radius + LAYER_GAP * dLayer } : null;
        return { frame: onFrame(host.frame, dLayer), wrap, meta: meta() };
    }
    if (HOOD_SLOTS[slot]) {
        if (!lm?.head) throw new Error("this avatar has no head: the hood slots need one (Form: f-M with head)");
        return { frame: hoodFrame(HOOD_SLOTS[slot].side, lm.head, lm.hps_y, patternBounds), wrap: null, meta: meta() };
    }
    const arm = lm?.arms && { left_arm: "left", right_arm: "right" }[slot];
    if (arm) {
        const a = lm.arms.find((a) => a.side === arm);
        if (!a) throw new Error(`this form has no ${arm} arm in its landmarks`);
        return { ...armFields(a, patternBounds), meta: meta() };
    }
    const frame = slotFrame(slot, bodyBounds(avatarBounds, lm), patternBounds);
    if (lm?.hps_y && (slot === "front" || slot === "back")) frame.origin[1] = lm.hps_y - patternBounds[3] * frame.y[1];
    return { frame, wrap: null, meta: meta() };
}
