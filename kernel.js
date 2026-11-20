// The kernel facade: the one place the app calls cadaclysm_blacksmith_*. It owns a
// blacksmith document holding the garment, and hands back plain arrays for drawing.
import * as m from "./model.js";
import { reanchor } from "./sewing.js";
import { translatePath } from "./drape.js";

const TOL = 0.25;        // flattening tolerance for drawing, mm
const ACC = 1e-6;        // arc-length accuracy (relative)
const STEP = 1;          // outline sample spacing for picking, mm
const NOTCH_KINDS = ["slit", "v", "t", "castle", "u"];
const batch = (ops) => JSON.stringify({ op: "batch", ops });
const text = (e) => String(e && e.message ? e.message : e);
const HOLE_GAP = 0.05;    // mm: a hole nearer the outline or another hole than this touches it
const HOLE_TOL = 0.01;    // mm: profile_deviation's accuracy for that gap (1e-4 costs 50 times more)
const FILL_Z = -1;       // fills lie under every line (z = 0): a hundredth of a mm higher per layer
const ring = (points, from, to) => { const out = []; for (let j = from; j < to; j++) out.push(points[3 * j], points[3 * j + 1]); return out; };

// A drawing without what only the worker draws (posted to the page with every `doc`).
export function forPage(d) {
    const { beziers, fill, ...rest } = d;
    return { ...rest, holes: d.holes.map(({ beziers: _, ...h }) => h), internal: d.internal.map(({ beziers: _, ...l }) => l) };
}

// The kernel calls this app needs beyond 0.15's: a package without them fails here, saying how
// to get one (scripts/setup.mjs says the same).
const NEEDS = ["document_clear_history", "document_head", "profile_ellipse", "profile_fillet_corner", "profile_piece_count",
    "profile_piece", "profile_chain", "profile_close_loop", "profile_beziers", "profile_contains", "profile_offset", "face", "mesh"];

export class Atelier {
    constructor(k) {
        const lacks = NEEDS.filter((n) => typeof k[`cadaclysm_blacksmith_${n}`] !== "function");
        if (lacks.length) throw new Error(`this package lacks ${lacks.join(", ")}: npm run setup -- --pkg <a cadaclysm master build>`);
        this.k = k;
        this.f = (n) => k[`cadaclysm_blacksmith_${n}`];
        this.d = this.f("document_new")("mm");
        this.g = 0;          // the evaluated garment handle (a copy), 0 when none
        this.open = null;    // an open preview: {nodes, problems} from before it, `ops` its last good frame
        this.sidesCache = new Map();
        this.holeChecks = new Map(); // checkHoles: an outline shape -> its error, or null
        this.evalErrors = [];
        this.drawn = null;   // this evaluation's drawings, and the patterns that failed to draw
    }
    free() { this.dropGarment(); this.f("document_free")(this.d); }
    dropGarment() { if (this.g) { this.f("garment_free")(this.g); this.g = 0; } }
    nodes() { return JSON.parse(this.f("document_nodes")(this.d)); }
    get previewing() { return this.open !== null; }
    head() { return this.f("document_head")(this.d); }

