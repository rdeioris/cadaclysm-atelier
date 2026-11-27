// Trims in the 2D window (spec S3 §7): topstitch, buttons, buttonholes, fastenings and zippers.
// Pure, as pleats.js and simtools.js: the records as the document stores them (kinds/garment.rs),
// the ops that add, edit and remove them, the property panel's rows, the tools' gesture machines
// and the 2D drawing. The geometry is the kernel's: where every stitch, tooth or button lies comes
// from garment_trim_instances (kernel.js trimLayout), so nothing here lays a trim out; a new trim
// is checked by the kernel's own garment_add_* on a scratch copy before it is written (kernel.js
// trimOps).
//
// The document's form:
//   a pattern's `trims`: [{kind: "topstitch", on: "outline", from, to, loop?, offset, stitch_length,
//     thread, rows, gap, colour} | {kind: "topstitch", on: "internal", index, offset: 0, ...} |
//     {kind: "button", at, diameter, thickness, holes, colour, mass} |
//     {kind: "buttonhole", at, angle (radians), length, colour}]
//   a seam's `zipper`: {tape_width, tooth_pitch, tooth_mass, stiffness, colour}
//   a tack's `fastens`: [button index in a's trims, buttonhole index in b's trims]
// Colours are [r, g, b] in 0..1. Lengths in mm, masses in g.
import { addTack, removeTacks } from "./tacks.js";
import { bandOf, ACCENT } from "./scene2d.js";
import { TEMPLATE } from "./trimgeo.js";

// ---- defaults: the builder's choices, all (estimated) ----
export const TOPSTITCH_DEFAULT = Object.freeze({ offset: 6, stitch_length: 3, thread: 0.6, rows: 1, gap: 6, colour: [0.93, 0.89, 0.78] });
// a 15 mm plastic button is 0.6 g (estimated)
export const BUTTON_DEFAULT = Object.freeze({ diameter: 15, thickness: 3, holes: 4, mass: 0.6, colour: [0.22, 0.22, 0.24] });
// a buttonhole takes its button's diameter plus 2 mm at least (the kernel's HoleTooSmall)
export const BUTTONHOLE_DEFAULT = Object.freeze({ length: 18, angle: 0, colour: [0.93, 0.89, 0.78] });
// a #5 metal zipper tooth is 0.05 g (estimated); a zipper stiffens its seam 3 times (estimated)
export const ZIPPER_DEFAULT = Object.freeze({ tape_width: 12, tooth_pitch: 5, tooth_mass: 0.05, stiffness: 3, colour: [0.16, 0.16, 0.18] });
// The tools' starting numbers, one set per kind: the page keeps a copy (ctx.trimNext) that a
// panel edit of a trim updates, so the next one placed takes the numbers last chosen.
export const trimDefaults = () => ({
    topstitch: { ...TOPSTITCH_DEFAULT, colour: [...TOPSTITCH_DEFAULT.colour] },
    button: { ...BUTTON_DEFAULT, colour: [...BUTTON_DEFAULT.colour] },
    buttonhole: { ...BUTTONHOLE_DEFAULT, colour: [...BUTTONHOLE_DEFAULT.colour] },
    zipper: { ...ZIPPER_DEFAULT, colour: [...ZIPPER_DEFAULT.colour] },
});

const find = (nodes, id) => nodes.find((n) => n.id === id);
const num = (v) => typeof v === "number" && Number.isFinite(v);
const round = (v) => Math.round(v * 1e6) / 1e6;
const pt = (p) => [round(Number(p[0])), round(Number(p[1]))];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const DRAG_PX = 3;

// ---- colours: [r, g, b] in 0..1 <-> "#rrggbb" ----
export function hexOf(c) {
    const h = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0");
    return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
}
export function rgbOf(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!m) return null;
    return [0, 2, 4].map((i) => round(parseInt(m[1].slice(i, i + 2), 16) / 255));
}

// ---- records ----
export const trimsOf = (node) => node?.trims ?? [];
// A trim's name as the panel and the status line give it: "Button 2" (its kind's count on the piece).
export function trimName(node, index) {
    const list = trimsOf(node), t = list[index];
    if (!t) return "trim";
    const nth = list.slice(0, index + 1).filter((x) => x.kind === t.kind).length;
    return `${{ topstitch: "Topstitch", button: "Button", buttonhole: "Buttonhole" }[t.kind] ?? t.kind} ${nth}`;
}
// The tack fastening button `index` of piece `id` (a tack whose `fastens` names it), or null;
// for a buttonhole the same.
export function fastenerOf(nodes, id, index) {
    for (const t of nodes) {
        if (t.kind !== "garment.tack" || !Array.isArray(t.fastens)) continue;
        if ((t.a === id && t.fastens[0] === index) || (t.b === id && t.fastens[1] === index)) return t;
    }
    return null;
}

