// The 2D window's mapping and pick decoding. The View draws and picks the pattern window
// (viewport 1: an orthographic camera on the pattern plane z = 0); this module reads that
// viewport's frame report -- `viewer.frameReport()[1]`, {rect, view, projection, eye, kind},
// column-major, entry 4 * col + row -- to go between its device pixels and pattern millimetres
// (as the forge's projection.js does), and turns a pick answer into the hit a tool takes. Pure:
// no View, no kernel, no DOM. (The M4a canvas code below goes in Task 10.)

import { seamColour } from "./sewing.js";

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
        if (i < n - 1) out.points.push([...seg.to]);
    });
    out.locked = [...new Set(out.locked)];
    return out;
}

/** A pick answer, resolved through the item map's entry `what`, as the tools' hit. */
export function hitOf(what, pick, drawings) {
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
        case "sew": return edge(what.id, {});
        case "seam": return edge(what.pattern, { seam: what.id });
        case "internal": return { kind: "internal", id: what.id, index: what.index };
        case "hole": return { kind: "hole", id: what.id, index: what.index };
        case "fill": case "label": case "grain": case "notch": case "cut": return { kind: "pattern", id: what.id };
        default: return null;
    }
}

/** The box around every drawing's bounds; null for none. */
export function unionBounds(drawings) {
    let b = null;
    for (const d of drawings) {
        if (!d.bounds) continue;
        b = b ? [Math.min(b[0], d.bounds[0]), Math.min(b[1], d.bounds[1]), Math.max(b[2], d.bounds[2]), Math.max(b[3], d.bounds[3])] : [...d.bounds];
    }
    return b;
}

export class Camera {
    constructor(w, h) { this.w = w; this.h = h; this.scale = 1; this.ox = 0; this.oy = 0; }
    resize(w, h) { this.w = w; this.h = h; }
    toScreen([x, y]) { return [x * this.scale + this.ox, this.h - (y * this.scale + this.oy)]; }
    toWorld([sx, sy]) { return [(sx - this.ox) / this.scale, (this.h - sy - this.oy) / this.scale]; }
    zoomAt([sx, sy], f) {
        const [wx, wy] = this.toWorld([sx, sy]);
        this.scale = Math.max(0.01, Math.min(200, this.scale * f));
        const [nx, ny] = this.toScreen([wx, wy]);
        this.ox += sx - nx; this.oy -= sy - ny;
    }
    pan(dx, dy) { this.ox += dx; this.oy -= dy; }
    fit([x0, y0, x1, y1], margin = 40) {
        const w = Math.max(x1 - x0, 1e-6), h = Math.max(y1 - y0, 1e-6);
        this.scale = Math.min((this.w - 2 * margin) / w, (this.h - 2 * margin) / h);
        this.ox = (this.w - w * this.scale) / 2 - x0 * this.scale;
        this.oy = (this.h - h * this.scale) / 2 - y0 * this.scale;
    }
}

const ACCENT = "#ff7a1a";

export function pointInRing(ring, [x, y]) {
    let inside = false;
    for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
        const [xi, yi, xj, yj] = [ring[i], ring[i + 1], ring[j], ring[j + 1]];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

function segDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function polyHit(poly, [x, y], tol) {
    for (let i = 0; i + 3 < poly.length; i += 2)
        if (segDist(x, y, poly[i], poly[i + 1], poly[i + 2], poly[i + 3]) <= tol) return true;
    return false;
}

export function hitTest(drawings, seams, world, tolerancePx, camera, nodes, selectedId) {
    const tol = tolerancePx / camera.scale;
    const [x, y] = world;
    if (selectedId != null && nodes) {
        const { points, handles } = pointsOf(nodes, selectedId);
        for (let i = 0; i < points.length; i++)
            if (Math.hypot(points[i][0] - x, points[i][1] - y) <= tol) return { kind: "point", id: selectedId, index: i };
        for (const h of handles)
            if (Math.hypot(h.at[0] - x, h.at[1] - y) <= tol) return { kind: "handle", id: selectedId, index: h.index, which: h.which };
    }
    let best = null, bestD2 = tol * tol;
    for (const d of drawings) {
        const sm = d.samples, n = sm.length / 3;
        if (n < 2) continue;
        const end = d.sides?.[d.sides.length - 1] ?? sm[sm.length - 3] + 1;
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n, a = i * 3, b = j * 3;
            const ax = sm[a + 1], ay = sm[a + 2], dx = sm[b + 1] - ax, dy = sm[b + 2] - ay;
            const l2 = dx * dx + dy * dy;
            const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
            const ex = x - (ax + t * dx), ey = y - (ay + t * dy), d2 = ex * ex + ey * ey;
            if (d2 <= bestD2) {
                bestD2 = d2;
                const s1 = j === 0 ? end : sm[b];
                best = { d, s: sm[a] + t * (s1 - sm[a]) };
            }
        }
    }
    if (best) {
        const sides = best.d.sides ?? [0];
        let side = 0;
        for (let i = 0; i < sides.length; i++) if (sides[i] <= best.s) side = i;
        side = Math.min(side, Math.max(sides.length - 2, 0));
        // a seam lies on the outline: the edge hit names it too (the edit tool's click selects it)
        const id = best.d.id;
        const seam = (seams ?? []).find((sm) => (sm.a === id && polyHit(sm.points_a ?? [], world, tol)) || (sm.b === id && polyHit(sm.points_b ?? [], world, tol)));
        return seam ? { kind: "edge", id, s: best.s, side, seam: seam.id } : { kind: "edge", id, s: best.s, side };
    }
    for (const sm of seams ?? [])
        if (polyHit(sm.points_a ?? [], world, tol) || polyHit(sm.points_b ?? [], world, tol)) return { kind: "seam", id: sm.id };
    const inside = drawings.filter((d) => pointInRing(d.sew, world));
    if (inside.length) {
        inside.sort((a, b) => (b.layer ?? 0) - (a.layer ?? 0));
        return { kind: "pattern", id: inside[0].id };
    }
    return null;
}

