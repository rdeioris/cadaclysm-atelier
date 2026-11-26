// The 2D window's scene. specs2d turns the garment into item specs -- what to show, its data,
// colour, style and what a pick on it means -- and Items2d makes the View match them: an item
// whose data and look are unchanged is left alone, a colour change is a setColour, new curves,
// lines or points of the same look go in place (setCurves / setLines / setPoints), anything else
// is shown again. Every item is on user layer 1, which only viewport 1 draws. No geometry: the
// curves, rings, fills and samples are the kernel's (kernel.js drawing()).
//
// Depth does the stacking (the View has no draw order for world items): the grid lies at z = 0,
// and each piece, in `layer` order, gets a band above it -- its fill, then its lines, then its
// seams and their numbers -- so the grid draws under every fill and a higher layer covers (and
// picks over) a lower one. Only the depth changes: every x, y the app reads stays the pattern's.
import { seamColour, seamColourIndex } from "./sewing.js";
import { pointsOf, internalPointsOf, xformHandles } from "./view2d.js";

export const LAYER_2D = 1;
export const ACCENT = "#ff7a1a";
const FOLD = "#e0b050";   // an unfolded piece's fold guide (spec §6)
const LINE = "#d8dce2", HOVER = "#ffffff", INTERNAL = "#b0b6c0", CUT = "#8a9099", GRAIN = "#9aa0aa", LABEL = "#c8ccd4", BG = "#1e2024";
const STATE = { normal: 0, hover: 1, selected: 2, first: 3 };
/** A piece's depths by its rank in layer order: fill, lines, seams (mm above the grid's z = 0).
 *  The first band starts well clear of the grid: the View draws its grid with a depth bias
 *  that let a fill 1 mm above it show the grid through. */
const BAND_BASE = 10;
export const bandOf = (rank) => ({ fill: BAND_BASE + 4 * rank, line: BAND_BASE + 1 + 4 * rank, seam: BAND_BASE + 2 + 4 * rank });
const SEAM_NO_PX = 8;          // a seam's number stands this far out from its seam's middle

const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const toHex = (rgb) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
/** A fabric colour mixed 30 % over the background: opaque, so the lines read over it (ruling 17). */
export const fillColour = (c, k = 0.3) => { const a = hex(c), b = hex(BG); return toHex(a.map((v, i) => b[i] + (v - b[i]) * k)); };

/** Size k of n's outline colour in Show sizes: the accent mixed over the background, 55 % for the
 *  first size up to all of it for the last. */
export const sizeColour = (k, n) => fillColour(ACCENT, n > 1 ? 0.55 + (0.45 * k) / (n - 1) : 1);

// [x0, y0, x1, y1, ...] -> segments x y z x y z, closed when asked
function segs(ring, closed = false, z = 0) {
    const out = [];
    const n = ring.length >> 1;
    for (let i = 0; i + 1 < n; i++) out.push(ring[2 * i], ring[2 * i + 1], z, ring[2 * i + 2], ring[2 * i + 3], z);
    if (closed && n > 2 && (ring[0] !== ring[2 * n - 2] || ring[1] !== ring[2 * n - 1])) out.push(ring[2 * n - 2], ring[2 * n - 1], z, ring[0], ring[1], z);
    return out;
}
const xyz = (pts, z = 0) => pts.flatMap((p) => [p[0], p[1], z]);
// Beziers (x, y, z, w a control point) and a mesh's positions moved to depth z.
function liftBeziers(b, z) { const out = Float64Array.from(b); for (let i = 2; i < out.length; i += 4) out[i] = z; return out; }
// Every triangle is turned to face +z, the 2D camera: a fill whose triangles face away does not
// hide the grid behind it.
function liftMesh(m, z) {
    const p = Float32Array.from(m.positions), t = Uint32Array.from(m.indices);
    for (let i = 2; i < p.length; i += 3) p[i] = z;
    for (let i = 0; i + 2 < t.length; i += 3) {
        const a = 3 * t[i], b = 3 * t[i + 1], c = 3 * t[i + 2];
        if ((p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[b + 1] - p[a + 1]) * (p[c] - p[a]) < 0) [t[i + 1], t[i + 2]] = [t[i + 2], t[i + 1]];
    }
    return { positions: p, indices: t };
}
function inRing(ring, [x, y]) {
    let inside = false;
    for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
        const [xi, yi, xj, yj] = [ring[i], ring[i + 1], ring[j], ring[j + 1]];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}