// A topstitch record (the document's), from the tool's numbers `n` and where it runs:
// {pattern, loop, from, to} along an outline or hole, or {pattern, index} along an internal line.
export function topstitchRecord(on, n = TOPSTITCH_DEFAULT) {
    const common = { stitch_length: n.stitch_length, thread: n.thread, rows: n.rows, gap: n.gap, colour: [...n.colour] };
    if (on.index != null) return { kind: "topstitch", on: "internal", index: on.index, offset: 0, ...common };
    const r = { kind: "topstitch", on: "outline", from: round(on.from), to: round(on.to) };
    if (on.loop) r.loop = on.loop;
    return { ...r, offset: n.offset, ...common };
}
export const buttonRecord = (at, n = BUTTON_DEFAULT) => ({ kind: "button", at: pt(at), diameter: n.diameter, thickness: n.thickness, holes: n.holes, colour: [...n.colour], mass: n.mass });
export const buttonholeRecord = (at, n = BUTTONHOLE_DEFAULT) => ({ kind: "buttonhole", at: pt(at), angle: n.angle, length: n.length, colour: [...n.colour] });
export const zipperRecord = (n = ZIPPER_DEFAULT) => ({ tape_width: n.tape_width, tooth_pitch: n.tooth_pitch, tooth_mass: n.tooth_mass, stiffness: n.stiffness, colour: [...n.colour] });

// ---- ops ----
const listField = (list) => ({ trims: list.length ? list : null });

// Trim `rec` appended to piece `id`'s trims. -> {ops, index}
export function addTrimOps(nodes, id, rec) {
    const n = find(nodes, id);
    if (!n) throw new Error(`no pattern ${id}`);
    const list = [...trimsOf(n), rec];
    return { ops: [{ op: "set", id, fields: listField(list) }], index: list.length - 1 };
}

// Piece `id`'s trims replaced by `list`, where `from[k]` is the old index of list[k] (a dropped
// trim's old index is in no entry): the fastenings re-pointed to the new indices, and a fastening
// whose button or buttonhole is gone removed with its tack. -> ops
export function retrimOps(nodes, id, list, from) {
    const now = new Map(from.map((old, k) => [old, k]));
    const ops = [{ op: "set", id, fields: listField(list) }], gone = [];
    for (const t of nodes) {
        if (t.kind !== "garment.tack" || !Array.isArray(t.fastens) || (t.a !== id && t.b !== id)) continue;
        let [bi, hi] = t.fastens, lost = false;
        if (t.a === id) { if (now.has(bi)) bi = now.get(bi); else lost = true; }
        if (t.b === id) { if (now.has(hi)) hi = now.get(hi); else lost = true; }
        if (lost) gone.push(t.id);
        else if (bi !== t.fastens[0] || hi !== t.fastens[1]) ops.push({ op: "set", id: t.id, fields: { fastens: [bi, hi] } });
    }
    return [...ops, ...removeTacks(nodes, gone)];
}
// Trim `index` of piece `id` removed (a fastened button or buttonhole takes its fastening's tack).
export function removeTrimOps(nodes, id, index) {
    const list = trimsOf(find(nodes, id));
    if (!list[index]) throw new Error("that trim is gone");
    const keep = list.map((_, i) => i).filter((i) => i !== index);
    return retrimOps(nodes, id, keep.map((i) => list[i]), keep);
}
// Internal line `index` of piece `id` gone: topstitch along it is dropped, along a later line
// re-pointed. -> ops (none when the piece's trims do not change)
export function lineRemovedOps(nodes, id, index) {
    const list = trimsOf(find(nodes, id));
    if (!list.some((t) => t.kind === "topstitch" && t.on === "internal" && t.index >= index)) return [];
    const keep = [], out = [];
    list.forEach((t, i) => {
        if (t.kind === "topstitch" && t.on === "internal") {
            if (t.index === index) return;
            if (t.index > index) { out.push({ ...t, index: t.index - 1 }); keep.push(i); return; }
        }
        out.push(t); keep.push(i);
    });
    return retrimOps(nodes, id, out, keep);
}