    evaluate() {
        this.sidesCache.clear();
        this.dropGarment();
        this.drawn = null;
        const states = JSON.parse(this.f("document_evaluate")(this.d, false));
        this.evalErrors = states.filter((s) => s.state === "error").map((s) => ({ id: s.id, message: s.error ?? s.message ?? "failed" }));
        const has = this.nodes().some((n) => n.id === "garment");
        if (has && this.f("document_result_kind")(this.d, "garment") === "garment")
            this.g = this.f("document_result_garment")(this.d, "garment");
    }
    // What fails in the current state, each {id, message}: nodes the kernel could not evaluate,
    // and patterns that could not be drawn (a zero-area outline, say).
    problems() { return [...this.evalErrors, ...this.drawState().errors]; }
    // The problems now that are not in `before`, as one message; null when there are none.
    newProblems(before) {
        const key = (p) => `${p.id}\u0000${p.message}`;
        const old = new Set(before.map(key));
        const fresh = this.problems().filter((p) => !old.has(key(p)));
        return fresh.length ? fresh.map((p) => `${p.id}: ${p.message}`).join("; ") : null;
    }
    // `ops` as one commit, with `reanchorId` the seams re-anchored to that pattern's new sides in
    // the same commit (one undo step). A change that makes something fail that did not before is
    // refused: the batch is aborted, the kernel is as it was, and the error says why.
    // -> {removed: the seams the re-anchor removed}
    commit(ops, message, reanchorId = null, before = this.problems()) {
        const out = { removed: [] };
        if (!ops.length) return out;
        this.f("document_batch_begin")(this.d, message ?? null);
        try {
            this.f("document_apply")(this.d, batch(ops), null);
            this.evaluate();
            if (reanchorId && m.byId(this.nodes()).has(reanchorId) && !this.newProblems(before)) {
                const r = reanchor(this.nodes(), new Map([[reanchorId, { sides: this.sidesOf(reanchorId) }]]), reanchorId);
                if (r.ops.length) { this.f("document_apply")(this.d, batch(r.ops), null); this.evaluate(); }
                out.removed = r.removed;
            }
            const bad = this.newProblems(before);
            if (bad) throw new Error(bad);
            this.f("document_batch_end")(this.d);
        } catch (e) {
            try { this.f("document_batch_abort")(this.d); } finally { this.evaluate(); }
            throw e;
        }
        return out;
    }
    apply(ops, message) { return this.commit(ops, message); }
    // One drag frame. A frame that makes something fail is refused: the last good frame (or
    // none) is put back, the preview stays open, and the error says why.
    preview(ops) {
        if (!this.open) {
            this.open = { nodes: this.nodes(), problems: this.problems(), ops: null };
            this.f("document_preview_begin")(this.d);
        }
        const p = this.open;
        let bad;
        try {
            this.f("document_preview")(this.d, batch(ops));
            this.evaluate();
            bad = this.newProblems(p.problems);
        } catch (e) { bad = text(e); }
        if (bad) {
            try { this.f("document_preview")(this.d, batch(p.ops ?? [])); } finally { this.evaluate(); }
            throw new Error(bad);
        }
        p.ops = ops;
    }
    // Ends an open preview. With `commit` its last good frame is one commit, the seams
    // re-anchored to `reanchorId`'s new sides inside it. -> {removed: seam ids}
    endPreview(commit, reanchorId = null) {
        const p = this.open;
        if (!p) return { removed: [] };
        this.open = null;
        try { this.f("document_end_preview")(this.d); } finally { this.evaluate(); }
        return commit && p.ops ? this.commit(p.ops, "edit", reanchorId, p.problems) : { removed: [] };
    }
    // false when there is nothing to take back (New and Open start a fresh history).
    undo() {
        const r = this.f("document_undo")(this.d);
        this.evaluate();
        return r !== "null";
    }
    redo() { this.f("document_redo")(this.d); this.evaluate(); }
    save() { return this.f("document_save")(this.d); }
    swapDocument(d) { this.dropGarment(); this.f("document_free")(this.d); this.d = d; this.open = null; }
    load(text) { this.swapDocument(this.f("document_load")(text)); this.f("document_clear_history")(this.d); this.evaluate(); }
    reset(ops) {
        this.swapDocument(this.f("document_new")("mm"));
        this.evaluate();
        this.apply(ops, "new");
        this.f("document_clear_history")(this.d);
    }

    patternIndex(id) {
        const g = m.byId(this.nodes()).get("garment");
        const i = g ? g.patterns.indexOf(id) : -1;
        if (i < 0) throw new Error(`no pattern ${id}`);
        return this.f("garment_patterns")(this.g)[i];
    }
    withOutline(id, fn) {
        const p = this.f("document_result_profile")(this.d, `${id}_outline`);
        try { return fn(p); } finally { this.f("profile_free")(p); }
    }
    rows(arr) { const out = []; for (let i = 0; i + 9 < arr.length; i += 10) out.push(arr.subarray(i, i + 10)); return out; }

