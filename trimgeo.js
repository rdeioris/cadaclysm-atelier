// Trim templates (atelier S3) built with the wasm blacksmith kernel: the stitch, button,
// buttonhole bar, zipper tooth, tape and slider meshes the cloth places on every trim instance.
// Takes the kernel module `k`, as dressform.js does; every handle made here is freed here, a throw
// included. tools/trims.py in the kernel repo is the Python twin: change both together.
//
// Each template is a mesh in its local frame: mm, +x along the instance's direction, +z out of
// the cloth, centred on the origin (the instance's normal offset raises it), as
// {positions: Float32Array, normals: Float32Array, indices: Uint32Array}. Sizes are the kernel's
// size keys (`garment_trim_instances`' three size numbers, by TEMPLATE code):
//
//   STITCH          [length, thread diameter, 0]
//   BUTTON          [diameter, thickness, holes 0 | 2 | 4]
//   BUTTONHOLE_BAR  [length, bar width, bar thickness]
//   TOOTH           [pitch, depth across the seam, thickness]
//   TAPE            [width, length along the seam (the pitch), thickness]
//   SLIDER          [tape width, pitch, 0]
//
// Round outlines are regular polygons (blacksmith's profile_regular_polygon) where a template is
// placed many times (stitch, tooth, button), so their triangle counts are fixed whatever the
// size; the buttonhole bar and the slider keep true arcs, meshed at MESH_TOL.

/** The kernel's TEMPLATE_* codes (`Garment.TEMPLATE_*`). */
export const TEMPLATE = Object.freeze({ STITCH: 0, BUTTON: 1, BUTTONHOLE_BAR: 2, TOOTH: 3, TAPE: 4, SLIDER: 5 });
/** Triangle budgets, by TEMPLATE code (the tests hold every template under its own). */
export const BUDGET = Object.freeze([48, 600, 480, 64, 12, 900]);
/** mm: the mesh tolerance of the templates with true arcs (the polygonal ones mesh the same at any). */
export const MESH_TOL = 0.05;

// The kernel's size-key ratios (cadaclysm-garment trims.rs), for the record helpers below.
const STITCH_LENGTH_RATIO = 0.6, BUTTONHOLE_BAR_WIDTH = 1.5, BUTTONHOLE_BAR_THICKNESS = 0.6;
const TOOTH_DEPTH_RATIO = 1.0, TOOTH_THICKNESS_RATIO = 0.6, TAPE_THICKNESS = 0.6;

// The builder's shape choices, all (estimated): not measured from any real trim.
const STITCH_SIDES = 6;              // the thread's cross-section
const STITCH_END = 0.5;              // the chamfer that rounds a stitch's ends, of the thread radius
const BUTTON_SIDES = 32, HOLE_SIDES = 8;
const BUTTON_HOLE_D = 0.12;          // a hole's diameter, of the button's
const BUTTON_HOLE_AT = 0.15;         // a 2-hole button's holes, of the diameter off centre (x)
const BUTTON_HOLE_AT4 = 0.12;        // a 4-hole button's holes, of the diameter off centre (x and y)
const BUTTON_RIM = 0.3;              // the top rim's chamfer, of the thickness (at most 6 % of the diameter)
const SLIT = 1 / 3;                  // a buttonhole's slit, of the bar width
const TOOTH_WIDTH = 0.8;             // a tooth along the seam, of the pitch
const TOOTH_SIDES = 8;               // each rounded end of a tooth
const SLIDER_LENGTH = 4, SLIDER_WIDTH = 2.4, SLIDER_HEIGHT = 1.2;   // of the pitch
const SLIDER_TOP = 0.8;              // the body's top section, of the bottom
const SLIDER_ROUND = 0.25;           // the body's corner radius, of its width
const TAB_LENGTH = 2.5, TAB_WIDTH = 0.8, TAB_THICKNESS = 0.16;     // the pull tab, of the pitch

