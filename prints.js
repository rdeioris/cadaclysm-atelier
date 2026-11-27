// Prints: images placed on a piece (a chest logo), drawn over the fabric in 2D and on the
// cloth in 3D. Each piece keeps its list in its garment.pattern node's meta.atelier.prints:
//   [{ id, image, at: [x, y], rotation_deg, width_mm }]
// `at` is the print's centre in mm from the outline's start point (a piece moved in 2D carries
// its prints), `image` a user image's id (materials.js: the document's meta keeps its bytes),
// the height `width_mm` times the image's aspect. Later prints draw over earlier ones.
//
// In 3D each piece's prints become one atlas: an RGBA image over the piece's bounds (in mm
// from the outline's start), composed here in plain JS, and the cloth's decal. Pure except
// decodeImage / encodeAtlas (the worker's canvas).
import { printsOf, unusedImageOps } from "./materials.js";

export { printsOf };
export const PRINT_WIDTH = 100;       // a placed print's width, mm
export const ATLAS_MAX = 1024;        // px a side: the View's largest layer (textures::MAX_LAYER)
export const ATLAS_PX_PER_MM = 2;
const HANDLE_PX = 8, ROT_PX = 28, ROT_SNAP = 15;
const LABEL = "#c8ccd4", BG = "#1e2024";