    drawing(id) {
        const byId = m.byId(this.nodes());
        const node = byId.get(id);
        const outlineNode = byId.get(`${id}_outline`);
        const pid = this.patternIndex(id);
        const [gx, gy] = node.grain ?? [0, 1];
        return this.withOutline(id, (p) => {
            const { points, offsets } = this.f("profile_polylines")(p, TOL);
            const sew = [];
            for (let j = offsets[0]; j < offsets[1]; j++) sew.push(points[3 * j], points[3 * j + 1]);
            const perimeter = this.f("profile_length")(p, ACC)[0];
            const samples = [];
            this.rows(this.f("profile_divide_by_length")(p, STEP, ACC)).forEach((r, i) => samples.push(i * STEP, r[0], r[1]));
            const sides = this.sidesOf(id);
            const bounds = Array.from(this.f("profile_bounds")(p));
            const notchRaw = Array.from(this.f("garment_pattern_notches")(this.g, pid));
            const notches = [];
            for (let i = 0; i + 2 < notchRaw.length; i += 3) {
                const r = this.f("profile_point_at_length")(p, notchRaw[i], ACC);
                notches.push([r[0], r[1], notchRaw[i + 1]]);
            }
            const allowance0 = (node.allowance ?? [0])[0];
            // the face first: it refuses crossing holes, and checkHoles counts on none crossing
            const fill = this.fillOf(id, node.layer ?? 0);
            this.checkHoles(outlineNode.path);
            const holes = (outlineNode.path.holes ?? []).map((h) => ({
                beziers: this.beziersOf(h),
                ring: this.openPoints({ start: h.start, segments: h.segments }),
                cut: this.holeCutOf(h, allowance0),
            }));
            const internal = (node.internal ?? []).map((l) => ({
                kind: l.kind, points: this.openPoints(l.path), beziers: this.beziersOf(l.path), closed: m.isClosedPath(l.path),
            }));
            const cx = (bounds[0] + bounds[2]) / 2, cy = (bounds[1] + bounds[3]) / 2;
            const half = 0.4 * Math.min(bounds[2] - bounds[0], bounds[3] - bounds[1]) || 10;
            const gl = Math.hypot(gx, gy) || 1;
            const grain = [cx - (gx / gl) * half, cy - (gy / gl) * half, cx + (gx / gl) * half, cy + (gy / gl) * half];
            return {
                id, label: node.label, fabric: node.fabric, layer: node.layer ?? 0,
                sew, cut: Array.from(this.f("garment_cut_line")(this.g, pid, TOL)),
                samples, sides, notches, internal, grain, bounds,
                beziers: this.beziersOf(outlineNode.path), holes, fill,
                sig: JSON.stringify([node, outlineNode.path]),
            };
        });
    }
    // Every pattern's drawing, once per evaluation. A pattern that cannot be drawn is left out
    // and listed in `errors` (an issue on the page), so one bad piece never blanks the rest.
    drawState() {
        if (this.drawn) return this.drawn;
        const g = m.byId(this.nodes()).get("garment");
        const list = [], errors = [];
        if (g && this.g) {
            for (const id of g.patterns) {
                try { list.push(this.drawing(id)); } catch (e) { errors.push({ id, message: text(e) }); }
            }
        }
        this.drawn = { list, errors };
        return this.drawn;
    }
    drawings() { return this.drawState().list; }
    // fn(profile) on a path JSON built as a temporary profile.path node.
    withPath(path, fn) {
        const tmp = this.f("document_new")("mm");
        try {
            this.f("document_apply")(tmp, JSON.stringify({ op: "add", node: { id: "l", kind: "profile.path", path } }), null);
            this.f("document_evaluate")(tmp, false);
            const p = this.f("document_result_profile")(tmp, "l");
            try { return fn(p); } finally { this.f("profile_free")(p); }
        } finally { this.f("document_free")(tmp); }
    }
    // A profile handle for a path JSON (a copy that outlives the scratch document); the caller frees it.
    profileOf(path) { return this.withPath(path, (p) => this.f("profile_transform2d")(p, Float64Array.of(1, 0, 0, 0, 1, 0))); }
    // An ellipse about (cx, cy), semi-axes rx along x and ry along y, from the kernel: four exact
    // conic quarters counter-clockwise from (cx + rx, cy), as path JSON (spec §3).
    ellipsePath(cx, cy, rx, ry) { return this.pathOf(this.f("profile_ellipse")(cx, cy, rx, ry)); }
    // A profile handle as path JSON {start, segments, holes?}, all the kernel gives (a moved or
    // mirrored piece keeps its holes): `pathJson` leaves the handle to the caller,
    // `pathOf` frees it (Tasks 13, 17, 18, 19 use these, not their own parse-and-free).
    pathJson(p) { return JSON.parse(this.f("document_profile_path")(p)); }
    pathOf(q) { try { return this.pathJson(q); } finally { this.f("profile_free")(q); } }
    // The same ellipse's exact Béziers, 16 doubles each (the overlay's rubber band).
    ellipseBeziers(cx, cy, rx, ry) {
        const p = this.f("profile_ellipse")(cx, cy, rx, ry);
        try { return Float64Array.from(this.f("profile_beziers")(p, null)); } finally { this.f("profile_free")(p); }
    }
    // A path's exact Béziers, 16 doubles each, z = 0 (holes left out: each is drawn on its own).
    beziersOf(path) { return this.withPath({ start: path.start, segments: path.segments }, (p) => Float64Array.from(this.f("profile_beziers")(p, null))); }
    // The piece's fill: its outline (holes cut out) as the kernel's planar face, triangulated.
    fillOf(id, layer) {
        return this.withOutline(id, (p) => {
            const sheet = this.f("face")(p, Float64Array.of(0, 0, FILL_Z + 0.01 * layer, 1, 0, 0, 0, 1, 0, 0, 0, 1));
            try {
                const t = this.f("mesh")(sheet, TOL);
                return { positions: Float32Array.from(t.positions), indices: Uint32Array.from(t.indices) };
            } finally { this.f("solid_free")(sheet); }
        });
    }
    // The holes the kernel's face takes but the cloth cannot: the face refuses holes that cross
    // the outline or each other, not one nested in another, nor one that only touches (a snap to
    // the piece's corner lands within float32 of it). Throws for either (called after the face:
    // holes never cross here, so a hole's start point says where all of it lies, and the
    // outlines' smallest distance says whether two touch).
    // Remembered by the outline's shape (a moved piece is the same shape: a 2D drag does not
    // measure again), the error or null.
    checkHoles(path) {
        if (!path.holes?.length) return;
        const key = JSON.stringify(translatePath(path, [-path.start[0], -path.start[1]]), (_, v) => (typeof v === "number" ? Math.round(v * 1e6) / 1e6 : v));
        if (!this.holeChecks.has(key)) {
            if (this.holeChecks.size > 256) this.holeChecks.clear();
            let error = null;
            try { this.measureHoles(path); } catch (e) { error = text(e); }
            this.holeChecks.set(key, error);
        }
        const error = this.holeChecks.get(key);
        if (error) throw new Error(error);
    }
    measureHoles(path) {
        const holes = path.holes;
        const profiles = holes.map((h) => this.profileOf({ start: h.start, segments: h.segments }));
        try {
            const gap = (a, b) => this.f("profile_deviation")(a, b, HOLE_TOL)[5];
            this.withPath({ start: path.start, segments: path.segments }, (outer) => profiles.forEach((p, j) => {
                if (gap(outer, p) < HOLE_GAP) throw new Error(`hole ${j} touches the outline`);
            }));
            profiles.forEach((p, j) => profiles.forEach((q, i) => {
                if (i === j) return;
                if (this.f("profile_contains")(p, holes[i].start[0], holes[i].start[1], 1e-9) === 1) throw new Error(`hole ${i} lies inside hole ${j}`);
                if (i > j && gap(p, q) < HOLE_GAP) throw new Error(`hole ${i} touches hole ${j}`);
            }));
        } finally { profiles.forEach((p) => this.f("profile_free")(p)); }
    }
    // A hole's cut line: the hole shrunk by the allowance (plan ruling 10), each ring flattened.
    holeCutOf(hole, allowance) {
        if (!(allowance > 0)) return [];
        return this.withPath(hole, (p) => {
            const list = this.f("profile_offset")(p, -allowance, 0);
            try {
                const out = [];
                for (let i = 0; i < this.f("profile_list_count")(list); i++) {
                    const q = this.f("profile_list_get")(list, i);
                    try { const { points, offsets } = this.f("profile_polylines")(q, TOL); out.push(ring(points, offsets[0], offsets[1])); } finally { this.f("profile_free")(q); }
                }
                return out;
            } finally { this.f("profile_list_free")(list); }
        });
    }
    // The holes with no cut line: one narrower than twice its piece's allowance, which the
    // offset closes up. -> [{key: "<piece>#<hole index>", message}]
    cutlessHoles() {
        const nodes = m.byId(this.nodes());
        return this.drawState().list.flatMap((d) => {
            const allowance = (nodes.get(d.id)?.allowance ?? [0])[0];
            if (!(allowance > 0)) return [];
            return d.holes.flatMap((h, i) => (h.cut.length ? [] : [{
                key: `${d.id}#${i}`,
                message: `${d.label}: hole ${i + 1} is too small for a ${allowance} mm allowance: it has no cut line`,
            }]));
        });
    }
    // The cutless holes now that were not in `before` (cutlessHoles()), as one warning; null when none.
    newCutlessHoles(before) {
        const old = new Set(before.map((h) => h.key));
        const fresh = this.cutlessHoles().filter((h) => !old.has(h.key));
        return fresh.length ? fresh.map((h) => h.message).join("; ") : null;
    }
    // An internal line's path JSON flattened.
    openPoints(path) {
        return this.withPath(path, (p) => {
            const { points, offsets } = this.f("profile_polylines")(p, TOL);
            const out = [];
            for (let j = offsets[0]; j < offsets[offsets.length - 1]; j++) out.push(points[3 * j], points[3 * j + 1]);
            return out;
        });
    }
    // Arc length where each path segment starts. The segment index the kernel reports at an
    // arc length never decreases along the loop, so each boundary is the smallest s whose
    // segment is >= i, found by bisection (a side of any length is found).
    sideStarts(p, perimeter, count) {
        const seg = (s) => this.f("profile_point_at_length")(p, Math.min(Math.max(s, 0), perimeter), ACC)[7];
        const starts = [0];
        for (let i = 1; i < count; i++) {
            let lo = starts[i - 1], hi = perimeter;
            for (let k = 0; k < 60 && hi - lo > 1e-9; k++) { const mid = (lo + hi) / 2; if (seg(mid) >= i) hi = mid; else lo = mid; }
            starts.push(hi);
        }
        starts.push(perimeter);
        return starts;
    }
    sidesOf(id) {
        let c = this.sidesCache.get(id);
        if (!c) {
            const node = m.byId(this.nodes()).get(`${id}_outline`);
            c = this.withOutline(id, (p) => {
                const perimeter = this.f("profile_length")(p, ACC)[0];
                return this.sideStarts(p, perimeter, node.path.segments.length);
            });
            this.sidesCache.set(id, c);
        }
        return c;
    }

