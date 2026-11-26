// The kernel facade: the one place the app calls cadaclysm_blacksmith_*. It owns a
// blacksmith document holding the garment, and hands back plain arrays for drawing.
import * as m from "./model.js";
import { reanchor, anchorOf, mapGroupRanges } from "./sewing.js";
import { redistributeOps, namesPiece } from "./seamgroup.js";
import { arcAt } from "./view2d.js";
import { translatePath } from "./drape.js";
import { bucklingMigration } from "./fabrics.js";
import { reslotOps } from "./reslot.js";
import * as G from "./grading.js";

const TOL = 0.25;        // flattening tolerance for drawing, mm
const ACC = 1e-6;        // arc-length accuracy (relative)
const STEP = 1;          // outline sample spacing for picking, mm
const NOTCH_KINDS = ["slit", "v", "t", "castle", "u"];
// garment_pattern_internal_kind: 0 Line, 1 Fold, 2 Dart
const INTERNAL_KINDS = ["line", "fold", "dart"];
const batch = (ops) => JSON.stringify({ op: "batch", ops });
const text = (e) => String(e && e.message ? e.message : e);
const HOLE_GAP = 0.05;    // mm: a hole nearer the outline or another hole than this touches it
const HOLE_TOL = 0.01;    // mm: profile_deviation's accuracy for that gap (1e-4 costs 50 times more)
const OUTSIDE = 0, INSIDE = 1, ON = 2;   // profile_contains
const LAND = 0.5;                        // mm: how near a point must lie to land on an outline
// Reflection across the line through axis [x0, y0, x1, y1] (the arithmetic of a mirror axis;
// the shapes themselves go through profile_mirror), and the foot of a point on that line.
export function reflector([x0, y0, x1, y1]) {
    const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy), ux = dx / len, uy = dy / len;
    return ([x, y]) => { const k = 2 * ((x - x0) * ux + (y - y0) * uy); return [x0 + k * ux - (x - x0), y0 + k * uy - (y - y0)]; };
}
export function projector([x0, y0, x1, y1]) {
    const dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy;
    return ([x, y]) => { const k = ((x - x0) * dx + (y - y0) * dy) / l2; return [x0 + k * dx, y0 + k * dy]; };
}
const SHAPE_FIELDS = new Set(["internal", "notches", "grain", "allowance"]);   // a piece's shape besides its outline
const CHAIN_TOL = 1e-6;                  // mm: an unfold's half and mirror meet on the axis within this
// A piece's link to its partner {partner, axis} and its unfold {axis, half} (spec §6), or null.
export const linkOf = (n) => n?.meta?.atelier?.link ?? null;
export const unfoldOf = (n) => n?.meta?.atelier?.unfold ?? null;
// grading (A3): an outline without its holes (holes are not graded), and two outlines alike
const bare = (path) => ({ start: [...path.start], segments: JSON.parse(JSON.stringify(path.segments)) });
const sameOutline = (a, b) => JSON.stringify([a.start, a.segments]) === JSON.stringify([b.start, b.segments]);
const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const ring = (points, from, to) => { const out = []; for (let j = from; j < to; j++) out.push(points[3 * j], points[3 * j + 1]); return out; };

// A drawing without what only the worker draws (posted to the page with every `doc`).
export function forPage(d) {
    const { beziers, fill, ...rest } = d;
    return { ...rest, holes: d.holes.map(({ beziers: _, ...h }) => h), internal: d.internal.map(({ beziers: _, ...l }) => l) };
}

// The kernel calls this app needs beyond 0.15's: a package without them fails here, saying how
// to get one (scripts/setup.mjs says the same).
const NEEDS = ["document_clear_history", "document_head", "profile_ellipse", "profile_fillet_corner", "profile_piece_count",
    "profile_piece", "profile_chain", "profile_close_loop", "profile_beziers", "profile_contains", "profile_offset", "face", "mesh",
    // A1 (spec §3, §5): point editing and the notch marks
    "profile_insert_vertex", "profile_remove_vertex", "profile_smooth_vertex", "garment_pattern_notch_lines",
    // A2 (spec §6): DXF import keeps internal lines and holes
    "garment_pattern_internal_count", "garment_pattern_internal_kind", "garment_pattern_internal"];