const find = (nodes, id) => nodes.find((n) => n.id === id);
// A piece's outline start (the origin of its prints' `at`).
export function startOf(nodes, id) {
    const p = find(nodes, id);
    return find(nodes, p?.outline ?? `${id}_outline`)?.path?.start ?? [0, 0];
}
// A print's [width, height] in mm: the height from the image's aspect (square when unknown).
export function printSize(print, image) {
    const aspect = image?.width > 0 && image?.height > 0 ? image.height / image.width : 1;
    return [print.width_mm, print.width_mm * aspect];
}
// The print's corners, bottom-left, bottom-right, top-right, top-left (showImage's order), in
// the pattern plane: its centre `start + at`, turned counter-clockwise by rotation_deg.
export function printCorners(print, start, image) {
    const [w, h] = printSize(print, image);
    const a = ((print.rotation_deg ?? 0) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    const cx = start[0] + print.at[0], cy = start[1] + print.at[1];
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j]) => [cx + (i * w * c) / 2 - (j * h * s) / 2, cy + (i * w * s) / 2 + (j * h * c) / 2]);
}
// Whether pattern point `p` lies on the print.
export function onPrint(p, print, start, image) {
    const [w, h] = printSize(print, image);
    const a = ((print.rotation_deg ?? 0) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    const dx = p[0] - start[0] - print.at[0], dy = p[1] - start[1] - print.at[1];
    return Math.abs(c * dx + s * dy) <= w / 2 && Math.abs(-s * dx + c * dy) <= h / 2;
}

// The ops setting piece `patternId`'s prints to `prints` (one batch; the rest of its meta, the
// slot and the anchors, kept; an empty list drops the key); an image no print or fabric names
// any longer is removed from the document in the same batch.
export function printOps(nodes, patternId, prints) {
    const n = find(nodes, patternId);
    if (!n || n.kind !== "garment.pattern") throw new Error(`no piece ${patternId}`);
    const meta = n.meta ?? {}, atelier = { ...(meta.atelier ?? {}) };
    if (prints.length) atelier.prints = prints.map((p) => ({ id: p.id, image: p.image, at: [p.at[0], p.at[1]], rotation_deg: p.rotation_deg ?? 0, width_mm: p.width_mm }));
    else delete atelier.prints;
    const ops = [{ op: "set", id: patternId, fields: { meta: { ...meta, atelier } } }];
    return [...ops, ...unusedImageOps(nodes, ops)];
}
// A print id free across the document: pr1, pr2, ...
export function nextPrintId(nodes) {
    let max = 0;
    for (const n of nodes) for (const p of printsOf(n)) { const m = /^pr(\d+)$/.exec(p.id ?? ""); if (m) max = Math.max(max, Number(m[1])); }
    return `pr${max + 1}`;
}

// ---- the atlas -----------------------------------------------------------------------------------
// The atlas's resolution: ATLAS_PX_PER_MM, less where the piece would pass ATLAS_MAX a side.
export const atlasPxPerMm = (bounds) => Math.min(ATLAS_PX_PER_MM, ATLAS_MAX / Math.max(bounds[2] - bounds[0], bounds[3] - bounds[1], 1e-9));

// The piece's prints composed over `boundsMm` ([x0, y0, x1, y1], mm from the outline's start):
// each print inverse-mapped through its placement, sampled bilinearly, laid "over" the ones
// before it (straight alpha). Row 0 is the piece's top (y1): a point's print UV is
// u = (x - x0) / bw, v = (y1 - y) / bh (printUvs), the View's v-down rule. `images` maps an
// image id to its decoded { rgba, width, height } (rows top first); a print whose image is
// not there is left out. -> { rgba, width, height, pxPerMm }
export function composeAtlas(boundsMm, prints, images) {
    const [x0, y0, x1, y1] = boundsMm, bw = x1 - x0, bh = y1 - y0;
    const ppm = atlasPxPerMm(boundsMm);
    const W = Math.max(1, Math.ceil(bw * ppm)), H = Math.max(1, Math.ceil(bh * ppm));
    const sx = W / bw, sy = H / bh;
    const out = new Uint8Array(W * H * 4);
    for (const print of prints) {
        const img = images?.get?.(print.image);
        if (!img?.rgba || !(img.width > 0) || !(img.height > 0)) continue;
        const [pw, ph] = printSize(print, img);
        const a = ((print.rotation_deg ?? 0) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
        // the print's pixel box in the atlas, from its corners
        const corners = printCorners(print, [0, 0], img);
        const is = corners.map((p) => (p[0] - x0) * sx), js = corners.map((p) => (y1 - p[1]) * sy);
        const i0 = Math.max(0, Math.floor(Math.min(...is))), i1 = Math.min(W - 1, Math.ceil(Math.max(...is)));
        const j0 = Math.max(0, Math.floor(Math.min(...js))), j1 = Math.min(H - 1, Math.ceil(Math.max(...js)));
        const IW = img.width, IH = img.height, src = img.rgba;
        for (let j = j0; j <= j1; j++) {
            const y = y1 - (j + 0.5) / sy;
            for (let i = i0; i <= i1; i++) {
                const x = x0 + (i + 0.5) / sx;
                const dx = x - print.at[0], dy = y - print.at[1];
                const px = c * dx + s * dy, py = -s * dx + c * dy;
                // image coordinates, pixel units, row 0 the image's top (+py)
                const u = (px / pw + 0.5) * IW, v = (0.5 - py / ph) * IH;
                if (u < 0 || u >= IW || v < 0 || v >= IH) continue;
                const sample = bilinear(src, IW, IH, u - 0.5, v - 0.5);
                over(out, 4 * (j * W + i), sample);
            }
        }
    }
    return { rgba: out, width: W, height: H, pxPerMm: ppm };
}
// A straight-alpha sample at (fx, fy) (pixel centres at whole numbers), interpolated
// premultiplied, edges clamped. -> [r, g, b, a] in 0..1
function bilinear(src, W, H, fx, fy) {
    const xa = Math.floor(fx), ya = Math.floor(fy), tx = fx - xa, ty = fy - ya;
    const cl = (v, n) => (v < 0 ? 0 : v >= n ? n - 1 : v);
    let r = 0, g = 0, b = 0, al = 0;
    for (const [xi, yi, w] of [[xa, ya, (1 - tx) * (1 - ty)], [xa + 1, ya, tx * (1 - ty)], [xa, ya + 1, (1 - tx) * ty], [xa + 1, ya + 1, tx * ty]]) {
        if (!w) continue;
        const k = 4 * (cl(yi, H) * W + cl(xi, W)), A = (src[k + 3] / 255) * w;
        r += (src[k] / 255) * A; g += (src[k + 1] / 255) * A; b += (src[k + 2] / 255) * A; al += A;
    }
    return al > 0 ? [r / al, g / al, b / al, al] : [0, 0, 0, 0];
}
// `src` (straight, 0..1) over the atlas pixel at `k` (straight bytes).
function over(dst, k, [r, g, b, a]) {
    if (a <= 0) return;
    const da = dst[k + 3] / 255, oa = a + da * (1 - a);
    const mix = (s, d) => Math.round(((s * a + (d / 255) * da * (1 - a)) / oa) * 255);
    dst[k] = mix(r, dst[k]); dst[k + 1] = mix(g, dst[k + 1]); dst[k + 2] = mix(b, dst[k + 2]);
    dst[k + 3] = Math.round(oa * 255);
}

// Each piece's bounds in mm from its outline start, over its sim vertices' links (the exact
// pattern positions, two a vertex): [x0, y0, x1, y1] per pattern index, null for a piece with none.
export function pieceBounds(links, vertexPatterns, starts, count) {
    const out = Array.from({ length: count }, () => null);
    for (let v = 0; v < vertexPatterns.length; v++) {
        const p = vertexPatterns[v], x = links[2 * v] - starts[2 * p], y = links[2 * v + 1] - starts[2 * p + 1];
        const b = out[p];
        if (!b) out[p] = [x, y, x, y];
        else { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); }
    }
    return out;
}
// The decal UVs, a pair per sim vertex: its piece-local point in its piece's atlas bounds
// (`bounds` per pattern index; a piece with none gets 0, 0 and draws no decal).
export function printUvs(links, vertexPatterns, starts, bounds) {
    const out = new Float32Array(vertexPatterns.length * 2);
    for (let v = 0; v < vertexPatterns.length; v++) {
        const p = vertexPatterns[v], b = bounds[p];
        if (!b) continue;
        const x = links[2 * v] - starts[2 * p], y = links[2 * v + 1] - starts[2 * p + 1];
        out[2 * v] = (x - b[0]) / (b[2] - b[0] || 1);
        out[2 * v + 1] = (b[3] - y) / (b[3] - b[1] || 1);
    }
    return out;
}

// ---- the worker's canvas --------------------------------------------------------------------------
// Image bytes decoded to straight RGBA (rows top first). -> { rgba, width, height }
export async function decodeImage(bytes, mime = "image/png") {
    const bmp = await createImageBitmap(new Blob([bytes], { type: mime }), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
    try {
        const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext("2d");
        g.drawImage(bmp, 0, 0);
        const d = g.getImageData(0, 0, bmp.width, bmp.height);
        return { rgba: new Uint8Array(d.data.buffer), width: bmp.width, height: bmp.height };
    } finally { bmp.close?.(); }
}
// An atlas (composeAtlas's) as PNG bytes, for the View.
export async function encodeAtlas({ rgba, width, height }) {
    const c = new OffscreenCanvas(width, height);
    c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), width, height), 0, 0);
    return new Uint8Array(await (await c.convertToBlob({ type: "image/png" })).arrayBuffer());
}

