// The 2D window's scene. specs2d turns the garment into item specs -- what to show, its data,
// colour, style and what a pick on it means -- and Items2d makes the View match them: an item
// whose data and look are unchanged is left alone, a colour change is a setColour, new curves,
// lines or points of the same look go in place (setCurves / setLines / setPoints), anything else
// is shown again. Every item is on user layer 1, which only viewport 1 draws. No geometry: the
// curves, rings, fills and samples are the kernel's (kernel.js drawing()).
import { seamColour } from "./sewing.js";
import { pointsOf, notchNormals } from "./view2d.js";

export const LAYER_2D = 1;
export const ACCENT = "#ff7a1a";
const LINE = "#d8dce2", HOVER = "#ffffff", INTERNAL = "#b0b6c0", CUT = "#8a9099", GRAIN = "#9aa0aa", LABEL = "#c8ccd4", BG = "#1e2024";
const STATE = { normal: 0, hover: 1, selected: 2, first: 3 };

const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const toHex = (rgb) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
/** A fabric colour mixed 30 % over the background: opaque, so the lines read over it (ruling 17). */
export const fillColour = (c, k = 0.3) => { const a = hex(c), b = hex(BG); return toHex(a.map((v, i) => b[i] + (v - b[i]) * k)); };

// [x0, y0, x1, y1, ...] -> segments x y 0 x y 0, closed when asked
function segs(ring, closed = false) {
    const out = [];
    const n = ring.length >> 1;
    for (let i = 0; i + 1 < n; i++) out.push(ring[2 * i], ring[2 * i + 1], 0, ring[2 * i + 2], ring[2 * i + 3], 0);
    if (closed && n > 2 && (ring[0] !== ring[2 * n - 2] || ring[1] !== ring[2 * n - 1])) out.push(ring[2 * n - 2], ring[2 * n - 1], 0, ring[0], ring[1], 0);
    return out;
}
const xyz = (pts) => pts.flatMap((p) => [p[0], p[1], 0]);

export function specs2d({ drawings = [], seams = [], nodes = [], selection = null, pointSel = [], hover = null, colours = new Map() }) {
    const out = [];
    const picked = (id) => selection?.kind === "pattern" && (selection.id === id || selection.ids?.includes(id));
    const ordered = [...drawings].sort((a, b) => (a.layer ?? 0) - (b.layer ?? 0));
    for (const d of ordered) {
        const id = d.id, sel = picked(id), line = sel ? ACCENT : hover === id ? HOVER : LINE;
        if (d.fill) out.push({ key: `${id}/fill`, show: "mesh", data: d.fill, colour: fillColour(colours.get(d.fabric) ?? "#cccccc"), what: { kind: "fill", id }, sig: d.sig });
        const notchAt = xyz((d.notches ?? []).map((n) => [n[0], n[1]]));
        out.push({ key: `${id}/sew`, show: "curves", data: d.beziers, colour: line, what: { kind: "sew", id }, sig: d.sig, snapPoints: notchAt, snapLabel: "notch" });
        if (d.cut?.length >= 4) out.push({ key: `${id}/cut`, show: "lines", data: segs(d.cut, true), colour: CUT, dash: { dash: 4, gap: 4 }, what: { kind: "cut", id }, sig: d.sig });
        (d.holes ?? []).forEach((h, k) => {
            out.push({ key: `${id}/hole/${k}`, show: "curves", data: h.beziers, colour: line, what: { kind: "hole", id, index: k }, sig: d.sig });
            h.cut.forEach((c, j) => out.push({ key: `${id}/holecut/${k}/${j}`, show: "lines", data: segs(c, true), colour: CUT, dash: { dash: 4, gap: 4 }, what: { kind: "cut", id }, sig: d.sig }));
        });
        (d.internal ?? []).forEach((l, k) => out.push({
            key: `${id}/internal/${k}`, show: "curves", data: l.beziers, colour: sel ? ACCENT : INTERNAL,
            dash: l.kind === "fold" ? { dash: 6, gap: 4 } : null, what: { kind: "internal", id, index: k }, sig: d.sig,
        }));
        if (notchAt.length) {
            const dir = xyz(notchNormals(d));
            out.push({ key: `${id}/notches`, show: "glyphs", data: notchAt, colour: line, glyph: { kind: "tick", dir, sizePt: 10 }, what: { kind: "notch", id }, sig: d.sig });
        }
        if (d.grain?.length >= 4) {
            const g = d.grain;
            out.push({ key: `${id}/grain`, show: "lines", data: [g[0], g[1], 0, g[2], g[3], 0], colour: GRAIN, what: { kind: "grain", id }, sig: d.sig });
            out.push({ key: `${id}/grainhead`, show: "glyphs", data: [g[2], g[3], 0], colour: GRAIN, glyph: { kind: "arrow", dir: [g[2] - g[0], g[3] - g[1], 0], sizePt: 10 }, what: { kind: "grain", id }, sig: d.sig });
        }
        if (d.label && d.bounds) out.push({ key: `${id}/label`, show: "text", text: d.label, data: [(d.bounds[0] + d.bounds[2]) / 2, (d.bounds[1] + d.bounds[3]) / 2, 0], colour: LABEL, size: 12, what: { kind: "label", id }, sig: d.label + d.sig });
        if (selection?.kind === "pattern" && selection.id === id) {
            const p = pointsOf(nodes, id);
            const chosen = new Set(pointSel);
            out.push({ key: `${id}/points`, show: "points", data: xyz(p.points), colour: "#ffffff", size: 8, pointStyle: { shape: "square", hollow: false },
                states: p.points.map((_, i) => (chosen.has(i) ? STATE.selected : STATE.normal)), onTop: true, what: { kind: "points", id }, sig: JSON.stringify(p.points) });
            if (p.handles.length) {
                const tangents = p.handles.flatMap((h) => [h.from, h.to].filter((i) => i !== undefined).flatMap((i) => [p.points[i][0], p.points[i][1], 0, h.at[0], h.at[1], 0]));
                out.push({ key: `${id}/tangents`, show: "lines", data: tangents, colour: ACCENT, onTop: true, what: { kind: "tangents", id }, sig: JSON.stringify(tangents) });
                out.push({ key: `${id}/handles`, show: "points", data: xyz(p.handles.map((h) => h.at)), colour: ACCENT, size: 7, pointStyle: { shape: "diamond", hollow: false },
                    onTop: true, what: { kind: "handles", id, handles: p.handles }, sig: JSON.stringify(p.handles) });
            }
        }
    }
    const byId = new Map(drawings.map((d) => [d.id, d]));
    seams.forEach((s, i) => {
        // seams are select-only for colour this round: no hover recolour (hover2d is a piece id)
        const colour = selection?.kind === "seam" && selection.id === s.id ? ACCENT : seamColour(i);
        for (const [end, pts, pattern] of [["a", s.points_a, s.a], ["b", s.points_b, s.b]]) {
            if (!pts || pts.length < 4) continue;
            out.push({ key: `seam/${s.id}/${end}`, show: "lines", data: segs(pts), colour, what: { kind: "seam", id: s.id, pattern }, sig: `${byId.get(pattern)?.sig}|${pts.length}|${pts[0]},${pts[1]},${pts.at(-2)},${pts.at(-1)}` });
        }
        if (s.points_a?.length >= 4) {
            const mid = (s.points_a.length >> 2) * 2;
            out.push({ key: `seam/${s.id}/no`, show: "text", text: String(i + 1), data: [s.points_a[mid], s.points_a[mid + 1], 0], colour, size: 11, what: { kind: "seam", id: s.id, pattern: s.a }, sig: `${i + 1}@${s.points_a[mid]},${s.points_a[mid + 1]}` });
        }
    });
    return out.filter((s) => s.show === "text" || (s.data && (s.data.length ?? s.data.indices?.length) > 0));
}

