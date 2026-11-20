// The 2D window's mapping and pick decoding. The View draws and picks the pattern window
// (viewport 1: an orthographic camera on the pattern plane z = 0); this module reads that
// viewport's frame report -- `viewer.frameReport()[1]`, {rect, view, projection, eye, kind},
// column-major, entry 4 * col + row -- to go between its device pixels and pattern millimetres
// (as the forge's projection.js does), and turns a pick answer into the hit a tool takes. Pure:
// no View, no kernel, no DOM.
import { segmentEnd } from "./model.js";

const unit3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return l < 1e-20 ? [0, 0, 1] : [v[0] / l, v[1] / l, v[2] / l]; };
function axes(r) {
    const v = r.view;
    return { right: unit3([v[0], v[4], v[8]]), up: unit3([v[1], v[5], v[9]]), look: unit3([-v[2], -v[6], -v[10]]) };
}

/** A parallel projection: its clip w is 1 whatever the depth. */
export const isOrtho = (r) => r.projection[15] === 1 && r.projection[11] === 0;

/** The pattern point [x, y] (z = 0) under pixel [px, py] of the viewport (device pixels from its top left). */
export function pxToWorld(r, [px, py]) {
    const [w, h] = [r.rect[2], r.rect[3]], m = r.projection, { right, up, look } = axes(r);
    const nx = (px / w) * 2 - 1, ny = 1 - (py / h) * 2;
    const ex = (nx - m[12]) / m[0], ey = (ny - m[13]) / m[5];
    const o = [0, 1, 2].map((i) => r.eye[i] + right[i] * ex + up[i] * ey);
    if (Math.abs(look[2]) < 1e-12) return [o[0], o[1]];
    const t = -o[2] / look[2];
    return [o[0] + look[0] * t, o[1] + look[1] * t];
}

/** Where pattern point [x, y] (z = 0) lands in the viewport, device pixels; null behind the eye. */
export function worldToPx(r, [x, y]) {
    const v = r.view, m = r.projection, p = [x, y, 0];
    const e = [0, 1, 2, 3].map((i) => v[i] * p[0] + v[4 + i] * p[1] + v[8 + i] * p[2] + v[12 + i]);
    const c = [0, 1, 3].map((i) => m[i] * e[0] + m[4 + i] * e[1] + m[8 + i] * e[2] + m[12 + i] * e[3]);
    if (c[2] <= 1e-9) return null;
    const [w, h] = [r.rect[2], r.rect[3]];
    return [w / 2 + (c[0] / c[2]) * w / 2, h / 2 - (c[1] / c[2]) * h / 2];
}

/** Millimetres a device pixel spans in an orthographic viewport. */
export const mmPerPx = (r) => 2 / (r.projection[0] * r.rect[2]);

/** The nearest point of a piece's outline samples (flat triples s, x, y; closed) to [x, y]:
 *  its arc length `s` (interpolated between samples), the side it lies on, the distance. */
export function arcAt(samples, sides, [x, y]) {
    const n = samples.length / 3, end = sides?.[sides.length - 1] ?? samples[samples.length - 3] + 1;
    let best = { s: 0, d: Infinity };
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n, a = i * 3, b = j * 3;
        const ax = samples[a + 1], ay = samples[a + 2], dx = samples[b + 1] - ax, dy = samples[b + 2] - ay;
        const l2 = dx * dx + dy * dy;
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
        const d = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
        if (d < best.d) { const s1 = j === 0 ? end : samples[b]; best = { s: samples[a] + t * (s1 - samples[a]), d }; }
    }
    const list = sides ?? [0];
    let side = 0;
    for (let i = 0; i < list.length; i++) if (list[i] <= best.s) side = i;
    return { s: best.s, side: Math.min(side, Math.max(list.length - 2, 0)), d: best.d };
}

/** The selected piece's edit handles: its path points, the Bézier and conic control points
 *  (`from`/`to` the path points their tangent lines run to), and the points an arc or a NURBS
 *  side ends at, which the edit tool leaves alone (plan ruling 13). */
export function pointsOf(nodes, id) {
    const path = (nodes ?? []).find((n) => n.id === `${id}_outline`)?.path;
    const out = { points: [], handles: [], locked: [] };
    if (!path) return out;
    const segs = path.segments ?? [], n = segs.length;
    out.points.push([...path.start]);
    segs.forEach((seg, i) => {
        const next = (i + 1) % n;
        if (seg.type === "bezier") {
            out.handles.push({ index: i, which: "c1", at: [...seg.c1], from: i });
            out.handles.push({ index: i, which: "c2", at: [...seg.c2], from: next });
        } else if (seg.type === "conic") out.handles.push({ index: i, which: "control", at: [...seg.control], from: i, to: next });
        else if (seg.type === "arc" || seg.type === "nurbs") out.locked.push(i, next);
        if (i < n - 1) out.points.push([...segmentEnd(seg)]);
    });
    out.locked = [...new Set(out.locked)];
    return out;
}