// ---- 2D ------------------------------------------------------------------------------------------
// The size label: "100.0 × 62.5 mm".
export const sizeText = (print, image) => { const [w, h] = printSize(print, image); return `${w.toFixed(1)} × ${h.toFixed(1)} mm`; };
// Drawing `d`'s prints as scene2d specs: each an image item between the piece's fill and its
// lines, and its size label under it. `bitmapOf(id)` -> the decoded image, or null while it
// decodes (that print waits). A pick on either reads as the piece.
export function printSpecs(d, nodes, bitmapOf, z) {
    const node = find(nodes, d.id), prints = printsOf(node);
    if (!prints.length) return [];
    const start = startOf(nodes, d.id), zi = z.fill + 0.5, out = [];
    for (const p of prints) {
        const img = bitmapOf(p.image);
        if (!img) continue;
        const corners = printCorners(p, start, img);
        const sig = `${JSON.stringify(p)}@${start}@${zi}`;
        out.push({ key: `${d.id}/print/${p.id}`, show: "image", data: corners.flatMap((q) => [q[0], q[1], zi]), corners: corners.map((q) => [q[0], q[1], zi]),
            bitmap: { rgba: img.rgba, width: img.width, height: img.height }, colour: null, what: { kind: "fill", id: d.id }, sig });
        const bottom = [(corners[0][0] + corners[1][0]) / 2, (corners[0][1] + corners[1][1]) / 2];
        out.push({ key: `${d.id}/print/${p.id}/size`, show: "text", text: sizeText(p, img), data: [bottom[0], bottom[1], z.line], colour: LABEL, size: 11,
            offset: [0, -10], box: BG, padding: 1, what: { kind: "fill", id: d.id }, sig: sizeText(p, img) + sig });
    }
    return out;
}