// Button `button` ({id, index}) fastened through buttonhole `hole` ({id, index}): a tack from the
// button's centre to the hole's, with `fastens`. -> {ops, id}
export function fastenOps(nodes, button, hole) {
    const b = trimsOf(find(nodes, button.id))[button.index], h = trimsOf(find(nodes, hole.id))[hole.index];
    if (b?.kind !== "button") throw new Error("fasten: the first click is not on a button");
    if (h?.kind !== "buttonhole") throw new Error("fasten: the second click is not on a buttonhole");
    if (fastenerOf(nodes, button.id, button.index)) throw new Error("that button is already fastened");
    if (fastenerOf(nodes, hole.id, hole.index)) throw new Error("that buttonhole is already fastened");
    const r = addTack(nodes, { a: button.id, a_at: b.at, b: hole.id, b_at: h.at });
    r.ops[0].node.fastens = [button.index, hole.index];
    return r;
}
// Seam `seam`'s zipper set (null: taken off).
export const zipperOps = (seam, zipper) => [{ op: "set", id: seam, fields: { zipper: zipper ? { ...zipper, colour: [...zipper.colour] } : null } }];

// ---- the panel ----
const holesOptions = [0, 2, 4].map((v) => ({ value: String(v), label: String(v) }));
const rowsOptions = [1, 2].map((v) => ({ value: String(v), label: String(v) }));
const deg = (rad) => round((rad * 180) / Math.PI);

// The rows for trim `selection.index` of piece `n`.
export function trimFields(selection, n, nodes) {
    const t = trimsOf(n)[selection.index];
    if (!t) return [];
    const colour = { key: "colour", label: "Colour", unit: "", type: "colour", value: hexOf(t.colour ?? [0.5, 0.5, 0.5]), tip: "How the trim is drawn in 3D (#rrggbb)." };
    const remove = { key: "remove", label: "Remove", unit: "", type: "action", value: null };
    if (t.kind === "topstitch") {
        const where = t.on === "internal" ? `internal line ${t.index + 1}` : `${t.loop ? `hole ${t.loop}` : "outline"} ${round(t.from).toFixed(1)}–${round(t.to).toFixed(1)} mm`;
        return [
            { key: "on", label: "Along", unit: "", type: "readonly", value: where },
            ...(t.on === "internal" ? [] : [{ key: "offset", label: "Offset", unit: "mm", type: "number", value: t.offset, tip: "How far in from the edge the first row runs." }]),
            { key: "stitch_length", label: "Stitch", unit: "mm", type: "number", value: t.stitch_length, tip: "One stitch every this far." },
            { key: "thread", label: "Thread", unit: "mm", type: "number", value: t.thread, tip: "The thread's diameter." },
            { key: "rows", label: "Rows", unit: "", type: "select", value: String(t.rows), options: rowsOptions, tip: "One row, or two parallel rows `gap` apart." },
            { key: "gap", label: "Gap", unit: "mm", type: "number", value: t.gap, tip: "Between the two rows." },
            colour, remove,
        ];
    }
    if (t.kind === "button") {
        const f = fastenerOf(nodes, n.id, selection.index);
        return [
            { key: "at", label: "At", unit: "mm", type: "numbers", value: t.at, tip: "The button's centre on its piece." },
            { key: "diameter", label: "Diameter", unit: "mm", type: "number", value: t.diameter },
            { key: "thickness", label: "Thickness", unit: "mm", type: "number", value: t.thickness },
            { key: "holes", label: "Holes", unit: "", type: "select", value: String(t.holes), options: holesOptions },
            { key: "mass", label: "Mass", unit: "g", type: "number", value: t.mass, tip: "Weighs the cloth under it (a 15 mm plastic button is about 0.6 g, estimated)." },
            ...(f ? [{ key: "fastened", label: "Fastened", unit: "", type: "readonly", value: `tack ${f.id}` }] : []),
            colour, remove,
        ];
    }
    if (t.kind === "buttonhole") {
        const f = fastenerOf(nodes, n.id, selection.index);
        return [
            { key: "at", label: "At", unit: "mm", type: "numbers", value: t.at, tip: "The buttonhole's centre on its piece." },
            { key: "angle", label: "Angle", unit: "°", type: "number", value: deg(t.angle), tip: "Its direction on the piece, from the piece's x axis." },
            { key: "length", label: "Length", unit: "mm", type: "number", value: t.length, tip: "At least its button's diameter plus 2 mm." },
            ...(f ? [{ key: "fastened", label: "Fastened", unit: "", type: "readonly", value: `tack ${f.id}` }] : []),
            colour, remove,
        ];
    }
    return [];
}
// A seam's zipper rows (props.js adds them to the seam's), none without a zipper.
export function zipperFields(seam) {
    const z = seam?.zipper;
    if (!z) return [];
    return [
        { key: "zipper_tape_width", label: "Zipper tape", unit: "mm", type: "number", value: z.tape_width, tip: "The tape's width each side of the seam." },
        { key: "zipper_tooth_pitch", label: "Tooth pitch", unit: "mm", type: "number", value: z.tooth_pitch, tip: "One tooth every this far, alternating sides." },
        { key: "zipper_tooth_mass", label: "Tooth mass", unit: "g", type: "number", value: z.tooth_mass, tip: "A #5 metal tooth is about 0.05 g (estimated)." },
        { key: "zipper_stiffness", label: "Zipper stiffness", unit: "×", type: "number", value: z.stiffness, tip: "Multiplies the seam's strength (at least 1)." },
        { key: "zipper_colour", label: "Zipper colour", unit: "", type: "colour", value: hexOf(z.colour), tip: "The tape's and teeth's colour (#rrggbb); the teeth draw metallic." },
        { key: "zipper_remove", label: "Remove zipper", unit: "", type: "action", value: null },
    ];
}
export const isZipperKey = (key) => key.startsWith("zipper_");
const TRIM_KEYS = new Set(["offset", "stitch_length", "thread", "rows", "gap", "colour", "remove", "at", "diameter", "thickness", "holes", "mass", "angle", "length"]);