// The point halfway along a polyline (x, y pairs, along a piece's outline `ring`) and the unit
// normal there out of the piece: the side whose nearby point is not inside the ring (a seam's
// range may run either way along the outline).
function midOut(pts, ring) {
    const n = pts.length >> 1;
    let total = 0;
    for (let i = 0; i + 1 < n; i++) total += Math.hypot(pts[2 * i + 2] - pts[2 * i], pts[2 * i + 3] - pts[2 * i + 1]);
    let left = total / 2;
    for (let i = 0; i + 1 < n; i++) {
        const tx = pts[2 * i + 2] - pts[2 * i], ty = pts[2 * i + 3] - pts[2 * i + 1], l = Math.hypot(tx, ty);
        if (left <= l || i + 2 === n) {
            const t = l > 0 ? Math.min(left / l, 1) : 0, u = l || 1;
            const at = [pts[2 * i] + tx * t, pts[2 * i + 1] + ty * t], n = [ty / u, -tx / u];
            const out = !ring || !inRing(ring, [at[0] + n[0] * 0.5, at[1] + n[1] * 0.5]);
            return { at, normal: out ? n : [-n[0], -n[1]] };
        }
        left -= l;
    }
    return { at: [pts[0], pts[1]], normal: [0, 0] };
}

const ROT_PX = 28, ROT_MM = 20;   // the rotate handle stands this far above the box's top side

// The Move tool's box round the selected pieces (their kernel bounds' union): its frame as lines
// above every piece, and its handles as points on top (view2d.js xformHandles, picked as
// {kind: "xform"}). mmPerPx (the 2D window's scale when drawn) sets the rotate handle's offset.
function xformSpecs(drawings, selection, mmPerPx, z) {
    if (selection?.kind !== "pattern") return [];
    const ids = new Set(selection.ids ?? [selection.id]);
    const bs = drawings.filter((d) => ids.has(d.id) && d.bounds).map((d) => d.bounds);
    if (!bs.length) return [];
    const b = [Math.min(...bs.map((q) => q[0])), Math.min(...bs.map((q) => q[1])), Math.max(...bs.map((q) => q[2])), Math.max(...bs.map((q) => q[3]))];
    const hs = xformHandles(b, mmPerPx > 0 && Number.isFinite(mmPerPx) ? ROT_PX * mmPerPx : ROT_MM);
    const rot = hs.at(-1), top = hs.find((h) => h.handle === "n");
    const frame = [...segs([b[0], b[1], b[2], b[1], b[2], b[3], b[0], b[3]], true, z), top.at[0], top.at[1], z, rot.at[0], rot.at[1], z];
    const sig = JSON.stringify(b) + rot.at[1];
    const what = { kind: "xform", id: selection.id };
    return [
        { key: "xform/box", show: "lines", data: frame, colour: ACCENT, dash: { dash: 4, gap: 3 }, what: { kind: "xformBox", id: selection.id }, sig },
        { key: "xform/scale", show: "points", data: xyz(hs.slice(0, -1).map((h) => h.at), z), colour: ACCENT, size: 9, pointStyle: { shape: "square", hollow: true },
            onTop: true, what: { ...what, handles: hs.slice(0, -1).map((h) => h.handle) }, sig },
        { key: "xform/rot", show: "points", data: xyz([rot.at], z), colour: ACCENT, size: 10, pointStyle: { shape: "disc", hollow: false },
            onTop: true, what: { ...what, handles: ["rot"] }, sig },
    ];
}