/** The kernel calls the builders make, bound. */
function calls(k) {
    const f = (n) => {
        const fn = k[`cadaclysm_blacksmith_${n}`];
        if (typeof fn !== "function") throw new Error(`this package lacks ${n}: npm run setup -- --pkg <a cadaclysm master build>`);
        return fn;
    };
    return {
        rect: f("profile_rect"), polygon: f("profile_regular_polygon"), slot: f("profile_slot"),
        rotate2: f("profile_rotate"), round: f("profile_round"), withHole: f("profile_with_hole"),
        union: f("profile_union"), listCount: f("profile_list_count"), listGet: f("profile_list_get"),
        listFree: f("profile_list_free"), pfree: f("profile_free"),
        extrude: f("extrude"), loft: f("loft"), cuboid: f("cuboid"), chamfer: f("chamfer"),
        edgeCount: f("edge_count"), edgePoint: f("edge_inner_point"),
        mesh64: f("mesh64"), sfree: f("solid_free"),
    };
}

/** A frame: origin, then the x, y and z axes (12 numbers). */
const frame = (o = [0, 0, 0], x = [1, 0, 0], y = [0, 1, 0], z = [0, 0, 1]) => Float64Array.from([...o, ...x, ...y, ...z]);

/** The edges of `solid` whose middle point passes `keep`. */
function edgesWhere(K, solid, keep) {
    const out = [], n = K.edgeCount(solid);
    for (let i = 0; i < n; i++) if (keep(K.edgePoint(solid, i))) out.push(i);
    return Uint32Array.from(out);
}

/** `make()`'s solids meshed at `tol` into one mesh (float32), every solid freed, a throw included. */
function meshOf(K, solids, tol) {
    try {
        const parts = solids.map((s) => K.mesh64(s, tol));
        let nv = 0, ni = 0;
        for (const m of parts) { nv += m.positions.length; ni += m.indices.length; }
        const positions = new Float32Array(nv), normals = new Float32Array(nv), indices = new Uint32Array(ni);
        let ov = 0, oi = 0;
        for (const m of parts) {
            positions.set(m.positions, ov); normals.set(m.normals, ov);
            const base = ov / 3;
            for (let i = 0; i < m.indices.length; i++) indices[oi + i] = m.indices[i] + base;
            ov += m.positions.length; oi += m.indices.length;
        }
        return { positions, normals, indices };
    } finally { for (const s of solids) K.sfree(s); }
}

/** The one profile of a profile list (a union of overlapping pieces), the list freed. */
function onlyProfile(K, list, what) {
    try {
        const n = K.listCount(list);
        if (n !== 1) throw new Error(`${what}: ${n} pieces, not 1`);
        return K.listGet(list, 0);
    } finally { K.listFree(list); }
}

/** `profile` extruded `height` along z, centred on z = 0; the profile freed. */
function slab(K, profile, height) {
    try { return K.extrude(profile, frame([0, 0, -height / 2]), height); } finally { K.pfree(profile); }
}

function positive(what, ...v) {
    for (const x of v) if (!(Number.isFinite(x) && x > 0)) throw new Error(`${what}: sizes must be positive, not ${v.join(", ")}`);
}

// ---- the builders: (k, size key) -> mesh ----

/** A stitch: a hexagonal thread `length` along +x, its ends chamfered to a point-ish capsule. */
export function stitchTemplate(k, [length, thread]) {
    positive("stitch", length, thread);
    const K = calls(k), r = thread / 2;
    let p = 0, s = 0;
    try {
        p = K.polygon(0, 0, r, STITCH_SIDES, Math.PI / 2);   // a corner on frame y = +z: thread high
        // extruded along +x: the frame's z is +x, its x +y and its y +z
        s = K.extrude(p, frame([-length / 2, 0, 0], [0, 1, 0], [0, 0, 1], [1, 0, 0]), length);
        const ends = edgesWhere(K, s, (q) => Math.abs(Math.abs(q[0]) - length / 2) < 1e-9 * Math.max(1, length));
        const c = K.chamfer(s, ends, Math.min(STITCH_END * r, length / 4), 1e-6);
        return meshOf(K, [c], MESH_TOL);
    } finally { if (p) K.pfree(p); if (s) K.sfree(s); }
}

/** A button: a 32-sided disc `diameter` across and `thickness` high, its top rim chamfered, with
 * 0, 2 (along x) or 4 holes through it. */