// An error for a value, null when it is fine; undefined when it is not a trim's field.
export function trimValidate(selection, nodes, key, value) {
    const zip = selection.kind === "seam" && isZipperKey(key);
    if (selection.kind !== "trim" && !zip) return undefined;
    if (selection.kind === "trim" && !TRIM_KEYS.has(key)) return undefined;
    const k = zip ? key.slice("zipper_".length) : key;
    if (k === "remove") return null;
    if (k === "colour") return rgbOf(value) ? null : "a colour is #rrggbb";
    if (k === "at") return Array.isArray(value) && value.length === 2 && value.every(num) ? null : "at is two numbers: x, y (mm)";
    if (k === "rows") return ["1", "2", 1, 2].includes(value) ? null : "a topstitch has 1 or 2 rows";
    if (k === "holes") return ["0", "2", "4", 0, 2, 4].includes(value) ? null : "a button has 0, 2 or 4 holes";
    if (k === "angle") return num(value) ? null : "an angle is a number of degrees";
    if (k === "offset" || k === "gap") return num(value) && value >= 0 && value <= 500 ? null : `${k} is from 0 to 500 mm`;
    if (k === "stiffness") return num(value) && value >= 1 && value <= 1000 ? null : "a zipper's stiffness is from 1 to 1000";
    return num(value) && value > 0 && value <= 1000 ? null : `${k.replace("_", " ")} is above 0 (and at most 1000)`;
}