// xform: the Move tool is on (its box and handles round the selection); mmPerPx the 2D scale.
// prints(d, band): a piece's prints as specs (prints.js printSpecs), drawn in its band.
// nest: Show sizes' outlines (kernel.js sizeNest), each drawn in the accent's ramp by its size.
export function specs2d({ drawings = [], seams = [], nodes = [], selection = null, pointSel = [], ipointSel = [], hover = null, colours = new Map(), xform = false, mmPerPx = null, prints = null, nest = [] }) {
    const out = [];
    const picked = (id) => selection?.kind === "pattern" && (selection.id === id || selection.ids?.includes(id));
    const ordered = [...drawings].sort((a, b) => (a.layer ?? 0) - (b.layer ?? 0));
    const rank = new Map(ordered.map((d, r) => [d.id, r]));
    for (const [r, d] of ordered.entries()) {
        const id = d.id, sel = picked(id), line = sel ? ACCENT : hover === id ? HOVER : LINE;
        const z = bandOf(r), sig = `${d.sig}@${r}`;
        if (d.fill) out.push({ key: `${id}/fill`, show: "mesh", data: liftMesh(d.fill, z.fill), colour: fillColour(colours.get(d.fabric) ?? "#cccccc"), what: { kind: "fill", id }, sig });
        if (prints) out.push(...prints(d, z));
        const notchAt = xyz((d.notches ?? []).map((n) => [n[0], n[1]]), z.line);
        out.push({ key: `${id}/sew`, show: "curves", data: liftBeziers(d.beziers, z.line), colour: line, what: { kind: "sew", id }, sig, snapPoints: notchAt, snapLabel: "notch" });
        if (d.cut?.length >= 4) out.push({ key: `${id}/cut`, show: "lines", data: segs(d.cut, true, z.line), colour: CUT, dash: { dash: 4, gap: 4 }, what: { kind: "cut", id }, sig });
        (d.holes ?? []).forEach((h, k) => {
            out.push({ key: `${id}/hole/${k}`, show: "curves", data: liftBeziers(h.beziers, z.line), colour: line, what: { kind: "hole", id, index: k }, sig });
            h.cut.forEach((c, j) => out.push({ key: `${id}/holecut/${k}/${j}`, show: "lines", data: segs(c, true, z.line), colour: CUT, dash: { dash: 4, gap: 4 }, what: { kind: "cut", id }, sig }));
        });
        (d.internal ?? []).forEach((l, k) => out.push({
            key: `${id}/internal/${k}`, show: "curves", data: liftBeziers(l.beziers, z.line), colour: sel ? ACCENT : INTERNAL,
            dash: l.kind === "fold" ? { dash: 6, gap: 4 } : null, what: { kind: "internal", id, index: k }, sig,
        }));
        // each notch's mark, the kernel's polyline (garment_pattern_notch_lines): a lines item each,
        // picked as that notch; the selected one in the accent
        (d.notchLines ?? []).forEach((pl, k) => {
            const on = selection?.kind === "notch" && selection.id === id && selection.index === k;
            out.push({ key: `${id}/notch/${k}`, show: "lines", data: segs(pl, false, z.line), colour: on ? ACCENT : line, what: { kind: "notch", id, index: k }, sig });
        });
        // an unfolded piece's fold (spec §6): a dashed guide, not an internal fold line
        if (d.fold?.length === 4) out.push({ key: `${id}/fold`, show: "lines", data: [d.fold[0], d.fold[1], z.line, d.fold[2], d.fold[3], z.line], colour: FOLD, dash: { dash: 8, gap: 5 }, what: { kind: "fold", id }, sig });
        if (d.grain?.length >= 4) {
            const g = d.grain;
            out.push({ key: `${id}/grain`, show: "lines", data: [g[0], g[1], z.line, g[2], g[3], z.line], colour: GRAIN, what: { kind: "grain", id }, sig });
            out.push({ key: `${id}/grainhead`, show: "glyphs", data: [g[2], g[3], z.line], colour: GRAIN, glyph: { kind: "arrow", dir: [g[2] - g[0], g[3] - g[1], 0], sizePt: 10 }, what: { kind: "grain", id }, sig });
        }
        // Show sizes (A3 spec §5): every other size's outline, thin and dashed, in a ramp of the
        // accent from the smallest size (faint) to the largest; the current size is the outline itself, solid
        for (const g of nest) if (g.id === id) out.push({ key: `${id}/size/${g.size}`, show: "curves", data: liftBeziers(g.beziers, z.line), colour: sizeColour(g.k, g.n), dash: { dash: 4, gap: 2 }, onTop: true,
            what: { kind: "sizes", id, size: g.size }, sig: `${Array.from(g.beziers).join(",")}@${r}` });
        if (d.label && d.bounds) out.push({ key: `${id}/label`, show: "text", text: d.label, data: [(d.bounds[0] + d.bounds[2]) / 2, (d.bounds[1] + d.bounds[3]) / 2, z.line], colour: LABEL, size: 12, what: { kind: "label", id }, sig: d.label + sig });
        // the edit points: not under the Move tool, whose handles would share a rectangle's corners
        if (!xform && selection?.kind === "pattern" && selection.id === id) {
            const p = pointsOf(nodes, id);
            const chosen = new Set(pointSel);
            out.push({ key: `${id}/points`, show: "points", data: xyz(p.points, z.seam), colour: "#ffffff", size: 8, pointStyle: { shape: "square", hollow: false },
                states: p.points.map((_, i) => (chosen.has(i) ? STATE.selected : STATE.normal)), onTop: true, what: { kind: "points", id }, sig: JSON.stringify(p.points) + r });
            if (p.handles.length) {
                const tangents = p.handles.flatMap((h) => [h.from, h.to].filter((i) => i !== undefined).flatMap((i) => [p.points[i][0], p.points[i][1], z.seam, h.at[0], h.at[1], z.seam]));
                out.push({ key: `${id}/tangents`, show: "lines", data: tangents, colour: ACCENT, onTop: true, what: { kind: "tangents", id, handles: p.handles, points: p.points }, sig: JSON.stringify(tangents) });
                out.push({ key: `${id}/handles`, show: "points", data: xyz(p.handles.map((h) => h.at), z.seam), colour: ACCENT, size: 7, pointStyle: { shape: "diamond", hollow: false },
                    onTop: true, what: { kind: "handles", id, handles: p.handles }, sig: JSON.stringify(p.handles) + r });
            }
            // the internal lines' points (hollow) and handles: dragged by the Edit tool (spec §4)
            const ip = internalPointsOf(nodes, id);
            if (ip.points.length) {
                const at = ip.points.map((q) => q.at);
                const ichosen = new Set(ipointSel.map((q) => `${q.line}:${q.index}`));
                out.push({ key: `${id}/ipoints`, show: "points", data: xyz(at, z.seam), colour: "#ffffff", size: 7, pointStyle: { shape: "square", hollow: true },
                    states: ip.points.map((q) => (ichosen.has(`${q.line}:${q.index}`) ? STATE.selected : STATE.normal)), onTop: true, what: { kind: "ipoints", id, refs: ip.points.map(({ line, index }) => ({ line, index })) }, sig: JSON.stringify(at) + r });
                if (ip.handles.length) {
                    const tangents = ip.handles.flatMap((h) => [h.from, h.to].filter((i) => i !== undefined).flatMap((i) => [at[i][0], at[i][1], z.seam, h.at[0], h.at[1], z.seam]));
                    if (tangents.length) out.push({ key: `${id}/itangents`, show: "lines", data: tangents, colour: ACCENT, onTop: true, what: { kind: "itangents", id, handles: ip.handles, points: at }, sig: JSON.stringify(tangents) });
                    out.push({ key: `${id}/ihandles`, show: "points", data: xyz(ip.handles.map((h) => h.at), z.seam), colour: ACCENT, size: 6, pointStyle: { shape: "diamond", hollow: true },
                        onTop: true, what: { kind: "ihandles", id, handles: ip.handles }, sig: JSON.stringify(ip.handles) + r });
                }
            }
        }
    }
    if (xform) out.push(...xformSpecs(drawings, selection, mmPerPx, bandOf(ordered.length).seam));
    const byId = new Map(drawings.map((d) => [d.id, d]));
    // an M:N group's members share their first member's colour and number, numbered n.1, n.2, ...
    const index = seamColourIndex(seams);
    seams.forEach((s, i) => {
        // seams are select-only for colour this round: no hover recolour (hover2d is a piece id)
        const on = selection?.kind === "seam" && (selection.id === s.id || !!selection.ids?.includes(s.id));
        const colour = on ? ACCENT : seamColour(index[i]);
        const no = s.group ? `${index[i] + 1}.${(s.member ?? 0) + 1}` : String(i + 1);
        for (const [end, pts, pattern] of [["a", s.points_a, s.a], ["b", s.points_b, s.b]]) {
            if (!pts || pts.length < 4) continue;
            const r = rank.get(pattern) ?? 0;
            out.push({ key: `seam/${s.id}/${end}`, show: "lines", data: segs(pts, false, bandOf(r).seam), colour, what: { kind: "seam", id: s.id, pattern }, sig: `${byId.get(pattern)?.sig}@${r}|${pts.length}|${pts[0]},${pts[1]},${pts.at(-2)},${pts.at(-1)}` });
        }
        if (s.points_a?.length >= 4) {
            // the number stands out from the seam's middle, along the normal out of piece a, over a
            // box of the background so it reads over any line
            const r = rank.get(s.a) ?? 0;
            const { at, normal: [nx, ny] } = midOut(s.points_a, byId.get(s.a)?.sew);
            const offset = [Math.round(SEAM_NO_PX * nx * 10) / 10 + 0, Math.round(SEAM_NO_PX * ny * 10) / 10 + 0];   // the View's offset y runs up the screen
            out.push({ key: `seam/${s.id}/no`, show: "text", text: no, data: [at[0], at[1], bandOf(r).seam], colour, size: 12,
                offset, box: BG, padding: 1, what: { kind: "seam", id: s.id, pattern: s.a }, sig: `${no}@${at[0]},${at[1]}@${r}` });
        }
    });
    return out.filter((s) => s.show === "text" || (s.data && (s.data.length ?? s.data.indices?.length) > 0));
}