const FILLS = ["rgba(150,170,200,0.25)", "rgba(200,170,150,0.25)", "rgba(160,200,160,0.25)", "rgba(200,160,200,0.25)"];

function trace(ctx, cam, pts) {
    ctx.beginPath();
    for (let i = 0; i + 1 < pts.length; i += 2) {
        const [sx, sy] = cam.toScreen([pts[i], pts[i + 1]]);
        if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
    }
}

function grid(ctx, cam) {
    const w = cam.w, h = cam.h;
    const [x0, y1] = cam.toWorld([0, 0]), [x1, y0] = cam.toWorld([w, h]);
    for (const [step, colour] of [[10, "rgba(128,128,128,0.15)"], [100, "rgba(128,128,128,0.35)"]]) {
        if (step * cam.scale < 4) continue;
        ctx.strokeStyle = colour; ctx.lineWidth = 1; ctx.beginPath();
        for (let gx = Math.floor(x0 / step) * step; gx <= x1; gx += step) {
            const [sx] = cam.toScreen([gx, 0]); ctx.moveTo(sx, 0); ctx.lineTo(sx, h);
        }
        for (let gy = Math.floor(y0 / step) * step; gy <= y1; gy += step) {
            const [, sy] = cam.toScreen([0, gy]); ctx.moveTo(0, sy); ctx.lineTo(w, sy);
        }
        ctx.stroke();
    }
}

// Per drawing, once: the unit world-space normal at each notch, from the nearest sample's tangent.
const normalsCache = new WeakMap();
function normalsOf(d) {
    let r = normalsCache.get(d);
    if (r) return r;
    r = [];
    const s = d.samples;
    for (const [nx, ny] of d.notches ?? []) {
        let bi = 0, bd = Infinity;
        for (let i = 0; i + 2 < s.length; i += 3) {
            const q = Math.hypot(s[i + 1] - nx, s[i + 2] - ny);
            if (q < bd) { bd = q; bi = i; }
        }
        const a = Math.max(bi - 3, 0), b = Math.min(bi + 3, s.length - 3);
        const tx = s[b + 1] - s[a + 1], ty = s[b + 2] - s[a + 2], l = Math.hypot(tx, ty) || 1;
        r.push([-ty / l, tx / l]);
    }
    normalsCache.set(d, r);
    return r;
}
export { normalsOf as notchNormals };