// The ops for a trim's field, or a seam's zipper field; null when `key` is not one of them.
export function trimSetOps(selection, nodes, key, value) {
    if (selection.kind === "seam" && isZipperKey(key)) {
        const s = find(nodes, selection.id);
        if (!s?.zipper) throw new Error("that seam has no zipper");
        const k = key.slice("zipper_".length);
        if (k === "remove") return zipperOps(s.id, null);
        return zipperOps(s.id, { ...s.zipper, [k]: k === "colour" ? rgbOf(value) : value });
    }
    if (selection.kind !== "trim" || !TRIM_KEYS.has(key)) return null;
    const id = selection.id, n = find(nodes, id), list = trimsOf(n), t = list[selection.index];
    if (!t) throw new Error("that trim is gone");
    if (key === "remove") return removeTrimOps(nodes, id, selection.index);
    let v = value;
    if (key === "colour") v = rgbOf(value);
    else if (key === "rows" || key === "holes") v = Number(value);
    else if (key === "angle") v = Math.round(((value * Math.PI) / 180) * 1e12) / 1e12;
    else if (key === "at") v = pt(value);
    const next = list.map((x, i) => (i === selection.index ? { ...x, [key]: v } : x));
    const ops = [{ op: "set", id, fields: listField(next) }];
    // a moved button or buttonhole takes its fastening's tack end along
    if (key === "at") {
        const f = fastenerOf(nodes, id, selection.index);
        if (f) ops.push({ op: "set", id: f.id, fields: t.kind === "button" ? { a_at: v } : { b_at: v } });
    }
    return ops;
}
// The tools' next numbers after a panel edit of `key` on a trim of kind `kind` (`trimNext` is
// changed in place).
export function rememberTrim(trimNext, kind, key, value) {
    const k = kind === "seam" ? "zipper" : kind, f = key.startsWith("zipper_") ? key.slice(7) : key;
    const set = trimNext?.[k];
    if (!set || !(f in set)) return;
    if (f === "colour") { const c = rgbOf(value); if (c) set.colour = c; }
    else if (f === "rows" || f === "holes") set[f] = Number(value);
    else if (f === "angle") set.angle = (value * Math.PI) / 180;
    else if (num(value)) set[f] = value;
}

// ---- the tools ----
// The piece a 2D hit is on (simtools.js pieceOf, and a trim's own piece).
const PIECE_HITS = new Set(["pattern", "edge", "internal", "point", "handle", "trim", "hole"]);
const pieceOf = (h) => (h && PIECE_HITS.has(h.kind) ? h.id : null);
const nextOf = (ctx, kind) => ctx.trimNext?.[kind] ?? trimDefaults()[kind];

// Topstitch: a click on an outline side (or a hole's side) stitches that side; a press on an edge
// dragged along it to another point of the same loop stitches the stretch between; a click on an
// internal line stitches the line. The tool stays on for the next.
function topstitchTool(ctx) {
    const drag = DRAG_PX * (ctx.pxToWorld > 0 ? ctx.pxToWorld : 1);
    let press = null;
    const loopOfHit = (h) => (h?.kind === "hole" ? h.loop ?? h.index + 1 : 0);
    const sidesOf = (id, loop) => { const d = ctx.drawings?.get?.(id); return loop ? d?.holes?.[loop - 1]?.sides : d?.sides; };
    const add = (on) => ({ trim: { action: "add", id: on.pattern, record: topstitchRecord(on, nextOf(ctx, "topstitch")) }, overlay: { lines: [] }, status: "topstitched", error: false });
    return {
        down(w, h) {
            press = null;
            if (h?.kind === "internal") return add({ pattern: h.id, index: h.index });
            if ((h?.kind === "edge" || h?.kind === "hole") && num(h.s)) { press = { h, w: [...w] }; return {}; }
            return { status: "topstitch: click an edge or an internal line" };
        },
        move(w) { return press ? { overlay: { lines: [[press.w, [...w]]] } } : {}; },
        up(w, h) {
            if (!press) return {};
            const p = press.h, loop = loopOfHit(p), moved = dist(press.w, w);
            press = null;
            const along = h && (h.kind === "edge" || h.kind === "hole") && h.id === p.id && loopOfHit(h) === loop && num(h.s);
            if (along && moved > drag && Math.abs(h.s - p.s) > drag) {
                const [from, to] = h.s > p.s ? [p.s, h.s] : [h.s, p.s];
                return add({ pattern: p.id, loop, from, to });
            }
            const sides = sidesOf(p.id, loop);
            if (!sides || !(p.side >= 0) || p.side + 1 >= sides.length) return { overlay: { lines: [] }, status: "topstitch: that edge has no sides drawn yet" };
            return add({ pattern: p.id, loop, from: sides[p.side], to: sides[p.side + 1] });
        },
        key(k) { if (k === "Escape") { press = null; return { overlay: { lines: [] }, done: true }; } return {}; },
    };
}
// Button / Buttonhole: a click on a piece places one there (the numbers last chosen). Stays on.
function placeTool(kind) {
    return (ctx) => ({
        down(w, h) {
            const id = pieceOf(h);
            if (!id) return { status: `${kind}: click on a piece` };
            const rec = kind === "button" ? buttonRecord(w, nextOf(ctx, "button")) : buttonholeRecord(w, nextOf(ctx, "buttonhole"));
            return { trim: { action: "add", id, record: rec }, status: `${kind} placed`, error: false };
        },
        move() { return {}; },
        up() { return {}; },
        key(k) { return k === "Escape" ? { done: true } : {}; },
    });
}
// Fasten: a click on a button, then one on a buttonhole (or the other way round): a tack between
// their centres. Stays on for the next pair.
function fastenTool(ctx) {
    let first = null;
    const kindOf = (h) => (h?.kind === "trim" ? trimsOf(find(ctx.nodes, h.id))[h.index]?.kind : null);
    return {
        down(w, h) {
            const k = kindOf(h);
            if (k !== "button" && k !== "buttonhole") return { status: first ? `fasten: now click a ${first.k === "button" ? "buttonhole" : "button"}` : "fasten: click a button, then a buttonhole" };
            const at = trimsOf(find(ctx.nodes, h.id))[h.index].at;
            if (!first) { first = { k, id: h.id, index: h.index, at }; return { overlay: { lines: [], points: [at] }, status: `fasten: now click a ${k === "button" ? "buttonhole" : "button"}`, error: false }; }
            if (k === first.k) return { status: `fasten: that is a ${k} too: click a ${k === "button" ? "buttonhole" : "button"}` };
            const button = first.k === "button" ? first : { id: h.id, index: h.index }, hole = first.k === "button" ? { id: h.id, index: h.index } : first;
            first = null;
            return { trim: { action: "fasten", button: { id: button.id, index: button.index }, hole: { id: hole.id, index: hole.index } }, overlay: { lines: [] }, status: "fastened", error: false };
        },
        move(w) { return first ? { overlay: { lines: [[first.at, [...w]]], points: [first.at] } } : {}; },
        up() { return {}; },
        key(k) { if (k === "Escape") { first = null; return { overlay: { lines: [] }, done: true }; } return {}; },
        lastPoint() { return first ? [...first.at] : null; },
    };
}
// Zipper: a click on a seam (its line on either piece) closes it with a zipper.
function zipperTool(ctx) {
    return {
        down(w, h) {
            const seam = h?.seam ?? (h?.kind === "zipper" ? h.id : null);
            if (!seam) return { status: "zipper: click a seam" };
            if (find(ctx.nodes, seam)?.zipper) return { status: "that seam has a zipper: select the seam to edit it" };
            return { trim: { action: "zipper", seam, zipper: zipperRecord(nextOf(ctx, "zipper")) }, select: { kind: "seam", id: seam }, status: "zipper added", error: false };
        },
        move() { return {}; },
        up() { return {}; },
        key(k) { return k === "Escape" ? { done: true } : {}; },
    };
}