export function buttonTemplate(k, [diameter, thickness, holes = 0]) {
    positive("button", diameter, thickness);
    if (![0, 2, 4].includes(holes)) throw new Error(`button: holes must be 0, 2 or 4, not ${holes}`);
    const K = calls(k), R = diameter / 2;
    const at = holes === 2 ? [[-1, 0], [1, 0]].map(([x, y]) => [x * BUTTON_HOLE_AT * diameter, y])
        : holes === 4 ? [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => [x * BUTTON_HOLE_AT4 * diameter, y * BUTTON_HOLE_AT4 * diameter])
            : [];
    let p = 0, s = 0;
    try {
        p = K.polygon(0, 0, R, BUTTON_SIDES, 0);
        for (const [x, y] of at) {
            const h = K.polygon(x, y, BUTTON_HOLE_D * diameter / 2, HOLE_SIDES, 0);
            try { const q = K.withHole(p, h); K.pfree(p); p = q; } finally { K.pfree(h); }
        }
        s = slab(K, p, thickness); p = 0;
        const rim = edgesWhere(K, s, (q) => Math.abs(q[2] - thickness / 2) < 1e-9 * Math.max(1, thickness) && Math.hypot(q[0], q[1]) > 0.9 * R);
        const c = K.chamfer(s, rim, Math.min(BUTTON_RIM * thickness, 0.06 * diameter), 1e-6);
        return meshOf(K, [c], MESH_TOL);
    } finally { if (p) K.pfree(p); if (s) K.sfree(s); }
}

/** A buttonhole bar: an oval ring (a slot with a slot-shaped slit) `length` along x, `width`
 * across and `thickness` high. */
export function buttonholeTemplate(k, [length, width, thickness]) {
    positive("buttonhole bar", length, width, thickness);
    if (!(length > width)) throw new Error(`buttonhole bar: length ${length} must exceed the width ${width}`);
    const K = calls(k), slit = width * SLIT;
    let outer = 0, inner = 0, ring = 0;
    try {
        outer = K.slot(0, 0, length, width / 2);
        inner = K.slot(0, 0, length - (width - slit), slit / 2);
        ring = K.withHole(outer, inner);
        const s = slab(K, ring, thickness); ring = 0;
        return meshOf(K, [s], MESH_TOL);
    } finally { if (outer) K.pfree(outer); if (inner) K.pfree(inner); if (ring) K.pfree(ring); }
}

/** A zipper tooth: a stadium 0.8 × pitch along x and `depth` across, rounded (8-sided) at both
 * ends, `thickness` high. Symmetric in y, so it reads the same whichever side of the seam its
 * instance's +y faces (the layout's inward direction flips with the seam's side). */
export function toothTemplate(k, [pitch, depth, thickness]) {
    positive("tooth", pitch, depth, thickness);
    const K = calls(k), w = Math.min(TOOTH_WIDTH * pitch, depth), mid = depth - w;
    let p = 0;
    const made = [];
    try {
        const end = (y) => { const h = K.polygon(0, y, w / 2, TOOTH_SIDES, 0); made.push(h); return h; };
        if (mid <= 1e-9 * depth) p = K.polygon(0, 0, w / 2, TOOTH_SIDES, 0);   // as wide as deep: one polygon
        else {
            const body = K.rect(w, mid); made.push(body);
            const half = onlyProfile(K, K.union(body, end(mid / 2), 1e-9), "tooth"); made.push(half);
            p = onlyProfile(K, K.union(half, end(-mid / 2), 1e-9), "tooth");
        }
        const s = slab(K, p, thickness); p = 0;
        return meshOf(K, [s], MESH_TOL);
    } finally { if (p) K.pfree(p); for (const h of made) K.pfree(h); }
}

/** A zipper tape strip: a box `length` (the pitch) along x, `width` across, `thickness` high. */
export function tapeTemplate(k, [width, length, thickness]) {
    positive("tape", width, length, thickness);
    const K = calls(k);
    return meshOf(K, [K.cuboid(length, width, thickness)], MESH_TOL);
}

/** A zipper slider: a loft from a rounded rectangle to a smaller one (4 × 2.4 pitches, 1.2
 * high), with a pull tab (a slot) lying on top toward -x. Two closed solids, one mesh. Sized
 * by the pitch; the tape width is in the key but does not change it. */