const IN_PLACE = { curves: "setCurves", lines: "setLines", points: "setPoints" };
const lookOf = (s) => JSON.stringify([s.dash ?? null, s.size ?? null, s.pointStyle ?? null, !!s.onTop, s.glyph?.kind ?? null, s.glyph?.sizePt ?? null]);
const snapSig = (s) => (s.snapPoints?.length ? `${s.snapLabel}:${Array.from(s.snapPoints).join(",")}` : "");

export class Items2d {
    constructor(viewer, layer = LAYER_2D) { this.v = viewer; this.layer = layer; this.byKey = new Map(); this.map = new Map(); }
    what(item) { return this.map.get(item) ?? null; }
    item(key) { return this.byKey.get(key)?.item ?? 0; }
    clear() { for (const key of [...this.byKey.keys()]) this.drop(key); }
    drop(key) {
        const e = this.byKey.get(key);
        if (!e) return;
        this.v.remove(e.item);
        this.map.delete(e.item);
        this.byKey.delete(key);
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
            case "glyphs": item = v.showGlyphs(s.data, { kind: s.glyph.kind, sizePt: s.glyph.sizePt ?? 10, colour: s.colour, dir: s.glyph.dir ?? null }); break;
            case "text": item = v.showText(s.text, { at: s.data, size: s.size ?? 12, colour: s.colour, align: "centre" }); break;
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
    }
}

// What a tool draws while it works: dashed lines, points, a curve (the ellipse being dragged) and
// a read-out text, one item each, made on first use, hidden when empty, always on top.
export class Overlay2d {
    constructor(viewer, layer = LAYER_2D) { this.v = viewer; this.layer = layer; this.items = {}; this.text = null; }
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
    set({ lines = [], points = [], curves = null, text = null } = {}) {
        const v = this.v;
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
            this.text = v.showText(text.text, { at: [text.at[0], text.at[1], 0], size: 12, colour: ACCENT, align: "bottom-left", offset: [12, -12], onTop: true });
            v.setItemLayer(this.text, this.layer);
        }
    }
}