export const S3_TOOLS = { topstitch: topstitchTool, button: placeTool("button"), buttonhole: placeTool("buttonhole"), fasten: fastenTool, zipper: zipperTool };

// ---- the 2D drawing ----
// Each trim is one lines item from its kernel instances (kernel.js trimLayout: {ref, pattern,
// x, y, angle, template, size}): a stitch a dash along its direction, a button a disc's rim with
// its holes, a buttonhole bar a slot's outline, a zipper's teeth small boxes across the seam and
// its tape a strip each side, the slider a box. Drawn above the pieces (the tacks' band); a pick
// on one is that trim ({kind: "trim", id, index}) or that zipper's seam ({kind: "zipper", id}).
export const TRIM_2D = { stitch: "#f2e7c9", button: "#c7b8ff", hole: "#f2e7c9", zipper: "#9fc2dc" };
const CIRCLE = 20;

// The outline segments of one instance, as [x0, y0, x1, y1, ...] pairs of points.
export function instanceSegments(inst) {
    const { x, y, angle, template, size } = inst;
    const c = Math.cos(angle), s = Math.sin(angle);
    const at = (u, v) => [x + u * c - v * s, y + u * s + v * c];
    const out = [];
    const seg = (p, q) => out.push(p[0], p[1], q[0], q[1]);
    const box = (L, W) => { const a = at(-L / 2, -W / 2), b = at(L / 2, -W / 2), d = at(L / 2, W / 2), e = at(-L / 2, W / 2); seg(a, b); seg(b, d); seg(d, e); seg(e, a); };
    const ring = (cx, cy, r, n = CIRCLE) => { for (let k = 0; k < n; k++) { const t0 = (2 * Math.PI * k) / n, t1 = (2 * Math.PI * (k + 1)) / n; seg(at(cx + r * Math.cos(t0), cy + r * Math.sin(t0)), at(cx + r * Math.cos(t1), cy + r * Math.sin(t1))); } };
    switch (template) {
        case TEMPLATE.STITCH: seg(at(-size[0] / 2, 0), at(size[0] / 2, 0)); break;
        case TEMPLATE.BUTTON: {
            const d = size[0];
            ring(0, 0, d / 2);
            const holes = size[2] === 2 ? [[-0.15, 0], [0.15, 0]] : size[2] === 4 ? [[-0.12, -0.12], [0.12, -0.12], [0.12, 0.12], [-0.12, 0.12]] : [];
            for (const [u, v] of holes) ring(u * d, v * d, 0.06 * d, 6);
            break;
        }
        case TEMPLATE.BUTTONHOLE_BAR: box(size[0], size[1]); seg(at(-size[0] / 2 + size[1] / 2, 0), at(size[0] / 2 - size[1] / 2, 0)); break;
        case TEMPLATE.TOOTH: box(Math.min(0.8 * size[0], size[1]), size[1]); break;
        case TEMPLATE.TAPE: { const L = size[1], W = size[0]; seg(at(-L / 2, -W / 2), at(L / 2, -W / 2)); seg(at(-L / 2, W / 2), at(L / 2, W / 2)); break; }
        case TEMPLATE.SLIDER: box(4 * size[1], 2.4 * size[1]); break;
        default: break;
    }
    return out;
}
// A cheap signature of a number list (Items2d re-sends an item only when its sig changes).
function sigOf(a) {
    let h = 2166136261;
    for (const v of a) { h ^= Math.round(v * 1000) | 0; h = Math.imul(h, 16777619); }
    return `${a.length}:${h >>> 0}`;
}
const refKey = (r) => (r.kind === "trim" ? `trim/${r.id}/${r.index}` : `zip/${r.id}`);