export function sliderTemplate(k, [tapeWidth, pitch]) {
    positive("slider", tapeWidth, pitch);
    const K = calls(k);
    const L = SLIDER_LENGTH * pitch, W = SLIDER_WIDTH * pitch, H = SLIDER_HEIGHT * pitch, t = TAB_THICKNESS * pitch;
    const z0 = -(H + t) / 2, z1 = z0 + H;   // the body, then the tab above it: the whole centred on z
    const made = [], solids = [];
    try {
        const rounded = (l, w) => { const r = K.rect(l, w); made.push(r); const q = K.round(r, SLIDER_ROUND * w, null, false); made.push(q); return q; };
        solids.push(K.loft(rounded(L, W), frame([0, 0, z0]), rounded(L * SLIDER_TOP, W * SLIDER_TOP), frame([0, 0, z1])));
        const tab = K.slot(0, 0, TAB_LENGTH * pitch, TAB_WIDTH * pitch / 2); made.push(tab);
        solids.push(K.extrude(tab, frame([-L / 2, 0, z1]), t));
    } catch (e) { for (const s of solids) K.sfree(s); throw e; }
    finally { for (const h of made) K.pfree(h); }
    return meshOf(K, solids, MESH_TOL);
}

const BUILDERS = [stitchTemplate, buttonTemplate, buttonholeTemplate, toothTemplate, tapeTemplate, sliderTemplate];

/** The template `kind` (a TEMPLATE code) at size key `size`. */
export function buildTemplate(k, kind, size) {
    const b = BUILDERS[kind];
    if (!b) throw new Error(`no trim template ${kind}`);
    return b(k, Array.from(size));
}

/** One text per (kind, size key): sizes to a micrometre. */
export const templateKey = (kind, size) => `${kind}:${Array.from(size, (v) => +Number(v).toFixed(3)).join(",")}`;

/**
 * An LRU of built templates by templateKey. The meshes it hands out are its own: copy them
 * before transferring their buffers.
 */
export class TemplateCache {
    constructor(size = 64) { this.size = size; this.map = new Map(); this.built = 0; }
    get(k, kind, size) {
        const key = templateKey(kind, size);
        let m = this.map.get(key);
        if (m) this.map.delete(key);
        else { m = buildTemplate(k, kind, size); this.built++; }
        this.map.set(key, m);
        while (this.map.size > this.size) this.map.delete(this.map.keys().next().value);
        return m;
    }
}

/**
 * The templates a list of instances takes, each once: `rows` are `garment_trim_instances`' flat
 * numbers (`stride` a row: trim, pattern, x, y, angle, offset, template, size0..2, r, g, b, mass).
 * -> {templates: [mesh], slot: Uint32Array (each row's index into templates)}.
 */
export function templateSet(k, rows, cache = new TemplateCache(), stride = 14) {
    const templates = [], at = new Map(), n = Math.floor(rows.length / stride), slot = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
        const r = i * stride, kind = rows[r + 6], size = [rows[r + 7], rows[r + 8], rows[r + 9]];
        const key = templateKey(kind, size);
        if (!at.has(key)) { at.set(key, templates.length); templates.push(cache.get(k, kind, size)); }
        slot[i] = at.get(key);
    }
    return { templates, slot };
}

// ---- size keys from the records (as the kernel's trim_instances makes them) ----

/** A topstitch record's stitch size key. */
export const stitchSize = (t) => [t.stitch_length * STITCH_LENGTH_RATIO, t.thread, 0];
/** A button record's size key. */
export const buttonSize = (b) => [b.diameter, b.thickness, b.holes ?? 0];
/** A buttonhole record's size key. */
export const buttonholeSize = (h) => [h.length, BUTTONHOLE_BAR_WIDTH, BUTTONHOLE_BAR_THICKNESS];
/** A zipper record's size keys: {tooth, tape, slider}. */
export function zipperSizes(z) {
    const p = z.tooth_pitch;
    return { tooth: [p, p * TOOTH_DEPTH_RATIO, p * TOOTH_THICKNESS_RATIO], tape: [z.tape_width, p, TAPE_THICKNESS], slider: [z.tape_width, p, 0] };
}
