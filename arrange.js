// Where a flat pattern stands around the avatar, and the pure helpers the worker draws with.
// No kernel and no View in here, so Node can test it.
import { seamColour, seamColourIndex } from "./sewing.js";

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
// `top` (optional): the side of the limb the piece's centre lands on, the limb's top by default.
export function limbFields(shoulder, dir, radius, dist, patternBounds, top = null) {
    const d = vunit(dir), back = vmul(d, -1);
    const ref = top ?? [0, 1, 0];
    const up = vunit(vadd(ref, vmul(d, -vdot(ref, d))));   // the limb's top (or `top`)
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

// A custom (gizmo) placement anchored at the piece's bounds centre (spec §5): the `frame` and
// `wrap` that put 2D point `now` (the centre after an outline edit) where `was` (the centre
// before it) stood. A flat frame keeps its axes and shifts its origin along them. A wrapped one
// keeps its wrap: the shift is unrolled round the cylinder, its part across the limb a turn of
// the frame about the wrap's axis, its part along the limb a shift along it, any part off the
// cylinder a shift of the origin in or out (arrangedPoint is unchanged by all three).
// A frame that is not {origin, x, y} (the floor, "xy") is left as it is. -> {frame, wrap}
export function anchorFields(frame, wrap, was, now) {
    if (!frame || typeof frame !== "object" || !frame.origin) return { frame, wrap: wrap ?? null };
    const dv = vadd(vmul(frame.x, now[0] - was[0]), vmul(frame.y, now[1] - was[1]));
    const kl = wrap && wrap.radius > 0 ? Math.hypot(...wrap.dir) : 0;
    if (!(kl > 0)) return { frame: { origin: frame.origin.map((v, i) => v - dv[i]), x: [...frame.x], y: [...frame.y] }, wrap: wrap ?? null };
    const kk = wrap.dir.map((v) => v / kl), a = wrap.origin;
    const oa = frame.origin.map((v, i) => v - a[i]), radial = oa.map((v, i) => v - kk[i] * vdot(oa, kk));
    const tx = frame.x.map((v, i) => v - kk[i] * vdot(frame.x, kk)), rl = Math.hypot(...radial), tl = Math.hypot(...tx);
    if (!(rl > 0) || !(tl > 0)) return { frame, wrap };
    const rr = vmul(radial, 1 / rl), tt = vmul(tx, 1 / tl);
    const dr = vdot(dv, rr) < rl ? vdot(dv, rr) : 0;
    // the turn about the axis that takes the angle back by dv.tt / radius (tt is k x rr or its opposite)
    const side = Math.sign(vdot(kk, cross(rr, tt))) || 1, beta = -side * vdot(dv, tt) / wrap.radius;
    const c = Math.cos(beta), s = Math.sin(beta);
    const turn = (v) => { const kv = cross(kk, v), d = vdot(kk, v) * (1 - c); return v.map((x, i) => x * c + kv[i] * s + kk[i] * d); };
    const o1 = oa.map((v, i) => v - dr * rr[i]), along = vdot(dv, kk);
    const origin = turn(o1).map((v, i) => a[i] + v - along * kk[i]);
    return { frame: { origin, x: turn(frame.x), y: turn(frame.y) }, wrap: { ...wrap } };
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
    const index = seamColourIndex(seams);
    seams.forEach((s, i) => {
        const colour = seamColour(index[i]);
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
    // a gizmo placement (gizmo.js): the frame and wrap stay as they are
    if (slot === "custom") return { frame: node.frame ?? "xy", wrap: node.wrap ?? null, meta: meta() };
    // a point picked on the avatar (Place on avatar); near vertical, y keeps the frame's own
    // (or the camera's up, `ctx.up`, when it is placed)
    if (slot.startsWith("at:")) {
        const at = parseAt(slot);
        if (!at) throw new Error(`a bad avatar point ${slot}`);
        if (!patternBounds) throw new Error("the pattern has no outline to place");
        const prevY = node.frame && node.frame !== "xy" && node.frame.y ? node.frame.y : null;
        return { ...atFields(at.point, at.normal, patternBounds, { landmarks: lm, layer: node.layer ?? 0, wrap: at.wrap, up: ctx.up ?? prevY }), meta: meta() };
    }
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

// ---- place on avatar (spec §4) ----------------------------------------------------------------
// A piece placed by a click on the avatar: its slot is "at:x,y,z,nx,ny,nz" (the hit point and
// the outward normal there), ",flat" after it when the Wrap toggle was off. Refresh re-places
// from it as from any slot (slotFields).
export const PLACE_GAP = 30;     // mm the frame stands out from the body, plus the layer gap
export const ARM_REACH = 1.5;    // a hit within this many arm radii of an arm's axis wraps round it
export const AT_LABEL = "On avatar";
export const CUSTOM_LABEL = "Custom (3D)";   // a gizmo placement (gizmo.js)
const num = (v, d) => String(Number(v.toFixed(d)));

export function atSlot(point, normal, wrap = true) {
    const n = vunit(normal);
    return `at:${[...point.map((v) => num(v, 2)), ...n.map((v) => num(v, 5))].join(",")}${wrap ? "" : ",flat"}`;
}
// -> {point, normal (unit), wrap} or null
export function parseAt(slot) {
    if (typeof slot !== "string" || !slot.startsWith("at:")) return null;
    const parts = slot.slice(3).split(",");
    const flat = parts[parts.length - 1] === "flat";
    if (flat) parts.pop();
    if (parts.length !== 6) return null;
    const v = parts.map(Number);
    if (!v.every(Number.isFinite)) return null;
    const l = Math.hypot(v[3], v[4], v[5]);
    if (!(l > 0)) return null;
    return { point: v.slice(0, 3), normal: v.slice(3).map((x) => x / l), wrap: !flat };
}

// The arm whose axis passes within ARM_REACH of its radius of `p` (and past the shoulder joint
// by a radius, so the shoulder's top stays the body's): the nearest. -> {arm, t, r} or null
export function armAt(arms, p) {
    let best = null;
    for (const a of arms ?? []) {
        const d = vunit(a.dir), v = p.map((x, i) => x - a.shoulder[i]), t = vdot(v, d);
        if (!(t > a.radius)) continue;
        const r = Math.hypot(...v.map((x, i) => x - d[i] * t));
        if (r <= ARM_REACH * a.radius && (!best || r < best.r)) best = { arm: a, t, r };
    }
    return best;
}

// The `frame` and `wrap` of a piece placed at `point` with outward `normal`: flat, its bounds
// centre on the point, the frame PLACE_GAP + the layer gap out along the normal, y the world's
// up on the tangent plane (`up` where the normal is near vertical); with `wrap` and the point on
// an arm, wrapped round that arm as the arm slots are, its centre at the point.
export function atFields(point, normal, pb, { landmarks = null, layer = 0, wrap = true, up = null } = {}) {
    const n = vunit(normal);
    const cx = (pb[0] + pb[2]) / 2, cy = (pb[1] + pb[3]) / 2;
    const arm = wrap ? armAt(landmarks?.arms, point) : null;
    if (arm) {
        const a = arm.arm, d = vunit(a.dir);
        const radial = point.map((x, i) => x - a.shoulder[i] - d[i] * arm.t);
        const f = limbFields(a.shoulder, a.dir, a.radius + 15 + LAYER_GAP * layer, arm.t + (pb[3] - pb[1]) / 2, pb, radial);
        f.frame.origin = f.frame.origin.map((v, i) => v - pb[1] * f.frame.y[i]);
        return f;
    }
    const world = [0, 1, 0];
    let ref = Math.abs(vdot(n, world)) > 0.9 ? up ?? [0, 0, -1] : world;
    let y = vadd(ref, vmul(n, -vdot(ref, n)));
    if (Math.hypot(...y) < 1e-6) { ref = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]; y = vadd(ref, vmul(n, -vdot(ref, n))); }
    y = vunit(y);
    const x = cross(y, n);
    const o = vadd(point, vmul(n, PLACE_GAP + LAYER_GAP * layer));
    return { frame: { origin: o.map((v, i) => v - cx * x[i] - cy * y[i]), x, y }, wrap: null };
}

// The triangle of a mesh ({positions xyz, indices}) nearest `p` and its unit normal (by the
// winding; the caller turns it toward the eye). A pick's point is on the surface, so the nearest
// triangle is the one hit: a pick lookup, not geometry. -> {triangle, normal, distance} or null
export function nearestTriangle(positions, indices, p) {
    let best = null, bd = Infinity;
    const P = positions, I = indices;
    for (let t = 0; t + 2 < I.length; t += 3) {
        const a = 3 * I[t], b = 3 * I[t + 1], c = 3 * I[t + 2];
        const q = closestOnTriangle(p, [P[a], P[a + 1], P[a + 2]], [P[b], P[b + 1], P[b + 2]], [P[c], P[c + 1], P[c + 2]]);
        const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2;
        if (d < bd) { bd = d; best = t / 3; }
    }
    if (best === null) return null;
    const a = 3 * I[3 * best], b = 3 * I[3 * best + 1], c = 3 * I[3 * best + 2];
    const e1 = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], e2 = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    const nn = cross(e1, e2), l = Math.hypot(...nn);
    return l > 0 ? { triangle: best, normal: vmul(nn, 1 / l), distance: Math.sqrt(bd) } : null;
}
// The point of triangle abc nearest p (Ericson, Real-Time Collision Detection 5.1.5).
function closestOnTriangle(p, a, b, c) {
    const sub = (u, v) => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
    const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
    const d1 = vdot(ab, ap), d2 = vdot(ac, ap);
    if (d1 <= 0 && d2 <= 0) return a;
    const bp = sub(p, b), d3 = vdot(ab, bp), d4 = vdot(ac, bp);
    if (d3 >= 0 && d4 <= d3) return b;
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) return vadd(a, vmul(ab, d1 / (d1 - d3)));
    const cp = sub(p, c), d5 = vdot(ab, cp), d6 = vdot(ac, cp);
    if (d6 >= 0 && d5 <= d6) return c;
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) return vadd(a, vmul(ac, d2 / (d2 - d6)));
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return vadd(b, vmul(sub(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6))));
    const den = 1 / (va + vb + vc);
    return vadd(a, vadd(vmul(ab, vb * den), vmul(ac, vc * den)));
}