/** A pick answer, resolved through the item map's entry `what`, as the tools' hit. A label's
 *  text runs past its piece's edge and the View picks text over the fill under it, so a label
 *  answers `pieceAt(point)` -- the highest piece whose outline holds the point (the kernel's,
 *  Atelier.pieceAt) -- and its own piece only where that is none. */
export function hitOf(what, pick, drawings, pieceAt = null) {
    if (!what || !pick) return null;
    const at = pick.point ? [pick.point[0], pick.point[1]] : null;
    const edge = (id, extra) => {
        const d = drawings.get(id);
        if (!d?.samples || !at) return { kind: "pattern", id };
        const { s, side } = arcAt(d.samples, d.sides, at);
        return { kind: "edge", id, s, side, ...extra };
    };
    switch (what.kind) {
        case "points": return { kind: "point", id: what.id, index: pick.node };
        case "handles": { const h = what.handles?.[pick.node]; return h ? { kind: "handle", id: what.id, index: h.index, which: h.which } : null; }
        case "tangents": { const h = tangentHandle(what, at); return h ? { kind: "handle", id: what.id, index: h.index, which: h.which } : null; }
        case "sew": return edge(what.id, {});
        case "seam": return edge(what.pattern, { seam: what.id });
        case "internal": return { kind: "internal", id: what.id, index: what.index };
        case "hole": return { kind: "hole", id: what.id, index: what.index };
        case "label": return { kind: "pattern", id: (at && pieceAt?.(at)) ?? what.id };
        case "fill": case "grain": case "notch": case "cut": return { kind: "pattern", id: what.id };
        default: return null;
    }
}

// The handle whose tangent line (from a path point to the handle) passes nearest `at`.
function tangentHandle(what, at) {
    if (!what.handles?.length || !what.points || !at) return null;
    let best = null, bd = Infinity;
    for (const h of what.handles)
        for (const i of [h.from, h.to]) {
            const a = i === undefined ? null : what.points[i];
            if (!a) continue;
            const d = segDist(at, a, h.at);
            if (d < bd) { bd = d; best = h; }
        }
    return best;
}
function segDist([x, y], a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2)) : 0;
    return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
}

/** The piece a box select takes from an item it touches: any of the piece's own drawing (its
 *  fill, sew and cut lines, holes, internal lines, notches, grain); null for a label (its text runs
 *  past the piece), a seam or an edit handle. */
const BOX_KINDS = new Set(["fill", "sew", "cut", "hole", "internal", "notch", "grain"]);
export const boxPiece = (what) => (what && BOX_KINDS.has(what.kind) ? what.id : null);

/** The box around every drawing's bounds; null for none. */
export function unionBounds(drawings) {
    let b = null;
    for (const d of drawings) {
        if (!d.bounds) continue;
        b = b ? [Math.min(b[0], d.bounds[0]), Math.min(b[1], d.bounds[1]), Math.max(b[2], d.bounds[2]), Math.max(b[3], d.bounds[3])] : [...d.bounds];
    }
    return b;
}

// Twice the signed area of a ring of x, y pairs: positive when it runs counter-clockwise.
export function ringArea(r) {
    let a = 0;
    for (let i = 0, n = r.length >> 1; i < n; i++) { const j = (i + 1) % n; a += r[2 * i] * r[2 * j + 1] - r[2 * j] * r[2 * i + 1]; }
    return a;
}

// Per drawing, once: the unit world-space normal at each notch pointing out of the piece, from
// the nearest sample's tangent and the way the outline runs.
const normalsCache = new WeakMap();
function normalsOf(d) {
    let r = normalsCache.get(d);
    if (r) return r;
    r = [];
    const s = d.samples;
    const ring = d.sew ?? s.filter((_, i) => i % 3 !== 0);
    const out = ringArea(ring) >= 0 ? -1 : 1;          // counter-clockwise: the right of the tangent
    for (const [nx, ny] of d.notches ?? []) {
        let bi = 0, bd = Infinity;
        for (let i = 0; i + 2 < s.length; i += 3) {
            const q = Math.hypot(s[i + 1] - nx, s[i + 2] - ny);
            if (q < bd) { bd = q; bi = i; }
        }
        const a = Math.max(bi - 3, 0), b = Math.min(bi + 3, s.length - 3);
        const tx = s[b + 1] - s[a + 1], ty = s[b + 2] - s[a + 2], l = Math.hypot(tx, ty) || 1;
        r.push([(-ty / l) * out, (tx / l) * out]);
    }
    normalsCache.set(d, r);
    return r;
}
export { normalsOf as notchNormals };
