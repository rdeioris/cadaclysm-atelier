// The kernel facade: the one place the app calls cadaclysm_blacksmith_*. It owns a
// blacksmith document holding the garment, and hands back plain arrays for drawing.
import * as m from "./model.js";

const TOL = 0.25;        // flattening tolerance for drawing, mm
const ACC = 1e-6;        // arc-length accuracy (relative)
const STEP = 1;          // outline sample spacing for picking, mm
const NOTCH_KINDS = ["slit", "v", "t", "castle", "u"];

export class Atelier {
    constructor(k) {
        this.k = k;
        this.f = (n) => k[`cadaclysm_blacksmith_${n}`];
        this.d = this.f("document_new")("mm");
        this.g = 0;          // the evaluated garment handle (a copy), 0 when none
        this.previewing = null;
    }
    free() { this.dropGarment(); this.f("document_free")(this.d); }
    dropGarment() { if (this.g) { this.f("garment_free")(this.g); this.g = 0; } }
    nodes() { return JSON.parse(this.f("document_nodes")(this.d)); }

    evaluate() {
        this.dropGarment();
        this.f("document_evaluate")(this.d, false);
        const has = this.nodes().some((n) => n.id === "garment");
        if (has && this.f("document_result_kind")(this.d, "garment") === "garment")
            this.g = this.f("document_result_garment")(this.d, "garment");
    }
    apply(ops, message) {
        if (!ops.length) return;
        this.f("document_apply")(this.d, JSON.stringify({ op: "batch", ops }), message ?? null);
        this.evaluate();
    }
    preview(ops) {
        if (!this.previewing) this.f("document_preview_begin")(this.d);
        this.previewing = ops;
        this.f("document_preview")(this.d, JSON.stringify({ op: "batch", ops }));
        this.evaluate();
    }
    endPreview(commit) {
        const ops = this.previewing;
        this.previewing = null;
        this.f("document_end_preview")(this.d);
        if (commit && ops) this.apply(ops, "edit"); else this.evaluate();
    }
    undo() { this.f("document_undo")(this.d); this.evaluate(); }
    redo() { this.f("document_redo")(this.d); this.evaluate(); }
    save() { return this.f("document_save")(this.d); }
    load(text) { this.dropGarment(); this.f("document_free")(this.d); this.d = this.f("document_load")(text); this.evaluate(); }
    reset(ops) { this.dropGarment(); this.f("document_free")(this.d); this.d = this.f("document_new")("mm"); this.apply(ops, "new"); }

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
    rows(arr) { const out = []; for (let i = 0; i + 9 < arr.length; i += 10) out.push(arr.subarray ? arr.subarray(i, i + 10) : arr.slice(i, i + 10)); return out; }

    drawing(id) {
        const node = m.byId(this.nodes()).get(id);
        const pid = this.patternIndex(id);
        const [gx, gy] = node.grain ?? [0, 1];
        return this.withOutline(id, (p) => {
            const { points, offsets } = this.f("profile_polylines")(p, TOL);
            const sew = [];
            for (let j = offsets[0]; j < offsets[1]; j++) sew.push(points[3 * j], points[3 * j + 1]);
            const perimeter = this.f("profile_length")(p, ACC)[0];
            const samples = [];
            this.rows(this.f("profile_divide_by_length")(p, STEP, ACC)).forEach((r, i) => samples.push(i * STEP, r[0], r[1]));
            const sides = this.sideStarts(p, perimeter);
            const bounds = Array.from(this.f("profile_bounds")(p));
            const notchRaw = Array.from(this.f("garment_pattern_notches")(this.g, pid));
            const notches = [];
            for (let i = 0; i + 2 < notchRaw.length; i += 3) {
                const r = this.f("profile_point_at_length")(p, notchRaw[i], ACC);
                notches.push([r[0], r[1], notchRaw[i + 1]]);
            }
            const internal = (node.internal ?? []).map((l) => ({ kind: l.kind, points: this.openPoints(l.path) }));
            const cx = (bounds[0] + bounds[2]) / 2, cy = (bounds[1] + bounds[3]) / 2;
            const half = 0.4 * Math.min(bounds[2] - bounds[0], bounds[3] - bounds[1]) || 10;
            const gl = Math.hypot(gx, gy) || 1;
            const grain = [cx - (gx / gl) * half, cy - (gy / gl) * half, cx + (gx / gl) * half, cy + (gy / gl) * half];
            return {
                id, label: node.label, fabric: node.fabric, layer: node.layer ?? 0,
                sew, cut: Array.from(this.f("garment_cut_line")(this.g, pid, TOL)),
                samples, sides, notches, internal, grain, bounds,
            };
        });
    }
    drawings() {
        const g = m.byId(this.nodes()).get("garment");
        return g && this.g ? g.patterns.map((id) => this.drawing(id)) : [];
    }
    // An internal line's path JSON flattened: built as a temporary profile.path node.
    openPoints(path) {
        const tmp = this.f("document_new")("mm");
        try {
            this.f("document_apply")(tmp, JSON.stringify({ op: "add", node: { id: "l", kind: "profile.path", path } }), null);
            this.f("document_evaluate")(tmp, false);
            const p = this.f("document_result_profile")(tmp, "l");
            try {
                const { points, offsets } = this.f("profile_polylines")(p, TOL);
                const out = [];
                for (let j = offsets[0]; j < offsets[offsets.length - 1]; j++) out.push(points[3 * j], points[3 * j + 1]);
                return out;
            } finally { this.f("profile_free")(p); }
        } finally { this.f("document_free")(tmp); }
    }
    // Arc length where each path segment starts, found by bisection on the segment index the
    // kernel reports at an arc length, then the perimeter.
    sideStarts(p, perimeter) {
        const seg = (s) => this.f("profile_point_at_length")(p, Math.min(s, perimeter), ACC)[7];
        const starts = [0];
        let s = 0, cur = seg(0);
        while (true) {
            let lo = s, hi = perimeter, last = seg(perimeter);
            if (last === cur) break;
            let step = STEP;               // walk forward to bracket the next change
            hi = s + step;
            while (hi < perimeter && seg(hi) === cur) { lo = hi; hi += step; }
            hi = Math.min(hi, perimeter);
            for (let i = 0; i < 60 && hi - lo > 1e-9; i++) { const mid = (lo + hi) / 2; if (seg(mid) === cur) lo = mid; else hi = mid; }
            starts.push(hi);
            s = hi; cur = seg(hi);
        }
        starts.push(perimeter);
        return starts;
    }
    sideAt(id, s) {
        const { sides } = this.drawing(id);
        let i = 0;
        while (i + 2 < sides.length && s >= sides[i + 1]) i++;
        const t = (s - sides[i]) / (sides[i + 1] - sides[i]);
        return { side: i, t: Math.round(t * 1e9) / 1e9 };
    }
    arcAt(id, side, t) {
        const { sides } = this.drawing(id);
        return sides[side] + t * (sides[side + 1] - sides[side]);
    }