// cam.w/h are CSS pixels: the caller sizes the canvas by devicePixelRatio and calls
// ctx.setTransform(dpr, 0, 0, dpr, 0, 0) before draw.
export function draw(ctx, cam, state) {
    const { drawings = [], seams = [], selection = null, hover = null, nodes = [], overlay = null } = state;
    const selId = selection?.id ?? null;
    ctx.save();
    ctx.fillStyle = "#1e2024";
    ctx.fillRect(0, 0, cam.w, cam.h);
    grid(ctx, cam);
    const ordered = [...drawings].sort((a, b) => (a.layer ?? 0) - (b.layer ?? 0));
    for (const d of ordered) {
        const sel = d.id === selId, hov = hover?.id === d.id;
        trace(ctx, cam, d.sew); ctx.fillStyle = FILLS[(d.layer ?? 0) % FILLS.length]; ctx.fill();
        if (d.cut && d.cut.length) {
            trace(ctx, cam, d.cut); ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
            ctx.strokeStyle = "rgba(200,200,200,0.5)"; ctx.stroke(); ctx.setLineDash([]);
        }
        trace(ctx, cam, d.sew); ctx.lineWidth = sel ? 2.5 : hov ? 2 : 1.5;
        ctx.strokeStyle = sel ? ACCENT : hov ? "#ffffff" : "#d8dce2"; ctx.stroke();
        for (const n of d.internal ?? []) {
            trace(ctx, cam, n.points.flat ? n.points.flat() : n.points);
            ctx.setLineDash(n.kind === "fold" ? [6, 4] : []); ctx.lineWidth = 1.2;
            ctx.strokeStyle = "#b0b6c0"; ctx.stroke(); ctx.setLineDash([]);
        }
        const norms = normalsOf(d);
        (d.notches ?? []).forEach(([nx, ny], k) => {
            const [cx, cy] = cam.toScreen([nx, ny]);
            ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + norms[k][0] * 6, cy - norms[k][1] * 6);
            ctx.lineWidth = 1.5; ctx.strokeStyle = sel ? ACCENT : "#d8dce2"; ctx.stroke();
        });
        if (d.grain && d.grain.length >= 4) {
            const [g0x, g0y] = cam.toScreen([d.grain[0], d.grain[1]]), [g1x, g1y] = cam.toScreen([d.grain[2], d.grain[3]]);
            const ang = Math.atan2(g1y - g0y, g1x - g0x);
            ctx.beginPath(); ctx.moveTo(g0x, g0y); ctx.lineTo(g1x, g1y);
            ctx.moveTo(g1x, g1y); ctx.lineTo(g1x - 8 * Math.cos(ang - 0.4), g1y - 8 * Math.sin(ang - 0.4));
            ctx.moveTo(g1x, g1y); ctx.lineTo(g1x - 8 * Math.cos(ang + 0.4), g1y - 8 * Math.sin(ang + 0.4));
            ctx.lineWidth = 1; ctx.strokeStyle = "#9aa0aa"; ctx.stroke();
        }
        if (d.label && d.bounds) {
            const [lx, ly] = cam.toScreen([(d.bounds[0] + d.bounds[2]) / 2, (d.bounds[1] + d.bounds[3]) / 2]);
            ctx.fillStyle = "#c8ccd4"; ctx.font = "12px sans-serif"; ctx.textAlign = "center"; ctx.fillText(d.label, lx, ly);
        }
    }
    seams.forEach((sm, i) => {
        const colour = seamColour(i);
        for (const pts of [sm.points_a, sm.points_b]) {
            if (!pts || pts.length < 4) continue;
            trace(ctx, cam, pts); ctx.lineWidth = selection?.kind === "seam" && selection.id === sm.id ? 4 : 3;
            ctx.strokeStyle = colour; ctx.stroke();
            const m = (pts.length >> 2) * 2;
            const [tx, ty] = cam.toScreen([pts[m], pts[m + 1]]);
            ctx.fillStyle = colour; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "center"; ctx.fillText(String(i + 1), tx, ty - 6);
        }
    });
    if (selId != null) {
        const { points, handles } = pointsOf(nodes, selId);
        for (const h of handles) {
            const [cx, cy] = cam.toScreen(h.at);
            for (const k of [h.from, h.to]) {
                const anchor = k == null ? null : points[k];
                if (!anchor) continue;
                const [ax, ay] = cam.toScreen(anchor);
                ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(cx, cy); ctx.lineWidth = 1; ctx.strokeStyle = "rgba(255,122,26,0.6)"; ctx.stroke();
            }
            ctx.beginPath(); ctx.arc(cx, cy, 3.5, 0, Math.PI * 2); ctx.fillStyle = ACCENT; ctx.fill();
        }
        for (const p of points) {
            const [px, py] = cam.toScreen(p);
            ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.fillStyle = "#ffffff"; ctx.fill();
            ctx.lineWidth = 1.5; ctx.strokeStyle = ACCENT; ctx.stroke();
        }
    }
    if (overlay) {
        for (const l of overlay.lines ?? []) { trace(ctx, cam, l.flat()); // the tools give [x, y] pairs
            ctx.lineWidth = 1.5; ctx.setLineDash([5, 3]); ctx.strokeStyle = ACCENT; ctx.stroke(); ctx.setLineDash([]); }
        for (const p of overlay.points ?? []) { const [px, py] = cam.toScreen(p); ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.fillStyle = ACCENT; ctx.fill(); }
    }
    ctx.restore();
}