const IN_PLACE = { curves: "setCurves", lines: "setLines", points: "setPoints" };
const lookOf = (s) => JSON.stringify([s.dash ?? null, s.size ?? null, s.pointStyle ?? null, !!s.onTop, s.glyph?.kind ?? null, s.glyph?.sizePt ?? null, s.offset ?? null, s.box ?? null, s.padding ?? null]);
const snapSig = (s) => (s.snapPoints?.length ? `${s.snapLabel}:${Array.from(s.snapPoints).join(",")}` : "");

export class Items2d {
    // `gen` counts the items shown and removed: a pick answered across a change names an item
    // that may be gone (pointer2d.js picks again then)
    constructor(viewer, layer = LAYER_2D) { this.v = viewer; this.layer = layer; this.byKey = new Map(); this.map = new Map(); this.gen = 0; }
    what(item) { return this.map.get(item) ?? null; }
    item(key) { return this.byKey.get(key)?.item ?? 0; }
    clear() { for (const key of [...this.byKey.keys()]) this.drop(key); }
    drop(key) {
        const e = this.byKey.get(key);
        if (!e) return;
        this.v.remove(e.item);
        this.map.delete(e.item);
        this.byKey.delete(key);
        this.gen++;
    }
    apply(specs) {
        const keep = new Set();
        for (const s of specs) {
            keep.add(s.key);
            const e = this.byKey.get(s.key);
            const same = e && e.show === s.show && e.look === lookOf(s);
            if (same && (e.sig === s.sig || IN_PLACE[s.show])) {
                if (e.sig !== s.sig) { this.v[IN_PLACE[s.show]](e.item, s.data); e.sig = s.sig; }
                if (e.colour !== s.colour) { this.v.setColour(e.item, s.colour); e.colour = s.colour; }
                if (s.states && e.states !== String(s.states)) { this.v.setPointStates(e.item, Uint8Array.from(s.states)); e.states = String(s.states); }
                if (snapSig(s) !== e.snap) { this.v.setSnapPoints(e.item, s.snapPoints ?? [], s.snapLabel ?? null); e.snap = snapSig(s); }
                this.map.set(e.item, s.what);
                continue;
            }
            if (same && s.show === "text" && e.sig !== s.sig && e.at === String(s.data)) {
                this.v.setText(e.item, s.text); e.sig = s.sig;
                if (e.colour !== s.colour) { this.v.setColour(e.item, s.colour); e.colour = s.colour; }
                this.map.set(e.item, s.what); continue;
            }
            if (e) this.drop(s.key);
            this.show(s);
        }
        for (const key of [...this.byKey.keys()]) if (!keep.has(key)) this.drop(key);
    }
    show(s) {
        const v = this.v;
        let item;
        switch (s.show) {
            case "curves": item = v.showCurves(s.data, s.colour); break;
            case "lines": item = v.showLines(s.data, s.colour); break;
            case "points": item = v.showPoints(s.data, s.colour, s.size ?? 8); break;
            case "mesh": item = v.showMesh({ positions: s.data.positions, indices: s.data.indices, colour: s.colour }); break;
            // a print (prints.js): its corners and decoded pixels
            case "image": item = v.showImage({ corners: s.corners, bitmap: s.bitmap }); break;
            case "glyphs": item = v.showGlyphs(s.data, { kind: s.glyph.kind, sizePt: s.glyph.sizePt ?? 10, colour: s.colour, dir: s.glyph.dir ?? null }); break;
            case "text": {
                const o = { at: s.data, size: s.size ?? 12, colour: s.colour, align: "centre" };
                if (s.offset) o.offset = s.offset;
                if (s.box) { o.box = s.box; o.padding = s.padding ?? 0; }
                item = v.showText(s.text, o);
                break;
            }
            default: throw new Error(`scene2d: no show ${s.show}`);
        }
        v.setItemLayer(item, this.layer);
        if (s.dash) v.setLineStyle(item, s.dash);
        if (s.pointStyle) v.setPointStyle(item, s.pointStyle);
        if (s.states) v.setPointStates(item, Uint8Array.from(s.states));
        if (s.onTop) v.setOnTop(item, true);
        if (s.snapPoints?.length) v.setSnapPoints(item, s.snapPoints, s.snapLabel ?? null);
        this.byKey.set(s.key, { item, show: s.show, sig: s.sig, colour: s.colour, look: lookOf(s), states: s.states ? String(s.states) : null, snap: snapSig(s), at: String(s.data) });
        this.map.set(item, s.what);
        this.gen++;
    }
}