    seams() {
        if (!this.g) return [];
        const nodes = this.nodes();
        return nodes.filter((n) => n.kind === "garment.seam").map((n) => ({
            id: n.id, a: n.a, b: n.b, a_from: n.a_from, a_to: n.a_to, b_from: n.b_from, b_to: n.b_to, reversed: !!n.reversed,
            points_a: Array.from(this.f("garment_range_points")(this.g, this.patternIndex(n.a), n.a_from, n.a_to, TOL)),
            points_b: Array.from(this.f("garment_range_points")(this.g, this.patternIndex(n.b), n.b_from, n.b_to, TOL)),
        }));
    }
    issues() {
        if (!this.g) return [];
        const n = this.f("garment_validate")(this.g, 0.01);
        return Array.from({ length: n }, (_, i) => {
            const [severity, kind, ratio] = this.f("garment_issue")(this.g, i);
            return { severity, kind, ratio, message: this.f("garment_issue_message")(this.g, i) };
        });
    }
    mapped(id, fn) {
        return this.withOutline(id, (p) => {
            const q = fn(p);
            try { return JSON.parse(this.f("document_profile_path")(q)); } finally { this.f("profile_free")(q); }
        });
    }
    // m6 is the kernel's row-major 2x3: x' = m0 x + m1 y + m2, y' = m3 x + m4 y + m5.
    transformed(id, m6) { return this.mapped(id, (p) => this.f("profile_transform2d")(p, Float64Array.from(m6))); }
    mirrored(id, [px, py, dx, dy]) { return this.mapped(id, (p) => this.f("profile_mirror")(p, px, py, dx, dy)); }

    toDxf() { return this.f("garment_to_aama")(this.g, 0.1, null); }
    fromDxf(text) {
        const r = this.f("garment_from_aama")(text);
        try {
            let nodes = this.nodes();
            const fabric = nodes.find((n) => n.kind === "garment.fabric")?.id;
            const ops = [];
            for (const pid of this.f("garment_patterns")(r)) {
                const o = this.f("garment_pattern_outline")(r, pid);
                let path;
                try { path = JSON.parse(this.f("document_profile_path")(o)); } finally { this.f("profile_free")(o); }
                const [gx, gy] = this.f("garment_pattern_info")(r, pid);
                const allowance = Array.from(this.f("garment_pattern_allowance")(r, pid));
                const raw = Array.from(this.f("garment_pattern_notches")(r, pid));
                const notches = [];
                for (let i = 0; i + 2 < raw.length; i += 3) notches.push({ at: raw[i], kind: NOTCH_KINDS[raw[i + 1]] ?? "slit", depth: raw[i + 2] });
                // a garment's pattern names must be distinct: suffix a repeat
                const base = this.f("garment_pattern_name")(r, pid);
                const taken = new Set(nodes.filter((n) => n.kind === "garment.pattern").map((n) => n.label));
                let label = base;
                for (let n = 2; taken.has(label); n++) label = `${base} ${n}`;
                const add = m.addPattern(nodes, { label, path, fabric, allowance, grain: [gx, gy] });
                add.ops[1].node.notches = notches;
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