// The item specs (scene2d.js specs2d's form) for `layout` (kernel.js trimLayout).
export function trimSpecs({ layout, drawings = [], selection = null, nodes = [] }) {
    if (!layout?.instances?.length) return [];
    const z = bandOf(drawings.length).seam;
    const groups = new Map();
    for (const inst of layout.instances) {
        const r = inst.ref;
        if (!r || (r.kind !== "trim" && r.kind !== "zipper")) continue;
        const key = refKey(r);
        let g = groups.get(key);
        if (!g) {
            const kind = r.kind === "zipper" ? "zipper" : trimsOf(find(nodes, r.id))[r.index]?.kind;
            g = { ref: r, pattern: inst.pattern, kind, segs: [] };
            groups.set(key, g);
        }
        g.segs.push(...instanceSegments(inst));
    }
    const out = [];
    for (const [key, g] of groups) {
        const r = g.ref;
        const on = r.kind === "trim" ? selection?.kind === "trim" && selection.id === r.id && selection.index === r.index
            : selection?.kind === "seam" && selection.id === r.id;
        const colour = on ? ACCENT : g.kind === "button" ? TRIM_2D.button : g.kind === "buttonhole" ? TRIM_2D.hole : g.kind === "zipper" ? TRIM_2D.zipper : TRIM_2D.stitch;
        const data = [];
        for (let i = 0; i < g.segs.length; i += 4) data.push(g.segs[i], g.segs[i + 1], z, g.segs[i + 2], g.segs[i + 3], z);
        const what = r.kind === "trim" ? { kind: "trim", id: r.id, index: r.index } : { kind: "zipper", id: r.id, pattern: g.pattern };
        out.push({ key, show: "lines", data, colour, what, sig: `${sigOf(data)}${on ? "*" : ""}` });
    }
    return out;
}

// ---- the 3D look ----
// Template meshes are keyed by kind, size and colour (showClothTrims colours and metals by
// template): -> the key for a kernel instance row (garment_trim_instances, 14 numbers).
export const lookKey = (row, r) => `${row[r + 6]}:${[7, 8, 9].map((k) => +Number(row[r + k]).toFixed(3)).join(",")}:${[10, 11, 12].map((k) => +Number(row[r + k]).toFixed(4)).join(",")}`;
// Whether a template draws metallic: the zipper's teeth and slider (metal, estimated values).
export const isMetal = (template) => template === TEMPLATE.TOOTH || template === TEMPLATE.SLIDER;