// What a tool draws while it works: dashed lines, points, a curve (the ellipse being dragged) and
// a read-out text, one item each, made on first use, hidden when empty, always on top; and the
// Ruler's labels, a text each over a box of the background, shown again when they change.
export class Overlay2d {
    constructor(viewer, layer = LAYER_2D) { this.v = viewer; this.layer = layer; this.items = {}; this.text = null; this.labels = []; this.labelSig = "[]"; }
    setLabels(labels) {
        const sig = JSON.stringify(labels);
        if (sig === this.labelSig) return;
        this.labelSig = sig;
        for (const id of this.labels) this.v.remove(id);
        this.labels = labels.map((l) => {
            const id = this.v.showText(l.text, { at: [l.at[0], l.at[1], 0], size: 12, colour: ACCENT, align: "centre", offset: [0, 10], box: BG, padding: 1, onTop: true });
            this.v.setItemLayer(id, this.layer);
            return id;
        });
    }
    put(kind, data, show, set) {
        const v = this.v;
        let id = this.items[kind];
        if (!data.length) { if (id) v.setItemVisible(id, false); return; }
        if (!id) {
            id = this.items[kind] = show(data);
            v.setItemLayer(id, this.layer);
            v.setOnTop(id, true);
            if (kind !== "points") v.setLineStyle(id, { dash: 5, gap: 3 });
        } else { v[set](id, data); v.setItemVisible(id, true); }
    }
    set({ lines = [], points = [], curves = null, labels = [], text = null } = {}) {
        const v = this.v;
        this.setLabels(labels);
        this.put("lines", lines.flatMap((pl) => segs(pl.flat())), (d) => v.showLines(d, ACCENT), "setLines");
        this.put("points", xyz(points), (d) => v.showPoints(d, ACCENT, 8), "setPoints");
        this.put("curves", curves ? Array.from(curves) : [], (d) => v.showCurves(d, ACCENT), "setCurves");
        // the read-out changes every pointer move: same anchor, setText; a new anchor, shown again
        const at = text?.text ? `${text.at[0]},${text.at[1]}` : null;
        if (this.text && at === this.textAt) {
            if (text.text !== this.textNow) { v.setText(this.text, text.text); this.textNow = text.text; }
            return;
        }
        if (this.text) { v.remove(this.text); this.text = null; }
        this.textAt = at; this.textNow = text?.text ?? null;
        if (at) {
            this.text = v.showText(text.text, { at: [text.at[0], text.at[1], 0], size: 12, colour: ACCENT, align: "bottom-left", offset: [12, 12], onTop: true });
            v.setItemLayer(this.text, this.layer);
        }
    }
}