// The kernel's seam-length warning (garment_issue: severity 1 = warning, kind 10 =
// ISSUE_SEAM_LENGTH_MISMATCH): CLO's ease rule, a seam whose sides differ by more than 5 %.
// An intended gather (a cuff taking a wider sleeve end) raises it, so the status bar counts
// these as ease notes, apart from the issues.
export const isEaseNote = (i) => i.severity === 1 && i.kind === 10;
const plural = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;
// The status bar's count: "2 issues", "1 ease note", "1 issue, 2 ease notes"; "" when none.
export function issuesLabel(issues) {
    const ease = issues.filter(isEaseNote).length, rest = issues.length - ease;
    return [rest ? plural(rest, "issue") : "", ease ? plural(ease, "ease note") : ""].filter(Boolean).join(", ");
}

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
        this.avatar = null;  // the avatar the slots stand round, {bounds, landmarks}: setAvatar
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
    // `ops` as one commit, with `reanchorId` (one pattern id or a list) the seams re-anchored to
    // that pattern's new sides in the same commit (one undo step). A change that makes something fail that did not before is
    // refused: the batch is aborted, the kernel is as it was, and the error says why.
    // -> {removed: the seams the re-anchor removed}
    commit(ops, message, reanchorId = null, before = this.problems()) {
        const out = { removed: [] };
        if (!ops.length) return out;
        const prior = this.nodes(), anchors = this.customAnchors();
        this.f("document_batch_begin")(this.d, message ?? null);
        try {
            this.f("document_apply")(this.d, batch(ops), null);
            this.evaluate();
            // grading (A3): in a graded size (or a size switch) the internal lines and notches of
            // the pieces whose outline the ops changed follow it, before a partner is rebuilt from them
            const graded = !!(this.grading(prior) || this.grading());
            const mid = graded ? this.nodes() : null;
            const follow = graded ? this.gradeFollowOps(prior) : [];
            if (follow.length) { this.f("document_apply")(this.d, batch(follow), null); this.evaluate(); }
            const own = [...ops, ...follow];
            // a linked partner or an unfolded whole rebuilt from what the ops changed (spec §6),
            // in the same batch; its seams re-anchored with the rest
            const sym = this.symmetryOps(prior, own, true);
            if (sym.ops.length) { this.f("document_apply")(this.d, batch(sym.ops), null); this.evaluate(); }
            // grading (A3): each changed outline's grade -- the base path in the base size, the
            // current size's rules in another (a reshape there is refused)
            if (graded) {
                const rec = this.gradeRecordOps(prior, mid);
                if (rec.length) { this.f("document_apply")(this.d, batch(rec), null); this.evaluate(); }
            }
            // the placed pieces whose outline changed, back on their slots (spec §5)
            const slots = this.slotOps([...own, ...sym.ops], anchors);
            if (slots.length) { this.f("document_apply")(this.d, batch(slots), null); this.evaluate(); }
            // several pieces (a transform of a multi-selection): each one's seams in turn
            for (const rid of [...new Set([reanchorId ?? [], sym.reanchor].flat())]) {
                if (!m.byId(this.nodes()).has(rid) || this.newProblems(before)) continue;
                const r = reanchor(this.nodes(), new Map([[rid, { sides: this.sidesOf(rid) }]]), rid);
                if (r.ops.length) { this.f("document_apply")(this.d, batch(r.ops), null); this.evaluate(); }
                out.removed.push(...r.removed);
            }
            // the M:N groups re-distributed on their ranges' sides now (seamgroup.js), in the same batch
            if (!this.newProblems(before)) {
                const groups = redistributeOps(this.nodes(), (id) => this.sidesOf(id));
                if (groups.length) { this.f("document_apply")(this.d, batch(groups), null); this.evaluate(); }
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
            // `ops`: the last good frame as applied (a rebuilt partner's ops too: the cloth previews
            // it); `user`: that frame's own ops, which endPreview commits (the commit rebuilds again)
            this.open = { nodes: this.nodes(), problems: this.problems(), anchors: this.customAnchors(), ops: null, user: null };
            this.f("document_preview_begin")(this.d);
        }
        const p = this.open;
        let bad, full = ops;
        try {
            this.f("document_preview")(this.d, batch(ops));
            this.evaluate();
            // each frame rebuilds a linked partner or an unfolded whole too: both halves move live
            const sym = this.symmetryOps(p.nodes, ops, false);
            if (sym.ops.length) { full = [...ops, ...sym.ops]; this.f("document_preview")(this.d, batch(full)); this.evaluate(); }
            // and a placed piece stays on its slot while it is dragged
            const slots = this.slotOps(full, p.anchors);
            if (slots.length) { full = [...full, ...slots]; this.f("document_preview")(this.d, batch(full)); this.evaluate(); }
            bad = this.newProblems(p.problems);
        } catch (e) { bad = text(e); }
        if (bad) {
            try { this.f("document_preview")(this.d, batch(p.ops ?? [])); } finally { this.evaluate(); }
            throw new Error(bad);
        }
        p.ops = full; p.user = ops;
    }
    // Ends an open preview. With `commit` its last good frame is one commit, the seams
    // re-anchored to `reanchorId`'s new sides inside it. -> {removed: seam ids}
    endPreview(commit, reanchorId = null) {
        const p = this.open;
        if (!p) return { removed: [] };
        this.open = null;
        try { this.f("document_end_preview")(this.d); } finally { this.evaluate(); }
        return commit && p.user ? this.commit(p.user, "edit", reanchorId, p.problems) : { removed: [] };
    }
    // ---- slot frames refresh (spec §5) ----
    // The avatar the slots are placed round ({bounds, landmarks}, as arrange.js slotFields takes
    // them), or null: with none, nothing is re-placed.
    setAvatar(avatar) { this.avatar = avatar ? { bounds: avatar.bounds, landmarks: avatar.landmarks ?? null } : null; }
    // Each piece's 2D bounds as it stands now, for reslotOps (a piece that does not evaluate has none).
    slotBounds() {
        return { get: (id) => { try { return { bounds: this.withOutline(id, (p) => Array.from(this.f("profile_bounds")(p))) }; } catch { return undefined; } } };
    }
    // The ops re-placing every placed piece whose outline `ops` changed (a 2D edit, a move, a
    // transform, a point added or removed; the document holds them applied) on its slot, and the
    // pieces "on" a re-placed one. A custom slot keeps its frame's axes and is anchored at its
    // bounds centre: `anchors` (customAnchors before the ops) has the bounds it is anchored by.
    slotOps(ops, anchors = null) {
        if (!this.avatar) return [];
        const nodes = this.nodes();
        const only = new Set([...this.touchedPieces(ops, m.byId(nodes))].filter(([, t]) => t.outline).map(([id]) => id));
        return only.size ? reslotOps(nodes, this.slotBounds(), this.avatar, only, anchors).ops : [];
    }
    // The 2D bounds of every piece on a custom (gizmo) slot as it stands now: id -> bounds.
    customAnchors() {
        const out = new Map();
        if (!this.avatar) return out;
        const b = this.slotBounds();
        for (const n of this.nodes())
            if (n.kind === "garment.pattern" && n.meta?.atelier?.slot === "custom") { const d = b.get(n.id); if (d?.bounds) out.set(n.id, d.bounds); }
        return out;
    }
    // Every placed piece re-placed for the avatar now set, as one commit (one undo step), after a
    // new avatar. Not while a preview is open. -> reslotOps' {ops, moved, skipped}
    reslot(message = "re-arrange on the form") {
        if (!this.avatar || this.open) return { ops: [], moved: [], skipped: [] };
        const r = reslotOps(this.nodes(), this.slotBounds(), this.avatar);
        if (r.ops.length) this.commit(r.ops, message);
        return r;
    }
    // false when there is nothing to take back (New and Open start a fresh history).
    undo() {
        const r = this.f("document_undo")(this.d);
        this.evaluate();
        return r !== "null";
    }
    redo() { this.f("document_redo")(this.d); this.evaluate(); }
    save() { return this.f("document_save")(this.d); }
    // The app's document meta (`atelier`): the form built from measurements, `form`, is the V3
    // dress form's spec (dressform.js normaliseSpec), or null.
    atelierMeta() { const t = this.f("document_meta")(this.d, "atelier"); return t ? JSON.parse(t) ?? {} : {}; }
    formMeta() { return this.atelierMeta().form ?? null; }
    // Any app key's document meta (`atelier.image.<id>`: a user image, materials.js), parsed; null when absent.
    meta(app) { const t = this.f("document_meta")(this.d, app); return t ? JSON.parse(t) ?? null : null; }
    // The op that sets the form (null removes it). The op replaces the app's whole value, so the
    // other keys are carried; with nothing left the meta is dropped.
    formMetaOp(spec) {
        const value = { ...this.atelierMeta() };
        if (spec) value.form = spec; else delete value.form;
        return { op: "meta", app: "atelier", value: Object.keys(value).length ? value : null };
    }
    swapDocument(d) { this.dropGarment(); this.f("document_free")(this.d); this.d = d; this.open = null; }
    // An opened document's seams without the app's anchor (an older or imported one) are anchored
    // to their sides as they are now, and fabrics with buckling_stiffness in the old absolute form
    // get the ratio (fabrics.js bucklingMigration), before the history is cleared: part of the
    // base, no undo step.
    load(text) {
        this.swapDocument(this.f("document_load")(text));
        this.evaluate();
        const fabrics = bucklingMigration(this.nodes());
        if (fabrics.length) { this.f("document_apply")(this.d, batch(fabrics), null); this.evaluate(); }
        const ops = this.missingAnchors();
        if (ops.length) { try { this.f("document_apply")(this.d, batch(ops), null); } catch { /* left unanchored, as before */ } finally { this.evaluate(); } }
        this.f("document_clear_history")(this.d);
    }
    // The ops anchoring every seam end that has no anchor (sewing.js anchorOf on its piece's sides);
    // an end whose piece does not evaluate is left without.
    missingAnchors() {
        const ops = [];
        for (const n of this.nodes()) {
            if (n.kind !== "garment.seam") continue;
            const anchor = { ...(n.meta?.atelier ?? {}) };
            let added = false;
            for (const end of ["a", "b"]) {
                if (anchor[end]) continue;
                try { anchor[end] = anchorOf(this.sidesOf(n[end]), n[`${end}_from`], n[`${end}_to`]); added = true; } catch { /* its piece failed */ }
            }
            if (added) ops.push({ op: "set", id: n.id, fields: { meta: { ...n.meta, atelier: anchor } } });
        }
        return ops;
    }
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
            const samples = this.samplesOf(p);
            const sides = this.sidesOf(id);
            const bounds = Array.from(this.f("profile_bounds")(p));
            const notchRaw = Array.from(this.f("garment_pattern_notches")(this.g, pid));
            const notches = [];
            for (let i = 0; i + 2 < notchRaw.length; i += 3) {
                const r = this.f("profile_point_at_length")(p, notchRaw[i], ACC);
                notches.push([r[0], r[1], notchRaw[i + 1]]);
            }
            const notchLines = this.notchLinesOf(pid);
            const allowance0 = (node.allowance ?? [0])[0];
            // the face first: it refuses crossing holes, and checkHoles counts on none crossing
            const fill = this.fillOf(id);
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
            // an unfolded piece's fold (spec §6): from the whole's start to the end of the half's sides
            const U = unfoldOf(node), foldEnd = U && outlineNode.path.segments[U.half.path.segments.length - 2];
            const fold = foldEnd ? [...outlineNode.path.start, ...m.segmentEnd(foldEnd)] : null;
            return {
                id, label: node.label, fabric: node.fabric, layer: node.layer ?? 0,
                sew, cut: Array.from(this.f("garment_cut_line")(this.g, pid, TOL)),
                samples, sides, notches, notchLines, internal, grain, bounds,
                beziers: this.beziersOf(outlineNode.path), holes, fill, fold,
                link: linkOf(node)?.partner ?? null,
                sig: JSON.stringify([node, outlineNode.path]),
            };
        });
    }
    // Each notch's mark (spec §5: the kernel's slit, V, T, castle or U, cut inward `depth` deep)
    // as one polyline, flat x, y pairs, in notch order: garment_pattern_notch_lines' [n, x, y, ...].
    notchLinesOf(pid) {
        const raw = this.f("garment_pattern_notch_lines")(this.g, pid, TOL), out = [];
        for (let i = 0; i < raw.length;) { const n = raw[i]; out.push(Array.from(raw.subarray(i + 1, i + 1 + 2 * n))); i += 1 + 2 * n; }
        return out;
    }
    // The outline every 1 mm: flat triples arc, x, y (what edge picking reads).
    samplesOf(p) { const out = []; this.rows(this.f("profile_divide_by_length")(p, STEP, ACC)).forEach((r, i) => out.push(i * STEP, r[0], r[1])); return out; }
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
    // The piece under pattern point [x, y]: the highest layer's (of one layer, the later piece:
    // the 2D window draws it over) whose outline holds the point or has it on the outline, by
    // profile_contains (a hole is not the piece); null when the point is on no piece.
    pieceAt([x, y]) {
        const order = this.drawings().map((d, i) => ({ id: d.id, layer: d.layer, i })).sort((a, b) => b.layer - a.layer || b.i - a.i);
        for (const d of order) if (this.withOutline(d.id, (p) => this.f("profile_contains")(p, x, y, 0)) !== OUTSIDE) return d.id;
        return null;
    }
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
    // The piece's fill: its outline (holes cut out) as the kernel's planar face at z = 0,
    // triangulated (scene2d.js lifts it to its piece's band, bandOf).
    fillOf(id) {
        return this.withOutline(id, (p) => {
            const sheet = this.f("face")(p, Float64Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1));
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
        const profiles = [];
        try {
            for (const h of holes) profiles.push(this.profileOf({ start: h.start, segments: h.segments }));
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
                    group: n.meta?.atelier?.group?.id ?? null, member: n.meta?.atelier?.member ?? null,
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
    // The whole piece `id` through m6 (spec §2; the general form of mirroredPiece): the outline
    // with its holes through profile_transform2d, each internal line through the same matrix, each
    // notch re-placed at its mapped point on the new outline, and the grain the matrix's linear
    // part applied and normalised. From the committed piece during a preview (as transformed()).
    // -> {path, internal, notches, grain}
    transformedPiece(id, m6) {
        const byId = m.byId(this.open ? this.open.nodes : this.nodes()), node = byId.get(id), path = byId.get(`${id}_outline`)?.path;
        if (!node || !path) throw new Error(`no pattern ${id}`);
        return this.pieceThrough(node, path, m6);
    }
    // The same for a piece given as its node and outline path (a clipboard's copy, which need not
    // be in the document any more).
    pieceThrough(node, path, m6) {
        const f = this.f, mat = Float64Array.from(m6);
        const through = (q) => this.withPath(q, (p) => this.pathOf(f("profile_transform2d")(p, mat)));
        const out = through(path);
        const internal = (node.internal ?? []).map((l) => { const p = through(l.path); return { ...l, path: { start: p.start, segments: p.segments } }; });
        const map = ([x, y]) => [m6[0] * x + m6[1] * y + m6[2], m6[3] * x + m6[4] * y + m6[5]];
        const notches = !node.notches?.length ? [] : this.withPath({ start: path.start, segments: path.segments }, (old) => this.withPath({ start: out.start, segments: out.segments }, (p) => {
            const samples = this.samplesOf(p), sides = this.sideStarts(p, f("profile_length")(p, ACC)[0], out.segments.length);
            return node.notches.map((nt) => { const at = f("profile_point_at_length")(old, nt.at, ACC); return { ...nt, at: arcAt(samples, sides, map([at[0], at[1]])).s }; });
        }));
        const [gx, gy] = node.grain ?? [0, 1], tx = m6[0] * gx + m6[1] * gy, ty = m6[3] * gx + m6[4] * gy, gl = Math.hypot(tx, ty);
        if (!(gl > 0)) throw new Error("the transform collapses the piece");
        const r = { path: out, internal, notches, grain: [tx / gl, ty / gl] };
        // spec §6: a link's axis through the same matrix (model.pieceOps keeps it only when the
        // partner moves too), and an unfold's axis and half with it
        const axisThrough = ([x0, y0, x1, y1]) => [...map([x0, y0]), ...map([x1, y1])];
        if (linkOf(node)) r.linkAxis = axisThrough(linkOf(node).axis);
        const U = unfoldOf(node);
        if (U) {
            const h = this.pieceThrough({ internal: U.half.internal, notches: U.half.notches }, U.half.path, m6);
            r.unfold = { axis: axisThrough(U.axis), half: { ...U.half, path: h.path, internal: h.internal, notches: h.notches } };
        }
        return r;
    }
    // Clipboard pieces ([{node, path}]) through m6: what a paste places. -> [{path, internal, notches, grain}]
    piecesThrough(pieces, m6) { return pieces.map((p) => this.pieceThrough(p.node, p.path, m6)); }
    // The axis is two points on the line, [x0, y0, x1, y1], as the Mirror tool sends it (tools.js);
    // profile_mirror takes a point and a direction.
    mirrored(id, [x0, y0, x1, y1]) { return this.mapped(id, (p) => this.f("profile_mirror")(p, x0, y0, x1 - x0, y1 - y0)); }
    // The Mirror tool's new piece, in one call: the outline (holes kept) as mirrored(), the source's
    // internal lines and shapes through the same profile_mirror, and its notches re-placed at the
    // reflected points on the mirrored outline. All from the committed piece during a preview.
    // -> {path, internal, notches, grain}
    mirroredPiece(id, axis) {
        const byId = m.byId(this.open ? this.open.nodes : this.nodes()), node = byId.get(id), src = byId.get(`${id}_outline`)?.path;
        if (!node || !src) throw new Error(`no pattern ${id}`);
        return this.mirrorPieceOf(node, src, axis);
    }
    // The same for a piece given as its node and outline path (a linked partner's rebuild reads
    // them from the batch being made). The grain is the node's reflected across the axis.
    mirrorPieceOf(node, src, axis) {
        const f = this.f, [x0, y0, x1, y1] = axis, dx = x1 - x0, dy = y1 - y0;
        const mirror = (q) => f("profile_mirror")(q, x0, y0, dx, dy);
        const path = this.withPath(src, (q) => this.pathOf(mirror(q)));
        const internal = (node.internal ?? []).map((l) => {
            const p = this.withPath(l.path, (q) => this.pathOf(mirror(q)));
            return { ...l, path: { start: p.start, segments: p.segments } };
        });
        const reflect = reflector(axis);
        const notches = !node.notches?.length ? [] : this.withPath({ start: src.start, segments: src.segments }, (old) => this.withPath({ start: path.start, segments: path.segments }, (p) => {
            const samples = this.samplesOf(p), sides = this.sideStarts(p, f("profile_length")(p, ACC)[0], path.segments.length);
            return node.notches.map((nt) => { const at = f("profile_point_at_length")(old, nt.at, ACC); return { ...nt, at: arcAt(samples, sides, reflect([at[0], at[1]])).s }; });
        }));
        const [gx, gy] = node.grain ?? [0, 1], g = reflect([x0 + gx, y0 + gy]);
        return { path, internal, notches, grain: [g[0] - x0, g[1] - y0] };
    }

    // The two pieces an open `cutter` (path JSON) cuts pattern `id` into, all from kernel calls
    // (spec §4): the outline's two pieces where the cutter crosses it (profile_pieces), each
    // chained with the cutter's stretch inside it and closed. Holes, notches and internal lines go
    // to the piece holding them (internal line `consume`, the cutter, to neither); each seam end
    // to the piece its whole range lies on, or the seam is dropped; the cut edge on each piece is
    // the stretch between the cutter's ends that lies on the other piece. Throws, changing
    // nothing, where the cutter does not cross the outline exactly twice, or where it crosses or
    // touches a hole (a hole is never split nor dropped: cut beside it).
    cutPieces(id, cutter, consume = null) {
        const f = this.f, byId = m.byId(this.nodes()), node = byId.get(id), path = byId.get(`${id}_outline`)?.path;
        if (!node || !path) throw new Error(`no pattern ${id}`);
        const owned = [];
        const own = (h) => { owned.push(h); return h; };
        try {
            const out = own(this.profileOf({ start: path.start, segments: path.segments }));
            const cut = own(this.profileOf(cutter));
            const n = f("profile_piece_count")(out, Uint32Array.of(cut), 0);
            if (n !== 2) throw new Error(n < 2 ? "the cutter does not cross the piece" : `the cutter crosses the outline ${n} times: one line across the piece makes two`);
            (path.holes ?? []).forEach((h, i) => {
                const hp = own(this.profileOf({ start: h.start, segments: h.segments }));
                if (f("profile_piece_count")(hp, Uint32Array.of(cut), 0) !== 1) throw new Error(`the cutter crosses hole ${i + 1}: cut beside it`);
            });
            // an internal line or shape the cutter crosses (or touches) would stick out of its piece
            (node.internal ?? []).forEach((l, i) => {
                if (i === consume) return;
                const lp = own(this.profileOf(l.path));
                if (f("profile_piece_count")(lp, Uint32Array.of(cut), 0) !== 1) throw new Error(`the cutter crosses internal line ${i + 1}: move or delete it first`);
            });
            const halves = [0, 1].map((i) => own(f("profile_piece")(out, Uint32Array.of(cut), i, 0)));
            const inner = [];
            for (let i = 0, cn = f("profile_piece_count")(cut, Uint32Array.of(out), 0); i < cn; i++) {
                const q = own(f("profile_piece")(cut, Uint32Array.of(out), i, 0));
                const mid = f("profile_point_at_length")(q, this.openLength(q) / 2, ACC);
                if (f("profile_contains")(out, mid[0], mid[1], 0) === INSIDE) inner.push(q);
            }
            if (inner.length !== 1) throw new Error("the cutter must cross the piece once, end to end");
            const loops = halves.map((h) => own(f("profile_close_loop")(own(f("profile_chain")(Uint32Array.of(h, inner[0]), 0)))));
            const on = (p, [x, y]) => f("profile_contains")(p, x, y, LAND) === ON;
            const holding = (p, [x, y]) => f("profile_contains")(p, x, y, LAND) !== OUTSIDE;
            const pieces = loops.map((p) => {
                const { start, segments } = this.pathJson(p);
                const perimeter = f("profile_length")(p, ACC)[0];
                return { path: { start, segments }, samples: this.samplesOf(p), sides: this.sideStarts(p, perimeter, segments.length), perimeter };
            });
            // the arc length of a point on loop k from its 1 mm samples; within LAND of a side start
            // (a corner, which a sample may straddle) exactly that side start
            const arc = (k, pt) => {
                const s = arcAt(pieces[k].samples, pieces[k].sides, pt).s;
                const near = pieces[k].sides.find((c) => Math.abs(c - s) < LAND);
                return near ?? s;
            };
            // a range that only seems to wrap, ending at the loop's start (or starting at its end):
            // that end at P (or 0), so it reads as the plain range it is
            const span = (k, from, to) => {
                const P = pieces[k].perimeter;
                if (from > to && to < LAND) to = P;
                else if (from > to && from > P - LAND) from = 0;
                return [from, to];
            };
            const pointOn = (p, s) => { const r = f("profile_point_at_length")(p, s, ACC); return [r[0], r[1]]; };
            const holes = [[], []], notches = [[], []], internal = [[], []];
            // a hole the cutter does not meet lies wholly on one side: its start says which
            for (const h of path.holes ?? []) holes[holding(loops[0], h.start) ? 0 : 1].push(h);
            for (const nt of node.notches ?? []) {
                const pt = pointOn(out, nt.at), k = on(loops[0], pt) ? 0 : on(loops[1], pt) ? 1 : -1;
                if (k < 0) throw new Error(`notch ${node.notches.indexOf(nt) + 1} lands on neither piece`);
                notches[k].push({ ...nt, at: arc(k, pt) });
            }
            (node.internal ?? []).forEach((l, i) => { if (i !== consume) internal[holding(loops[0], l.path.start) ? 0 : 1].push(l); });
            const seamMoves = [], dropped = [];
            for (const s of this.seams()) {
                for (const end of ["a", "b"]) {
                    if (s[end] !== id) continue;
                    const flat = s[`points_${end}`], pts = [];
                    for (let i = 0; i + 1 < flat.length; i += 2) pts.push([flat[i], flat[i + 1]]);
                    const k = [0, 1].find((j) => pts.every((pt) => on(loops[j], pt)));
                    if (k === undefined) { if (!dropped.includes(s.id)) dropped.push(s.id); continue; }
                    const [from, to] = span(k, arc(k, pts[0]), arc(k, pts.at(-1)));
                    seamMoves.push({ id: s.id, end, piece: k, from, to, anchor: anchorOf(pieces[k].sides, from, to) });
                }
            }
            const live = seamMoves.filter((mv) => !dropped.includes(mv.id));
            const ends = [0, this.openLength(inner[0])].map((s) => pointOn(inner[0], s));
            const cutEdges = [0, 1].map((k) => {
                const P = pieces[k].perimeter;
                let [from, to] = ends.map((pt) => arc(k, pt));
                const midS = (from + ((((to - from) % P) + P) % P) / 2) % P;
                if (!on(loops[1 - k], pointOn(loops[k], midS))) [from, to] = [to, from];
                [from, to] = span(k, from, to);
                return { from, to, anchor: anchorOf(pieces[k].sides, from, to) };
            });
            const [pa, pb] = [pointOn(loops[0], cutEdges[0].from), pointOn(loops[1], cutEdges[1].from)];
            return {
                pieces: pieces.map((pc, k) => ({ path: holes[k].length ? { ...pc.path, holes: holes[k] } : pc.path, notches: notches[k], internal: internal[k] })),
                seamMoves: live, dropped, cutEdges, reversed: Math.hypot(pa[0] - pb[0], pa[1] - pb[1]) > LAND,
            };
        } finally { for (const h of owned) this.f("profile_free")(h); }
    }

    // An open chain's own length: profile_length (and profile_point_at_length) run on along the
    // chord from its end back to its start, which comes last.
    openLength(q) {
        const { start, segments } = this.pathJson(q), end = m.segmentEnd(segments.at(-1));
        return this.f("profile_length")(q, ACC)[0] - Math.hypot(end[0] - start[0], end[1] - start[1]);
    }

    // The ops of a cut (and with `sew`, one seam joining the cut edges): one batch, one undo.
    cutOps(id, cutter, { sew = false, consume = null } = {}) {
        this.baseOnly();
        const r = this.cutPieces(id, cutter, consume);
        const label = m.byId(this.nodes()).get(id).label ?? "Piece";
        const out = m.replacePattern(this.nodes(), id, r.pieces.map((p, k) => ({ ...p, label: `${label} ${"AB"[k]}` })),
            { seamMoves: r.seamMoves, dropped: r.dropped, sew: sew ? { a: r.cutEdges[0], b: r.cutEdges[1], reversed: r.reversed } : null });
        // a graded piece's halves are graded too (A3): each new vertex takes the rule at its place
        const g = G.gradeOf(m.byId(this.nodes()).get(id));
        if (g) out.ids.forEach((pid, k) => {
            const node = out.ops.find((o) => o.node?.id === pid)?.node, path = bare(r.pieces[k].path);
            if (node) node.meta = m.atelierMeta(node.meta, "grade", { base: path, rules: this.carryGrade(g, path) });
        });
        return { ...out, dropped: r.dropped };
    }
    // The rules of grade `g` carried onto outline `path` cut from its base: a vertex on a base
    // vertex takes its rule, one on a base side the rules interpolated along it, one inside (a
    // cutter's bend) the piece's affine fit (grading.js rulesAtPlaces).
    carryGrade(g, path) {
        const vb = G.vertices(g.base);
        const places = this.withPath(g.base, (p) => {
            const samples = this.samplesOf(p), sides = this.sideStarts(p, this.f("profile_length")(p, ACC)[0], g.base.segments.length);
            return G.vertices(path).map((q) => {
                const k = vb.findIndex((v) => Math.hypot(v[0] - q[0], v[1] - q[1]) <= 1e-4);
                if (k >= 0) return { vertex: k };
                const at = arcAt(samples, sides, q);
                if (at.d > 0.05) return { point: q };
                const len = sides[at.side + 1] - sides[at.side];
                return { side: at.side, t: len > 0 ? Math.min(1, Math.max(0, (at.s - sides[at.side]) / len)) : 0 };
            });
        });
        return G.rulesAtPlaces(g.rules, g.base, places);
    }

    // Internal closed shape `index` of piece `id` as a new piece, moved by the kernel beside the
    // piece (its width + 20 mm along x). The original keeps the shape. One batch: one undo.
    traceOps(id, index) {
        const nodes = this.nodes(), entry = m.byId(nodes).get(id)?.internal?.[index];
        if (!entry || !m.isClosedPath(entry.path)) throw new Error("trace: click a closed internal shape");
        const b = this.withOutline(id, (p) => this.f("profile_bounds")(p)), dx = b[2] - b[0] + 20;
        const path = this.withPath({ start: entry.path.start, segments: entry.path.segments },
            (p) => this.pathOf(this.f("profile_transform2d")(p, Float64Array.of(1, 0, dx, 0, 1, 0))));
        return m.tracePattern(nodes, id, path).ops;
    }

    // Pattern `id`'s outline with corner `corner` (path point index) rounded to `radius` by
    // profile_fillet_corner on the two sides meeting there, the pieces read back through
    // profile_from_pieces; its holes kept, its notches re-placed at the same points.
    // -> {path, insertAt, notches}: the arc is side `insertAt`, and sides from it on move up one.
    // Throws, changing nothing, for a free-form side, a radius that does not fit, or a side the
    // kernel trims into more than one segment.
    filletPath(id, corner, radius) {
        const f = this.f, nodes = m.byId(this.nodes()), node = nodes.get(id), path = nodes.get(`${id}_outline`)?.path;
        if (!node || !path) throw new Error(`no pattern ${id}`);
        const segs = path.segments, n = segs.length, before = (corner - 1 + n) % n;
        if (!Number.isInteger(corner) || corner < 0 || corner >= n) throw new Error(`fillet: no corner ${corner}`);
        if (!(radius > 0)) throw new Error("fillet: a radius above 0");
        if ([segs[before], segs[corner]].some((s) => s.type === "nurbs")) throw new Error("fillet: a free-form side's corner is not rounded this round");
        const pts = m.pathPoints(path);
        const json = this.withPath({ start: pts[before], segments: [segs[before]] }, (pa) =>
            this.withPath({ start: pts[corner], segments: [segs[corner]] }, (pb) => f("profile_fillet_corner")(pa, pb, radius, 0)));
        const r = JSON.parse(json);
        if (r.a.length !== 1 || r.b.length !== 1) throw new Error("fillet: this corner's sides do not round as one segment each");
        const mid = this.pathOf(f("profile_from_pieces")(JSON.stringify([...r.a, r.arc, ...r.b]), false, 0)).segments;
        if (mid.length !== 3 || mid[1].type !== "arc") throw new Error("fillet: the corner did not come back as side, arc, side");
        const [sa, arc, sb] = mid;
        const filleted = corner === 0
            ? { start: [...arc.to], segments: [sb, ...segs.slice(1, n - 1), sa, arc] }
            : { start: [...path.start], segments: [...segs.slice(0, before), sa, arc, sb, ...segs.slice(corner + 1)] };
        if (path.holes) filleted.holes = path.holes;
        this.checkHoles(filleted);
        const notches = this.withOutline(id, (old) => this.withPath(filleted, (p) => {
            const samples = this.samplesOf(p), sides = this.sideStarts(p, f("profile_length")(p, ACC)[0], filleted.segments.length);
            return (node.notches ?? []).map((nt) => { const at = f("profile_point_at_length")(old, nt.at, ACC); return { ...nt, at: arcAt(samples, sides, [at[0], at[1]]).s }; });
        }));
        return { path: filleted, insertAt: corner === 0 ? n : corner, notches };
    }
    // The fillet's ops (one batch; Atelier.commit(ops, "fillet", id) re-anchors the seams in it).
    filletOps(id, corner, radius) {
        this.baseOnly();
        const r = this.filletPath(id, corner, radius);
        return m.filletOps(this.nodes(), id, r.path, r.insertAt, r.notches);
    }

    // ---- linked pairs and unfold (spec §6) ----
    // The pieces a batch's own ops changed the shape of: an outline, or the internal lines,
    // notches, grain or allowance (a label, layer, fabric or meta is not the shape).
    // -> Map id -> {outline: whether its outline changed}
    touchedPieces(ops, after) {
        const out = new Map();
        const mark = (id, outline) => {
            if (after.get(id)?.kind !== "garment.pattern") return;
            const t = out.get(id) ?? { outline: false };
            t.outline ||= outline;
            out.set(id, t);
        };
        for (const o of ops) {
            if (o.op !== "set" || typeof o.id !== "string") continue;
            if (o.id.endsWith("_outline")) mark(o.id.slice(0, -"_outline".length), true);
            else if (Object.keys(o.fields ?? {}).some((key) => SHAPE_FIELDS.has(key))) mark(o.id, false);
        }
        return out;
    }
    // The ops that keep the symmetric pieces whole after a batch's own `ops` (`priorList` the
    // nodes before them; the document holds them applied): a linked piece the ops changed rebuilds
    // its partner (mirrorPieceOf across the link's axis), an unfolded piece whose outline they
    // changed rebuilds its whole from the edited half (refolded), and a link whose partner is gone
    // or no longer links back is dropped. Only the pieces the ops touched are read: a rebuilt one
    // never rebuilds its source back. With `seams`, the rebuilt pieces' seams follow (followSides).
    // -> {ops, reanchor: the pieces whose seams the commit re-anchors}
    symmetryOps(priorList, ops, seams) {
        const prior = m.byId(priorList), nodes = this.nodes(), after = m.byId(nodes);
        const out = [], reanchor = [];
        for (const n of nodes) {
            const L = linkOf(n);
            if (L && linkOf(after.get(L.partner))?.partner !== n.id) out.push(...m.setPattern(nodes, n.id, { meta: m.atelierMeta(n.meta, "link") }));
        }
        const touched = this.touchedPieces(ops, after);
        const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
        for (const [id, t] of touched) {
            const n = after.get(id), L = linkOf(n), U = unfoldOf(n), path = after.get(`${id}_outline`)?.path;
            if (!path) continue;
            // both pieces in the batch (a move of the pair): the axis went through the same matrix
            if (L && !touched.has(L.partner) && same(L, linkOf(prior.get(id)))) {
                const partner = after.get(L.partner), old = after.get(`${L.partner}_outline`)?.path;
                if (linkOf(partner)?.partner === id && old) {
                    const r = this.mirrorPieceOf(n, path, L.axis);
                    out.push(...m.setOutline(nodes, partner.id, r.path),
                        ...m.setPattern(nodes, partner.id, { internal: r.internal, notches: r.notches, grain: r.grain, allowance: n.allowance ?? partner.allowance ?? [10] }));
                    if (seams) out.push(...this.followSides(partner.id, old, r.path, nodes, reanchor));
                }
            }
            // an unfold, a fold-back or a move sets `unfold` itself: nothing to rebuild
            if (U && t.outline && same(U, unfoldOf(prior.get(id)))) {
                const r = this.refolded(n, U, prior.get(`${id}_outline`)?.path, path);
                if (!r) continue;
                out.push(...m.setOutline(nodes, id, r.path), ...m.setPattern(nodes, id, r.fields));
                if (seams) out.push(...this.followSides(id, path, r.path, nodes, reanchor));
            }
        }
        return { ops: out, reanchor };
    }
    // Piece `id`'s seams after its outline went from `from` to `to`: with as many sides, their
    // anchors still name the same sides (the commit re-anchors `id` from the fractions); with a
    // side more or fewer, each anchor is moved onto `to` by position (anchorsOnto).
    followSides(id, from, to, nodes, reanchor) {
        reanchor.push(id);
        return from.segments.length === to.segments.length ? [] : this.anchorsOnto(id, from, to, nodes);
    }
    // The anchors of piece `id`'s seams moved from outline `from` onto outline `to`: each end's
    // point on `from` (from its anchor) to the nearest arc length on `to` (a side start within
    // LAND exactly that), written as anchorOf writes it.
    anchorsOnto(id, from, to, nodes) {
        const f = this.f, ops = [];
        const seams = nodes.filter((n) => n.kind === "garment.seam" && n.meta?.atelier && (n.a === id || n.b === id || namesPiece(n, id)));
        if (!seams.length) return ops;
        this.withPath({ start: from.start, segments: from.segments }, (pf) => this.withPath({ start: to.start, segments: to.segments }, (pt) => {
            const sf = this.sideStarts(pf, f("profile_length")(pf, ACC)[0], from.segments.length);
            const P = f("profile_length")(pt, ACC)[0], st = this.sideStarts(pt, P, to.segments.length), samples = this.samplesOf(pt);
            const arcOn = (s) => {
                const r = f("profile_point_at_length")(pf, s, ACC), a = arcAt(samples, st, [r[0], r[1]]).s;
                return st.find((c) => Math.abs(c - a) < LAND) ?? a;
            };
            const onto = ([a, ta, tb, b = a]) => {
                if (a >= sf.length - 1 || b >= sf.length - 1) return null;
                let s0 = arcOn(sf[a] + ta * (sf[a + 1] - sf[a])), s1 = arcOn(sf[b] + tb * (sf[b + 1] - sf[b]));
                if (s0 >= P - 1e-9) s0 = 0;
                if (s1 < s0 && s1 < LAND) s1 = P;
                return anchorOf(st, s0, s1);
            };
            for (const n of seams) {
                let anchor = { ...n.meta.atelier }, moved = false;
                for (const end of ["a", "b"]) {
                    if (n[end] !== id || !anchor[end]) continue;
                    const next = onto(anchor[end]);
                    if (!next) continue;
                    anchor[end] = next;
                    moved = true;
                }
                // an M:N group's ranges on the piece move the same way (seamgroup.js)
                const grouped = mapGroupRanges(anchor, id, onto);
                if (grouped !== anchor) { anchor = grouped; moved = true; }
                if (moved) ops.push({ op: "set", id: n.id, fields: { meta: { ...n.meta, atelier: anchor } } });
            }
        }));
        return ops;
    }

    // An unfolded piece's whole from its half (spec §6): the half's open outline (its sides but
    // the fold side, which comes last) and its mirror across the axis, chained and closed by the
    // kernel (profile_mirror, profile_chain, profile_close_loop). The whole starts where the half
    // does: its sides 0..N-2 are the half's, N-1+j the half's side N-2-j mirrored (run backwards).
    // The half's holes, internal lines and notches with their mirrors, then `extra`'s (the whole's
    // own: {holes, internal, notches on outline `notchesFrom`}). -> {path, internal, notches, allowance}
    wholeOf(half, axis, extra = {}) {
        const f = this.f, hp = half.path, N = hp.segments.length;
        if (N < 2) throw new Error("unfold: the half has too few sides");
        const [x0, y0, x1, y1] = axis, mirror = (q) => f("profile_mirror")(q, x0, y0, x1 - x0, y1 - y0);
        const open = { start: hp.start, segments: hp.segments.slice(0, N - 1) };
        const owned = [], own = (h) => { owned.push(h); return h; };
        let path;
        try {
            const p = own(this.profileOf(open)), q = own(mirror(p));
            const { start, segments } = this.pathJson(own(f("profile_close_loop")(own(f("profile_chain")(Uint32Array.of(p, q), CHAIN_TOL)))));
            path = { start, segments };
        } finally { owned.forEach((h) => f("profile_free")(h)); }
        if (path.segments.length !== 2 * N - 2 || Math.hypot(path.start[0] - hp.start[0], path.start[1] - hp.start[1]) > 1e-6)
            throw new Error("unfold: the kernel did not chain the half and its mirror end to end");
        const mirrored = (l) => { const r = this.withPath({ start: l.start, segments: l.segments }, (q) => this.pathOf(mirror(q))); return { start: r.start, segments: r.segments }; };
        const holes = [...(hp.holes ?? []), ...(hp.holes ?? []).map(mirrored), ...(extra.holes ?? [])];
        if (holes.length) path.holes = holes;
        const internal = [...(half.internal ?? []), ...(half.internal ?? []).map((l) => ({ ...l, path: mirrored(l.path) })), ...(extra.internal ?? [])];
        const reflect = reflector(axis);
        // the half's notches stand at their own arc lengths (the whole runs the half's sides first);
        // one on the fold side is gone with it
        const notches = this.withPath(open, (op) => this.withPath({ start: path.start, segments: path.segments }, (wp) => {
            const L = this.openLength(op), samples = this.samplesOf(wp), sides = this.sideStarts(wp, f("profile_length")(wp, ACC)[0], path.segments.length);
            const mine = (half.notches ?? []).filter((nt) => nt.at <= L + 1e-9);
            const mirrors = mine.map((nt) => { const r = f("profile_point_at_length")(op, nt.at, ACC); return { ...nt, at: arcAt(samples, sides, reflect([r[0], r[1]])).s }; });
            return [...mine, ...mirrors];
        }));
        if (extra.notches?.length) notches.push(...this.notchesOnto({ notches: extra.notches }, extra.notchesFrom, path));
        const a = half.allowance ?? [10];
        const allowance = a.length === N && N > 1 ? [...a.slice(0, N - 1), ...a.slice(0, N - 1).reverse()] : a;
        return { path, internal, notches, allowance };
    }
    // An unfolded piece's whole after an edit took outline `oldW` to `newW` (spec §6): the half
    // holding the edit becomes the half, mirrored back (profile_mirror, profile_reversed) when it
    // was the mirrored side, its two fold ends put back on the axis, and the whole rebuilt from it.
    // The sides that did not change say which half was edited (the half's first: a move of a fold
    // end changes both). null when neither half's sides changed (a hole edit).
    // -> {path, fields} (fields: internal, notches, allowance and the meta with the new half)
    refolded(node, U, oldW, newW) {
        const f = this.f, half = U.half.path, N = half.segments.length, T = 2 * N - 2, T2 = newW.segments.length;
        if (!oldW || oldW.segments.length !== T) return null;
        const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
        const hSame = eq(newW.start, oldW.start) && eq(newW.segments.slice(0, N - 1), oldW.segments.slice(0, N - 1));
        const mSame = eq(newW.segments.slice(T2 - (N - 1)), oldW.segments.slice(N - 1));
        if (hSame && mSame) return null;
        const k = T2 - (N - 1);          // the edited half's sides (the other kept its N - 1)
        if (k < 1) throw new Error("unfold: a half needs a side besides the fold");
        const [x0, y0, x1, y1] = U.axis;
        let open, mirrored = false;
        if (!hSame) open = { start: newW.start, segments: newW.segments.slice(0, k) };
        else {
            mirrored = true;
            const back = { start: m.segmentEnd(newW.segments[N - 2]), segments: newW.segments.slice(N - 1) };
            open = this.withPath(back, (p) => {
                const q = f("profile_mirror")(p, x0, y0, x1 - x0, y1 - y0);
                try { return this.pathOf(f("profile_reversed")(q)); } finally { f("profile_free")(q); }
            });
        }
        // the fold's two ends move only along the axis
        const proj = projector(U.axis), segments = open.segments.map((s) => JSON.parse(JSON.stringify(s)));
        const start = proj(open.start), d0 = [start[0] - open.start[0], start[1] - open.start[1]];
        if (segments[0].type === "bezier") segments[0].c1 = [segments[0].c1[0] + d0[0], segments[0].c1[1] + d0[1]];
        const last = segments.at(-1), e = m.segmentEnd(last), end = proj(e), d1 = [end[0] - e[0], end[1] - e[1]];
        if (last.to) last.to = end; else if (last.points) last.points[last.points.length - 1] = end;
        if (last.type === "bezier") last.c2 = [last.c2[0] + d1[0], last.c2[1] + d1[1]];
        const path = { start, segments: [...segments, { type: "line", to: [...start] }], ...(half.holes ? { holes: half.holes } : {}) };
        const per = node.allowance ?? [10], hA = U.half.allowance ?? per;
        let allowance;
        if (per.length === T2 && T2 > 1) {
            const region = mirrored ? per.slice(N - 1).reverse() : per.slice(0, k);
            allowance = [...region, hA.length === N ? hA[N - 1] : region[0]];
        } else allowance = hA.length === k + 1 || hA.length === 1 ? hA : [hA[0]];
        const newHalf = { path, internal: U.half.internal ?? [], notches: this.notchesOnto({ notches: U.half.notches ?? [] }, half, path), allowance };
        const hi = (U.half.internal ?? []).length, hn = (U.half.notches ?? []).length, hh = (half.holes ?? []).length;
        const whole = this.wholeOf(newHalf, U.axis, {
            holes: (newW.holes ?? []).slice(2 * hh), internal: (node.internal ?? []).slice(2 * hi),
            notches: (node.notches ?? []).slice(2 * hn), notchesFrom: newW,
        });
        this.checkHoles(whole.path);
        return {
            path: whole.path,
            fields: { internal: whole.internal, notches: whole.notches, allowance: whole.allowance, meta: m.atelierMeta(node.meta, "unfold", { axis: U.axis, half: newHalf }) },
        };
    }
    // Unfold (spec §6): piece `id` made whole across its straight side `side`, the fold. The half
    // is kept re-indexed to start where the fold side ends, the fold side last (so the whole's
    // first sides are the half's); its seams follow their sides, one on the fold side is dropped.
    // -> {ops, dropped: seam ids}; Atelier.commit(ops, "unfold", id) re-anchors the rest.
    unfoldOps(id, side) {
        const { node, path } = this.pieceOf(id), nodes = this.nodes(), segs = path.segments, N = segs.length;
        if (linkOf(node)) throw new Error("unfold: the piece is linked: unlink it first");
        if (unfoldOf(node)) throw new Error("unfold: the piece is unfolded already");
        if (!Number.isInteger(side) || side < 0 || side >= N) throw new Error(`unfold: no side ${side + 1}`);
        if (segs[side].type !== "line") throw new Error("unfold: click a straight side");
        if (N < 3) throw new Error("unfold: the piece needs three sides or more");
        const a = m.pathPoints(path)[side], b = m.segmentEnd(segs[side]), axis = [a[0], a[1], b[0], b[1]];
        const at = (j) => (j - side - 1 + N) % N;     // a side's index in the half
        const sides = this.sidesOf(id), P = sides.at(-1), s0 = sides[side + 1] % P, foldAt = P - (sides[side + 1] - sides[side]);
        const notches = (node.notches ?? []).map((nt) => ({ ...nt, at: (((nt.at - s0) % P) + P) % P })).filter((nt) => nt.at <= foldAt + 1e-9);
        const per = node.allowance ?? [10];
        const half = {
            path: { start: [...b], segments: [...segs.slice(side + 1), ...segs.slice(0, side + 1)].map((s) => JSON.parse(JSON.stringify(s))), ...(path.holes ? { holes: path.holes } : {}) },
            internal: node.internal ?? [], notches,
            allowance: per.length === N ? per.map((_, j) => per[(j + side + 1) % N]) : per,
        };
        const whole = this.wholeOf(half, axis);
        this.checkHoles(whole.path);
        const dropped = [], moves = [];
        for (const n of nodes) {
            if (n.kind !== "garment.seam" || !n.meta?.atelier || (n.a !== id && n.b !== id && !namesPiece(n, id))) continue;
            let anchor = { ...n.meta.atelier };
            let gone = false;
            for (const end of ["a", "b"]) {
                if (n[end] !== id || !anchor[end]) continue;
                const [sf, tf, tt, st = sf] = anchor[end], x = at(sf), y = at(st);
                // on the fold side, or running round through it
                if (x === N - 1 || y === N - 1 || x > y || (x === y && tf > tt)) { gone = true; break; }
                anchor[end] = x === y ? [x, tf, tt] : [x, tf, tt, y];
            }
            // an M:N group's ranges follow their sides; one on the fold side dissolves the group
            anchor = mapGroupRanges(anchor, id, ([sf, tf, tt, st = sf]) => {
                const x = at(sf), y = at(st);
                return x === N - 1 || y === N - 1 || x > y || (x === y && tf > tt) ? null : x === y ? [x, tf, tt] : [x, tf, tt, y];
            });
            if (gone) dropped.push(n.id);
            else moves.push({ op: "set", id: n.id, fields: { meta: { ...n.meta, atelier: anchor } } });
        }
        return {
            ops: [...m.setOutline(nodes, id, whole.path),
                ...m.setPattern(nodes, id, { internal: whole.internal, notches: whole.notches, allowance: whole.allowance, meta: m.atelierMeta(node.meta, "unfold", { axis, half }) }),
                ...moves, ...m.removeSeams(nodes, dropped)],
            dropped,
        };
    }
    // Fold back (spec §6): the unfolded piece `id` is its half again -- outline, internal lines,
    // notches and allowance as the half has them. A seam on the half's sides keeps its anchor (the
    // whole's first sides are the half's); one on the mirrored side is dropped.
    // -> {ops, dropped}; Atelier.commit(ops, "fold back", id) re-anchors the rest.
    foldBackOps(id) {
        const { node } = this.pieceOf(id), nodes = this.nodes(), U = unfoldOf(node);
        if (!U) throw new Error("fold back: the piece is not unfolded");
        const N = U.half.path.segments.length, dropped = [];
        const mirrored = ([sf, tf, tt, st = sf]) => sf >= N - 1 || st >= N - 1 || sf > st || (sf === st && tf > tt);
        for (const n of nodes) {
            if (n.kind !== "garment.seam" || (n.a !== id && n.b !== id)) continue;
            for (const end of ["a", "b"]) {
                if (n[end] !== id) continue;
                if (mirrored(n.meta?.atelier?.[end] ?? [N, 0, 0])) { dropped.push(n.id); break; }
            }
        }
        // an M:N group with a range on the mirrored side is dissolved (its members left as plain seams)
        const dissolved = nodes.filter((n) => !dropped.includes(n.id) && namesPiece(n, id))
            .map((n) => ({ n, atelier: mapGroupRanges(n.meta.atelier, id, (a) => (mirrored(a) ? null : a)) }))
            .filter((x) => x.atelier !== x.n.meta.atelier)
            .map(({ n, atelier }) => ({ op: "set", id: n.id, fields: { meta: { ...n.meta, atelier } } }));
        const h = U.half;
        return {
            ops: [...m.setOutline(nodes, id, h.path),
                ...m.setPattern(nodes, id, { internal: h.internal ?? [], notches: h.notches ?? [], allowance: h.allowance ?? node.allowance ?? [10], meta: m.atelierMeta(node.meta, "unfold") }),
                ...dissolved, ...m.removeSeams(nodes, dropped)],
            dropped,
        };
    }

    // ---- point editing (spec §3): the kernel's profile_insert/remove/smooth_vertex ----
    // Each throws, changing nothing, where the kernel refuses (the message names the point).
    // The notches of `node` re-placed from outline `oldPath` onto `newPath`: each at its old
    // point's nearest arc length (filletPath's rule).
    notchesOnto(node, oldPath, newPath) {
        const f = this.f;
        if (!node.notches?.length) return node.notches ?? [];
        return this.withPath({ start: oldPath.start, segments: oldPath.segments }, (old) => this.withPath({ start: newPath.start, segments: newPath.segments }, (p) => {
            const samples = this.samplesOf(p), sides = this.sideStarts(p, f("profile_length")(p, ACC)[0], newPath.segments.length);
            return node.notches.map((nt) => { const at = f("profile_point_at_length")(old, nt.at, ACC); return { ...nt, at: arcAt(samples, sides, [at[0], at[1]]).s }; });
        }));
    }
    pieceOf(id) {
        const nodes = m.byId(this.nodes()), node = nodes.get(id), path = nodes.get(`${id}_outline`)?.path;
        if (!node || !path) throw new Error(`no pattern ${id}`);
        return { node, path };
    }
    // One kernel call on a path JSON, its result as path JSON; a refusal says `what` (the point).
    vertexCall(path, name, what, ...args) {
        try { return this.withPath(path, (p) => this.pathOf(this.f(name)(p, ...args))); }
        catch (e) { throw new Error(`${what}: ${text(e).replace(/^profile_\w+: /, "")}`); }
    }
    // A point on piece `id`'s outline at arc length `s` (an edge's double click): the side it
    // splits and where along it (the kernel's side table), then the batch (model.insertPointOps).
    insertPointOps(id, s) {
        const { path } = this.pieceOf(id), sides = this.sidesOf(id), P = sides.at(-1);
        s = ((s % P) + P) % P;
        let side = 0;
        for (let i = 0; i + 1 < sides.length; i++) if (sides[i] <= s) side = i;
        const out = this.vertexCall(path, "profile_insert_vertex", "insert point", s);
        if (out.segments.length !== path.segments.length + 1) throw new Error("insert point: the kernel did not split one side");
        const t0 = (s - sides[side]) / (sides[side + 1] - sides[side]);
        return m.insertPointOps(this.nodes(), id, { ...out, ...(path.holes ? { holes: path.holes } : {}) }, side, t0);
    }
    // Points `indices` of piece `id`'s outline removed in one batch, the highest first (lower
    // indices stand while a higher one goes; point 0 last, which makes old point 1 the start).
    removePointsOps(id, indices) {
        const f = this.f, { node, path } = this.pieceOf(id);
        const steps = [];
        let cur = path;
        for (const i of [...new Set(indices)].sort((a, b) => b - a)) {
            const count = cur.segments.length;
            const sides = this.withPath({ start: cur.start, segments: cur.segments }, (p) => this.sideStarts(p, f("profile_length")(p, ACC)[0], count));
            const next = this.vertexCall(cur, "profile_remove_vertex", `point ${i + 1}`, i);
            const before = (i - 1 + count) % count, la = sides[before + 1] - sides[before], lb = sides[i + 1] - sides[i];
            steps.push({ vertex: i, count, w: la / (la + lb) });
            cur = { ...next, ...(path.holes ? { holes: path.holes } : {}) };
        }
        this.checkHoles(cur);
        return m.removePointsOps(this.nodes(), id, cur, steps, this.notchesOnto(node, path, cur));
    }
    // Points made curve points (`smooth` true) or corners: `points` [{index, smooth}], in turn.
    smoothPointsOps(id, points) {
        const { node, path } = this.pieceOf(id);
        let cur = path;
        for (const { index, smooth } of points) cur = { ...this.vertexCall(cur, "profile_smooth_vertex", `point ${index + 1}`, index, !!smooth), ...(path.holes ? { holes: path.holes } : {}) };
        this.checkHoles(cur);
        return m.smoothPointsOps(this.nodes(), id, cur, this.notchesOnto(node, path, cur));
    }
    // The same on internal entry `line` of piece `id` (an open line or a closed shape): one batch.
    // insert: at the line's point nearest `at`; remove: `indices`; smooth: `points`.
    internalPointOps(id, line, { op, at, indices, points }) {
        const f = this.f, entry = this.pieceOf(id).node.internal?.[line];
        if (!entry?.path) throw new Error(`no internal line ${line + 1}`);
        let cur = entry.path;
        if (op === "insert") {
            const s = this.withPath(cur, (p) => this.nearestArc(p, at, m.isClosedPath(cur)));
            cur = this.vertexCall(cur, "profile_insert_vertex", "insert point", s);
        } else if (op === "remove") {
            for (const i of [...new Set(indices)].sort((a, b) => b - a)) cur = this.vertexCall(cur, "profile_remove_vertex", `point ${i + 1}`, i);
        } else if (op === "smooth") {
            for (const { index, smooth } of points) cur = this.vertexCall(cur, "profile_smooth_vertex", `point ${index + 1}`, index, !!smooth);
        } else throw new Error(`no point op ${op}`);
        return m.setInternalPath(this.nodes(), id, line, cur);
    }
    // The arc length along profile p nearest point `at`, from the kernel's 1 mm samples: an open
    // path's run without the closing chord profile_length adds.
    nearestArc(p, [x, y], closed) {
        const L = closed ? this.f("profile_length")(p, ACC)[0] : this.openLength(p);
        const pts = [];
        this.rows(this.f("profile_divide_by_length")(p, STEP, ACC)).forEach((r, i) => { if (i * STEP < L) pts.push([i * STEP, r[0], r[1]]); });
        const end = this.f("profile_point_at_length")(p, closed ? 0 : L, ACC);
        pts.push([L, end[0], end[1]]);
        let best = { s: 0, d: Infinity };
        for (let i = 0; i + 1 < pts.length; i++) {
            const [sa, ax, ay] = pts[i], [sb, bx, by] = pts[i + 1], dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
            const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
            const d = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
            if (d < best.d) best = { s: sa + t * (sb - sa), d };
        }
        return best.s;
    }
    // The page's point message: {id, line?, op: insert|remove|smooth, s?, at?, indices?, points?}
    // -> ops (Atelier.commit(ops, "point", line == null ? id : null) re-anchors the seams).
    pointOps(d) {
        if (d.line != null) return this.internalPointOps(d.id, d.line, d);
        this.baseOnly();
        if (d.op === "insert") return this.insertPointOps(d.id, d.s);
        if (d.op === "remove") return this.removePointsOps(d.id, d.indices);
        if (d.op === "smooth") return this.smoothPointsOps(d.id, d.points);
        throw new Error(`no point op ${d.op}`);
    }

    // ---- grading (A3 spec): sizes, grade rules, the size switch ----
    // The garment's size table {sizes, base, current}, or null (an ungraded garment).
    grading(nodes = this.nodes()) { return G.gradingOf(m.byId(nodes).get("garment")); }
    // Refuses a shape edit in a size other than the base (spec §3).
    baseOnly() {
        const t = this.grading();
        if (t && t.current !== t.base) throw new Error(`edit the shape in the base size (${t.base})`);
    }
    // Piece `id`'s grade, or for a piece without one its outline as base and no rules (an
    // ungraded piece is the same in every size).
    gradeOfPiece(id, nodes = this.nodes()) {
        const byId = m.byId(nodes), path = byId.get(`${id}_outline`)?.path;
        if (!path) throw new Error(`no pattern ${id}`);
        return G.gradeOf(byId.get(id)) ?? { base: bare(path), rules: {} };
    }
    // A path through m6 by the kernel (profile_transform2d), as path JSON without holes.
    pathThrough(path, m6) { return bare(this.withPath({ start: path.start, segments: path.segments }, (p) => this.pathOf(this.f("profile_transform2d")(p, Float64Array.from(m6))))); }
    // Each side's start arc length and the perimeter (n + 1 numbers) of a path's outer loop.
    sideArcs(path) { return this.withPath({ start: path.start, segments: path.segments }, (p) => this.sideStarts(p, this.f("profile_length")(p, ACC)[0], path.segments.length)); }
    // The commit's first grading pass: in a graded size, or when the batch switches size, each
    // piece whose outline the batch's ops reshaped has its internal lines moved by the change of
    // its affine fit (base -> outline, grading.js affineFit) and its notches kept at their side
    // fraction. A piece placed (moved or turned whole) is left alone, and so is an unfolded one
    // (its whole is rebuilt from its half: spec §6).
    gradeFollowOps(priorList) {
        const before = m.byId(priorList), nodes = this.nodes(), now = m.byId(nodes);
        const t0 = this.grading(priorList), t = this.grading(nodes);
        if (!t) return [];
        const switching = t0?.current !== t.current;
        if (!switching && t.current === t.base) return [];
        const ops = [];
        for (const id of now.get("garment")?.patterns ?? []) {
            const old = before.get(`${id}_outline`)?.path, cur = now.get(`${id}_outline`)?.path, node = now.get(id);
            if (!old || !cur || sameOutline(old, cur) || !G.sameShape(old, cur) || unfoldOf(node)) continue;
            const gradeSet = !sameJson(G.gradeOf(before.get(id)), G.gradeOf(node));
            if (!switching && !gradeSet && G.rigidMotion(old, cur)) continue;
            const base = G.gradeOf(node)?.base ?? bare(old);
            if (!G.sameShape(base, cur)) continue;          // a reshape: the record pass refuses it
            const vb = G.vertices(base), inv = G.invertAffine(G.affineFit(vb, G.vertices(old)));
            const M = inv ? G.composeAffine(G.affineFit(vb, G.vertices(cur)), inv) : G.affineFit(G.vertices(old), G.vertices(cur));
            const fields = {};
            if (node.internal?.length && !G.isIdentity(M, 1e-12))
                fields.internal = node.internal.map((l) => ({ ...l, path: this.pathThrough(l.path, M) }));
            if (node.notches?.length) fields.notches = G.notchesByFraction(node.notches, this.sideArcs(old), this.sideArcs(cur));
            if (Object.keys(fields).length) ops.push(...m.setPattern(nodes, id, fields));
        }
        return ops;
    }
    // The commit's last grading pass: every piece whose outline the batch changed (a rebuilt
    // partner too) gets its grade from it. In the base size the base path follows the outline (the
    // rules carried onto a point more or fewer by position, where the ops did not shift them); in
    // another size each vertex's move from the base becomes its rule for that size, and anything
    // else (a handle on its own, a point more or fewer) is refused. A piece placed whole keeps its
    // rules, turned with it.
    gradeRecordOps(priorList, midList) {
        const before = m.byId(priorList), mid = m.byId(midList), nodes = this.nodes(), now = m.byId(nodes);
        const t0 = this.grading(priorList), t = this.grading(nodes);
        if (!t) return [];
        const size = t.current, switching = t0?.current !== t.current, ops = [];
        for (const id of now.get("garment")?.patterns ?? []) {
            const old = before.get(`${id}_outline`)?.path, cur = now.get(`${id}_outline`)?.path, node = now.get(id);
            if (!old || !cur || sameOutline(old, cur)) continue;
            const g = G.gradeOf(node), pg = G.gradeOf(before.get(id)), mg = G.gradeOf(mid.get(id));
            const gradeSet = !sameJson(pg, mg);
            let next = null;
            const motion = !switching && !gradeSet && G.rigidMotion(old, cur);
            if (motion) {
                if (!g) continue;
                next = { base: size === t.base ? bare(cur) : this.pathThrough(g.base, motion), rules: G.turnRules(g.rules, motion) };
            } else if (size === t.base) {
                if (!g) continue;
                // the rules the ops wrote (a point op shifts them), else those before
                const src = gradeSet ? mid.get(`${id}_outline`)?.path ?? old : old, rules = (gradeSet ? mg?.rules : pg?.rules) ?? g.rules ?? {};
                next = { base: bare(cur), rules: src.segments.length === cur.segments.length ? rules : G.carryRules(rules, src, cur) };
            } else {
                const base = g?.base ?? bare(old), d = G.vertexMoves(base, cur);
                if (!d) throw new Error(`edit the shape in the base size (${t.base})`);
                next = { base, rules: G.withSize(g?.rules ?? {}, size, d) };
                if (!g && !Object.keys(next.rules).length) continue;
            }
            if (!sameJson(g, next)) ops.push(...m.setPattern(nodes, id, { meta: m.atelierMeta(node.meta, "grade", next) }));
        }
        return ops;
    }
    // The ops switching the garment to size `size`: every graded piece's outline its base moved
    // by its rules for that size (holes kept), and the table's current size. The commit then moves
    // internal lines and notches, rebuilds partners, re-places slots, re-anchors seams and
    // re-distributes M:N groups. -> {ops, ids: the pieces whose outline changes}
    sizeOps(size, nodes = this.nodes()) {
        const t = this.grading(nodes);
        if (!t) throw new Error("no sizes: add sizes first");
        if (!t.sizes.includes(size)) throw new Error(`no size ${size}`);
        if (size === t.current) return { ops: [], ids: [] };
        const r = this.regradeOps({ ...t, current: size }, new Map(), nodes);
        return { ops: [this.gradingOp({ ...t, current: size }, nodes), ...r.ops], ids: r.ids };
    }
    // Switches to size `size`: one batch ("size L"), one undo step. A refusal changes nothing.
    switchSize(size) {
        const r = this.sizeOps(size);
        if (!r.ops.length) return { removed: [] };
        try { return this.commit(r.ops, `size ${size}`, r.ids); } catch (e) { throw new Error(`size ${size}: ${text(e)}`); }
    }
    gradingOp(table, nodes = this.nodes()) {
        const g = m.byId(nodes).get("garment");
        if (!g) throw new Error("no garment");
        return { op: "set", id: "garment", fields: { meta: m.atelierMeta(g.meta, "grading", table) } };
    }
    // The outlines of the graded pieces in table.current, with `grades` (id -> grade) in place of
    // their own where given, and those grades written. -> {ops, ids: the outlines that change}
    regradeOps(table, grades, nodes = this.nodes()) {
        const byId = m.byId(nodes), ops = [], ids = [];
        for (const id of byId.get("garment")?.patterns ?? []) {
            const node = byId.get(id), cur = byId.get(`${id}_outline`)?.path, g = grades.get(id) ?? G.gradeOf(node);
            if (!g || !cur) continue;
            if (grades.has(id)) ops.push(...m.setPattern(nodes, id, { meta: m.atelierMeta(node.meta, "grade", g) }));
            const next = G.gradedPath(g.base, g.rules, table.current);
            if (cur.holes) next.holes = cur.holes;
            if (!sameOutline(next, cur)) { ops.push(...m.setOutline(nodes, id, next)); ids.push(id); }
        }
        return { ops, ids };
    }
    // The size table dialog's changes (spec §4), each one batch: {op: "add", name, at?},
    // {op: "rename", from, to}, {op: "remove", name}, {op: "reorder", sizes}, {op: "base", name}.
    // Removing the current size switches to the base. -> {ops, ids}
    sizesOps(action, nodes = this.nodes()) {
        const t = this.grading(nodes), byId = m.byId(nodes);
        const grades = {};
        for (const id of byId.get("garment")?.patterns ?? []) { const g = G.gradeOf(byId.get(id)); if (g) grades[id] = g; }
        let r;
        switch (action.op) {
            case "add": r = { table: G.addSize(t, action.name, action.at ?? null), grades }; break;
            case "rename": r = G.renameSize(t, grades, action.from, action.to); break;
            case "remove": r = G.removeSize(t, grades, action.name); break;
            case "reorder": r = { table: G.reorderSizes(t, action.sizes), grades }; break;
            case "base": r = G.changeBase(t, grades, action.name); break;
            default: throw new Error(`no sizes op ${action.op}`);
        }
        const changed = new Map(Object.entries(r.grades).filter(([id, g]) => !sameJson(g, grades[id])));
        const re = this.regradeOps(r.table, changed, nodes);
        return { ops: [this.gradingOp(r.table, nodes), ...re.ops], ids: re.ids };
    }
    // Piece grades set by the grade panel's ops (spec §3), each one batch with the current size's
    // outline re-graded: {op: "rule", id, vertex, size, d: [dx, dy]}, {op: "copy", id, from, to:
    // [vertices]}, {op: "distribute", id, from, to}, {op: "proportional", ids, dw, dh}. -> {ops, ids}
    gradeOps(action, nodes = this.nodes()) {
        const t = this.grading(nodes);
        if (!t) throw new Error("no sizes: add sizes first");
        const grades = new Map();
        const set = (id, rules) => { const g = this.gradeOfPiece(id, nodes); grades.set(id, { base: g.base, rules: G.normalRules(rules) }); };
        switch (action.op) {
            case "rule": {
                if (action.size === t.base) throw new Error(`the base size's rule is 0, 0`);
                if (!t.sizes.includes(action.size)) throw new Error(`no size ${action.size}`);
                const g = this.gradeOfPiece(action.id, nodes), rules = JSON.parse(JSON.stringify(g.rules));
                rules[action.vertex] = { ...(rules[action.vertex] ?? {}), [action.size]: [Number(action.d[0]), Number(action.d[1])] };
                set(action.id, rules);
                break;
            }
            case "copy": {
                const g = this.gradeOfPiece(action.id, nodes), rules = JSON.parse(JSON.stringify(g.rules));
                for (const v of action.to) if (v !== action.from) { if (rules[action.from]) rules[v] = JSON.parse(JSON.stringify(rules[action.from])); else delete rules[v]; }
                set(action.id, rules);
                break;
            }
            case "distribute": {
                const g = this.gradeOfPiece(action.id, nodes);
                set(action.id, G.distribute(g.rules, action.from, action.to, this.sideArcs(g.base), t.sizes));
                break;
            }
            case "proportional":
                for (const id of action.ids) {
                    const g = this.gradeOfPiece(id, nodes), bounds = this.withPath(g.base, (p) => Array.from(this.f("profile_bounds")(p)));
                    set(id, G.proportional(g.base, t.sizes, t.base, Number(action.dw), Number(action.dh), bounds));
                }
                break;
            default: throw new Error(`no grade op ${action.op}`);
        }
        return this.regradeOps(t, grades, nodes);
    }

    // Show sizes (spec §5): the outlines of pieces `ids` in every size but the current one, as the
    // switch grades them (grading.js gradedPath), not committed. -> [{id, size, k (its place in
    // the table), n (sizes), beziers}]
    sizeNest(ids, nodes = this.nodes()) {
        const t = this.grading(nodes), byId = m.byId(nodes), out = [];
        if (!t) return out;
        for (const id of ids) {
            const g = G.gradeOf(byId.get(id));
            if (!g) continue;
            t.sizes.forEach((size, k) => {
                if (size !== t.current) out.push({ id, size, k, n: t.sizes.length, beziers: this.beziersOf(G.gradedPath(g.base, g.rules, size)) });
            });
        }
        return out;
    }

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
                const node = add.ops.find((o) => o.node?.kind === "garment.pattern").node;
                node.notches = notches;
                // internal lines (0 line, 1 fold, 2 dart); the holes came in with the outline
                const internal = [];
                for (let i = 0, n = this.f("garment_pattern_internal_count")(r, pid); i < n; i++) {
                    const l = this.pathOf(this.f("garment_pattern_internal")(r, pid, i));
                    internal.push({ kind: INTERNAL_KINDS[this.f("garment_pattern_internal_kind")(r, pid, i)] ?? "line", path: { start: l.start, segments: l.segments } });
                }
                if (internal.length) node.internal = internal;
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