    // A seam whose points cannot be read (its piece failed to draw) is left out.
    seams() {
        if (!this.g) return [];
        const out = [];
        for (const n of this.nodes()) {
            if (n.kind !== "garment.seam") continue;
            try {
                out.push({
                    id: n.id, a: n.a, b: n.b, a_from: n.a_from, a_to: n.a_to, b_from: n.b_from, b_to: n.b_to, reversed: !!n.reversed,
                    points_a: Array.from(this.f("garment_range_points")(this.g, this.patternIndex(n.a), n.a_from, n.a_to, TOL)),
                    points_b: Array.from(this.f("garment_range_points")(this.g, this.patternIndex(n.b), n.b_from, n.b_to, TOL)),
                });
            } catch { /* its piece is named by problems() */ }
        }
        return out;
    }
    // What failed to evaluate or draw (severity "error"), then the garment's own checks.
    issues() {
        const failed = this.problems().map((p) => ({ severity: "error", kind: "evaluation", ratio: 0, message: `${p.id}: ${p.message}` }));
        if (!this.g) return failed;
        const n = this.f("garment_validate")(this.g, 0.01);
        return [...failed, ...Array.from({ length: n }, (_, i) => {
            const [severity, kind, ratio] = this.f("garment_issue")(this.g, i);
            return { severity, kind, ratio, message: this.f("garment_issue_message")(this.g, i) };
        })];
    }
    // A new outline path from fn(profile) on pattern `id`'s committed outline: during a preview,
    // the outline from before it, so a drag's request is never stacked on its own last frame.
    mapped(id, fn) {
        const map = (p) => this.pathOf(fn(p));
        if (!this.open) return this.withOutline(id, map);
        const path = m.byId(this.open.nodes).get(`${id}_outline`)?.path;
        if (!path) throw new Error(`no pattern ${id}`);
        return this.withPath(path, map);
    }
    // m6 is the kernel's row-major 2x3: x' = m0 x + m1 y + m2, y' = m3 x + m4 y + m5.
    transformed(id, m6) { return this.mapped(id, (p) => this.f("profile_transform2d")(p, Float64Array.from(m6))); }
    mirrored(id, [px, py, dx, dy]) { return this.mapped(id, (p) => this.f("profile_mirror")(p, px, py, dx, dy)); }