// ---- the Print tool ------------------------------------------------------------------------------
// tools.js's gesture shape (down / move / up / key). ctx as tools.js's, plus `images` (the
// document's images: { id: { name, width, height } }) and `keep` (kept while the tool stays
// armed): keep.printNext is the image picked to place ({ id, op, width, height, name }: `op`
// stores it, from materials.js importImage), keep.print the selected print { pattern, id }.
// - With an image picked, a click on a piece places it there: PRINT_WIDTH mm wide, centred.
// - A press on a print selects it and drags it; on its corner handles it scales (the aspect
//   kept, about the centre), on the handle above it it turns (15 degree steps with Shift).
// - Delete or Backspace removes the selected print; Escape lets it go and ends the tool.
// A drag is a preview (the 2D items move; the cloth's atlas waits for the commit), its release
// one commit.
export function printTool(ctx) {
    const keep = ctx.keep ?? {};
    const tol = HANDLE_PX * (ctx.pxToWorld > 0 ? ctx.pxToWorld : 1);
    const rotOff = ROT_PX * (ctx.pxToWorld > 0 ? ctx.pxToWorld : 1);
    const imageOf = (id) => ctx.images?.[id] ?? (keep.printNext?.id === id ? keep.printNext : null);
    let drag = null;
    const layerOf = (id) => find(ctx.nodes, id)?.layer ?? 0;
    // every print, the one drawn on top first
    const all = () => {
        const out = [];
        const order = find(ctx.nodes, "garment")?.patterns ?? [];
        for (const pid of order) printsOf(find(ctx.nodes, pid)).forEach((print, index) => out.push({ pattern: pid, index, print, start: startOf(ctx.nodes, pid) }));
        return out.sort((a, b) => layerOf(b.pattern) - layerOf(a.pattern) || order.indexOf(b.pattern) - order.indexOf(a.pattern) || b.index - a.index);
    };
    const selected = () => (keep.print ? all().find((e) => e.pattern === keep.print.pattern && e.print.id === keep.print.id) ?? null : null);
    const handles = (e) => {
        const c = printCorners(e.print, e.start, imageOf(e.print.image));
        const top = [(c[2][0] + c[3][0]) / 2, (c[2][1] + c[3][1]) / 2];
        const a = ((e.print.rotation_deg ?? 0) * Math.PI) / 180;
        return { corners: c, top, rot: [top[0] - Math.sin(a) * rotOff, top[1] + Math.cos(a) * rotOff] };
    };
    const overlay = (e) => {
        if (!e) return { lines: [] };
        const h = handles(e);
        return { lines: [[...h.corners, h.corners[0]], [h.top, h.rot]], points: [...h.corners, h.rot] };
    };
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const centreOf = (e) => [e.start[0] + e.print.at[0], e.start[1] + e.print.at[1]];
    // the dragged print with the pointer at `w`
    const moved = (w, mods) => {
        const { entry: e, mode, from } = drag, p = e.print, c = centreOf(e);
        if (mode === "move") return { ...p, at: [p.at[0] + w[0] - from[0], p.at[1] + w[1] - from[1]] };
        if (mode === "scale") {
            const k = dist(w, c) / (dist(from, c) || 1);
            return { ...p, width_mm: Math.max(1, p.width_mm * k) };
        }
        let deg = ((Math.atan2(w[1] - c[1], w[0] - c[0]) - Math.atan2(from[1] - c[1], from[0] - c[0])) * 180) / Math.PI;
        let r = (p.rotation_deg ?? 0) + deg;
        if (mods?.shift) r = Math.round(r / ROT_SNAP) * ROT_SNAP;
        r = ((r % 360) + 540) % 360 - 180;
        return { ...p, rotation_deg: Math.abs(r) < 1e-9 ? 0 : r };
    };
    const listWith = (e, print) => printsOf(find(ctx.nodes, e.pattern)).map((q, i) => (i === e.index ? print : q));
    return {
        down(w, h) {
            const s = selected();
            if (s) {
                const hs = handles(s);
                if (dist(w, hs.rot) <= tol) drag = { entry: s, mode: "rotate", from: [...w] };
                else if (hs.corners.some((q) => dist(w, q) <= tol)) drag = { entry: s, mode: "scale", from: [...w] };
            }
            if (!drag) {
                const hit = all().find((e) => onPrint(w, e.print, e.start, imageOf(e.print.image)));
                if (hit) { keep.print = { pattern: hit.pattern, id: hit.print.id }; drag = { entry: hit, mode: "move", from: [...w] }; }
            }
            if (drag) return { overlay: overlay(drag.entry), status: `print: ${sizeText(drag.entry.print, imageOf(drag.entry.print.image))}`, error: false };
            const next = keep.printNext;
            if (next && h?.id && find(ctx.nodes, h.id)?.kind === "garment.pattern") {
                const start = startOf(ctx.nodes, h.id);
                const print = { id: nextPrintId(ctx.nodes), image: next.id, at: [w[0] - start[0], w[1] - start[1]], rotation_deg: 0, width_mm: PRINT_WIDTH };
                const stored = ctx.images?.[next.id] ? [] : [next.op];
                keep.printNext = null;
                keep.print = { pattern: h.id, id: print.id };
                const e = { pattern: h.id, index: -1, print, start };
                return { ops: [...stored, ...printOps(ctx.nodes, h.id, [...printsOf(find(ctx.nodes, h.id)), print])], overlay: overlay(e), status: `placed ${next.name ?? "the print"}: ${sizeText(print, next)}`, error: false };
            }
            keep.print = null;
            return { overlay: { lines: [] }, status: next ? "click on a piece to place the print" : "Print: pick an image (Print image…), or click a print to move it", error: false };
        },
        move(w, h, mods) {
            if (!drag) return {};
            drag.moved = true;
            const p = moved(w, mods);
            return { preview: printOps(ctx.nodes, drag.entry.pattern, listWith(drag.entry, p)).filter((o) => o.op === "set"), overlay: overlay({ ...drag.entry, print: p }) };
        },
        up(w, h, mods) {
            if (!drag) return {};
            const d = drag;
            if (!d.moved) { drag = null; return {}; }
            const p = moved(w, mods);
            drag = null;
            return { preview: printOps(ctx.nodes, d.entry.pattern, listWith(d.entry, p)).filter((o) => o.op === "set"), endPreview: true, overlay: overlay({ ...d.entry, print: p }),
                status: `print: ${sizeText(p, imageOf(p.image))}`, error: false };
        },
        key(k) {
            const s = selected();
            if ((k === "Delete" || k === "Backspace") && s) {
                keep.print = null;
                return { ops: printOps(ctx.nodes, s.pattern, printsOf(find(ctx.nodes, s.pattern)).filter((_, i) => i !== s.index)), overlay: { lines: [] }, status: "print removed", error: false };
            }
            if (k === "Escape") { keep.print = null; keep.printNext = null; return { overlay: { lines: [] }, done: true }; }
            return {};
        },
    };
}