    toDxf() { return this.f("garment_to_aama")(this.g, 0.1, null); }
    // The pieces of an AAMA DXF as ops adding them, in `fabric` (absent or unknown: the first fabric).
    fromDxf(dxf, fabric) {
        const r = this.f("garment_from_aama")(dxf);
        try {
            let nodes = this.nodes();
            if (!nodes.some((n) => n.id === fabric && n.kind === "garment.fabric")) fabric = nodes.find((n) => n.kind === "garment.fabric")?.id;
            const ops = [];
            for (const pid of this.f("garment_patterns")(r)) {
                const o = this.f("garment_pattern_outline")(r, pid);
                const path = this.pathOf(o);
                const [gx, gy] = this.f("garment_pattern_info")(r, pid);
                const allowance = Array.from(this.f("garment_pattern_allowance")(r, pid));
                const raw = Array.from(this.f("garment_pattern_notches")(r, pid));
                const notches = [];
                for (let i = 0; i + 2 < raw.length; i += 3) notches.push({ at: raw[i], kind: NOTCH_KINDS[raw[i + 1]] ?? "slit", depth: raw[i + 2] });
                // a garment's pattern names must be distinct: suffix a repeat
                const label = m.freeLabel(nodes, this.f("garment_pattern_name")(r, pid));
                const add = m.addPattern(nodes, { label, path, fabric, allowance, grain: [gx, gy] });
                add.ops.find((o) => o.node?.kind === "garment.pattern").node.notches = notches;
                ops.push(...add.ops);
                // keep `nodes` in step so the next id and the garment's list are right
                nodes = nodes.concat(add.ops.filter((o) => o.op === "add").map((o) => o.node));
                const g = nodes.find((n) => n.id === "garment");
                const set = add.ops.find((o) => o.op === "set" && o.id === "garment");
                if (g && set) Object.assign(g, set.fields);
            }
            return ops;
        } finally { this.f("garment_free")(r); }
    }
}
