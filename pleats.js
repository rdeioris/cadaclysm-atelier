// Darts and pleats in the 2D window (spec S2 §5). Pure, as tools.js and simprops.js: gesture
// machines returning {ops?, overlay?, select?, status?, done?, ...}, the property panel's fields
// and the requests the page sends the worker. The geometry is the kernel's: a dart closes or
// rotates, and pleats are laid out, by garment_close_dart_* / garment_rotate_dart /
// garment_add_pleats on a scratch copy of the garment (kernel.js), so nothing here computes a
// fold line or an outline. What is here is the tool's own arithmetic: a pleat set's spec from two
// drags, its numbers, and which pleat group an internal line belongs to.
//
// A pattern's pleat groups are its `pleats` param (kinds/garment.rs): [{spec: {line, across,
// count, depth, kind, direction, top_tack}, internal: [line indices], tacks: [tack node ids]}].
// `spec.across` is the kernel's: its extent across `line` is the width the pleated stretch
// finishes at. The tool's drag across is the stretch before folding (the "area"): the finished
// width is the area less the pleats' intake (2 · depth a knife pleat, 4 · depth a box pleat).
import { pieceOf } from "./simtools.js";

export const PLEAT_DEPTH = 20;           // mm: a new set's depth
export const PLEAT_KINDS = ["knife", "box"];
export const PLEAT_DIRECTIONS = ["left", "right"];
const DRAG_PX = 3;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const num = (v) => typeof v === "number" && Number.isFinite(v);
const truthy = (v) => v === true || v === "true";
const round = (v) => Math.round(v * 1e6) / 1e6;
const pt = (p) => [round(p[0]), round(p[1])];

// The width one pleat takes in.
export const intakeOf = (kind, depth) => (kind === "box" ? 4 : 2) * depth;

// The unit normal to `line` on the side `v` points to, and v's extent along it; null when the
// line has no length.
function across(line, v) {
    const dx = line[1][0] - line[0][0], dy = line[1][1] - line[0][1], len = Math.hypot(dx, dy);
    if (!(len > 0)) return null;
    let n = [-dy / len, dx / len], ext = v[0] * n[0] + v[1] * n[1];
    if (ext < 0) { n = [-n[0], -n[1]]; ext = -ext; }
    return { n, ext };
}

// A pleat set from the tool's two drags: `line` the placement (its start's edge takes the top
// tacks), `drag` the drag across the pleated area. `prev` carries the numbers last chosen. The
// count is as many pleats as leave as much flat between them as each takes in, at least one.
// -> {line, normal, area, count, depth, kind, direction, top_tack}, or null when the line has no
// length or the drag no width across it.
export function pleatDraft(line, drag, prev = {}) {
    const a = across(line, [drag[1][0] - drag[0][0], drag[1][1] - drag[0][1]]);
    if (!a || !(a.ext > 0)) return null;
    const kind = prev.kind ?? "knife", depth = prev.depth ?? PLEAT_DEPTH;
    const count = prev.count ?? Math.max(1, Math.floor(a.ext / (2 * intakeOf(kind, depth))));
    return { line: [pt(line[0]), pt(line[1])], normal: a.n, area: a.ext, count, depth, kind,
        direction: prev.direction ?? "right", top_tack: prev.top_tack ?? true };
}

// The kernel's spec for a draft (the document's `spec`): `across` from the line's start, along
// the normal, as long as the finished width. Throws when the intake fills the area.
export function pleatSpec(d) {
    const intake = d.count * intakeOf(d.kind, d.depth), finish = d.area - intake;
    if (!(finish > 1e-6)) throw new Error(`pleats: ${d.count} × ${d.depth} mm ${d.kind} pleats take in ${round(intake)} mm, as much as the ${round(d.area)} mm dragged: fewer or shallower pleats`);
    const [p] = d.line;
    return { line: [pt(d.line[0]), pt(d.line[1])], across: [pt(p), pt([p[0] + d.normal[0] * finish, p[1] + d.normal[1] * finish])],
        count: d.count, depth: d.depth, kind: d.kind, direction: d.direction, top_tack: !!d.top_tack };
}

// A stored spec as a draft again (to edit a group's numbers): the area is the finished width plus
// the intake, so a new count or depth keeps the stretch the pleats take.
export function draftOfSpec(spec) {
    const v = [spec.across[1][0] - spec.across[0][0], spec.across[1][1] - spec.across[0][1]];
    const a = across(spec.line, v);
    if (!a) throw new Error("pleats: the group's line has no length");
    return { line: spec.line.map(pt), normal: a.n, area: a.ext + spec.count * intakeOf(spec.kind, spec.depth),
        count: spec.count, depth: spec.depth, kind: spec.kind, direction: spec.direction, top_tack: !!spec.top_tack };
}

// ---- the panel's numbers: a draft's (the tool's) and a group's (a selected pleat line) ----
const yesNo = [{ value: "false", label: "no" }, { value: "true", label: "yes" }];
// The fields for a draft; `prefix` keeps a group's keys apart from a line's ("pleat_").
export function pleatFields(d, prefix = "") {
    return [
        { key: `${prefix}count`, label: "Pleats", unit: "", type: "number", value: d.count, tip: "How many pleats." },
        { key: `${prefix}depth`, label: "Depth", unit: "mm", type: "number", value: d.depth,
            tip: "The distance between a pleat's folds: a knife pleat takes in twice this, a box pleat four times." },
        { key: `${prefix}kind`, label: "Kind", unit: "", type: "select", value: d.kind, options: PLEAT_KINDS.map((k) => ({ value: k, label: k })),
            tip: "Knife: two folds, all facing one way. Box: four, two knife pleats facing each other." },
        { key: `${prefix}direction`, label: "Facing", unit: "", type: "select", value: d.direction, options: PLEAT_DIRECTIONS.map((k) => ({ value: k, label: k })),
            tip: "Which way a knife pleat's folded edge faces along the drag across (left: back toward the line). A box pleat is symmetric." },
        { key: `${prefix}top_tack`, label: "Top tack", unit: "", type: "select", value: d.top_tack ? "true" : "false", options: yesNo,
            tip: "Tack each pleat closed at the line's start edge (the waistband stitch)." },
        { key: `${prefix}area`, label: "Area", unit: "mm", type: "readonly", value: round(d.area).toFixed(1) },
    ];
}
const KEYS = new Set(["count", "depth", "kind", "direction", "top_tack"]);
// An error for a value, null when it is fine (`key` without its prefix).
export function pleatValidate(key, value) {
    if (key === "count" && !(Number.isInteger(value) && value >= 1 && value <= 200)) return "pleats: a whole number from 1 to 200";
    if (key === "depth" && !(num(value) && value > 0 && value <= 500)) return "a pleat's depth is above 0 and at most 500 mm";
    if (key === "kind" && !PLEAT_KINDS.includes(value)) return "a pleat is knife or box";
    if (key === "direction" && !PLEAT_DIRECTIONS.includes(value)) return "a pleat faces left or right";
    return null;
}
// The draft with `key` = `value` (validated).
export function draftWith(d, key, value) {
    if (!KEYS.has(key)) return d;
    return { ...d, [key]: key === "top_tack" ? truthy(value) : value };
}

// ---- pleat groups in the document ----
// The group (its index in the piece's `pleats`) internal line `index` is in, or -1.
export const groupOfLine = (node, index) => (node?.pleats ?? []).findIndex((g) => g.internal.includes(index));
// The internal lines drawn as one with line `index` (its group's, or itself).
export function linesWith(node, index) {
    const g = groupOfLine(node, index);
    return g < 0 ? [index] : [...node.pleats[g].internal];
}

// ---- the panel for a selected internal line: a dart's Close / Rotate, a pleat group's numbers ----
// Rows added to (a dart) or put in place of (a pleat line) simprops' internal-line rows.
export function s2Fields(node, index) {
    const l = node?.internal?.[index];
    if (!l) return null;
    const g = groupOfLine(node, index);
    if (g >= 0) {
        return [...pleatFields(draftOfSpec(node.pleats[g].spec), "pleat_"),
            { key: "pleat_remove", label: "Remove pleats", unit: "", type: "action", value: null }];
    }
    if (l.kind === "dart") {
        return [
            { key: "dart_cut", label: "Close (cut)", unit: "", type: "action", value: null, tip: "Cut the dart out: its legs become the outline, sewn together." },
            { key: "dart_fold", label: "Close (fold)", unit: "", type: "action", value: null, tip: "Fold the dart under: its legs tacked together, its centre a fold." },
            { key: "dart_rotate", label: "Rotate…", unit: "", type: "action", value: null, tip: "Move the dart: click the outline where it goes (its apex stays)." },
        ];
    }
    return null;
}
// Whether `key` is one of these rows' (the page sends it to the worker, not as ops).
export const isS2Key = (key) => key.startsWith("dart_") || key.startsWith("pleat_");

// What a row of s2Fields asks for: the worker message {kind, ...payload} for a dart or pleat
// edit, {rotate: {id, index}} to arm Rotate…, or {error} for a value refused; null when `key` is
// not one of them. A group's new numbers are a remove and an add, one batch (kernel.js pleatOps).
export function s2Request(selection, nodes, key, value) {
    if (selection?.kind !== "internal" || !isS2Key(key)) return null;
    const node = nodes.find((n) => n.id === selection.id), index = selection.index;
    if (!node?.internal?.[index]) return { error: "that line is gone" };
    if (key === "dart_cut" || key === "dart_fold") return { kind: "dart", id: node.id, index, action: key === "dart_cut" ? "cut" : "fold" };
    if (key === "dart_rotate") return { rotate: { id: node.id, index } };
    const group = groupOfLine(node, index);
    if (group < 0) return { error: "that line is not in a pleat group" };
    if (key === "pleat_remove") return { kind: "pleat", action: "remove", id: node.id, group };
    const k = key.slice("pleat_".length), err = pleatValidate(k, value);
    if (err) return { error: err };
    try {
        return { kind: "pleat", action: "edit", id: node.id, group, spec: pleatSpec(draftWith(draftOfSpec(node.pleats[group].spec), k, value)) };
    } catch (e) { return { error: e.message }; }
}

// ---- the tools ----
// Pleat: drag the placement line on a piece (its start's edge is the top), then drag across the
// area to pleat; the panel then sets the numbers, the piece previews the folds (the worker's
// pleatPreview), Enter adds them (one undo step), Escape drops them.
function pleatTool(ctx) {
    const drag = DRAG_PX * (ctx.pxToWorld > 0 ? ctx.pxToWorld : 1);
    let phase = "line", id = null, press = null, line = null, draft = null;
    const prev = ctx.pleatNext ?? {};    // the numbers last added (the page keeps them across tools)
    const reset = () => { phase = "line"; id = null; press = null; line = null; draft = null; };
    const preview = () => {
        try { return { pleatPreview: { id, spec: pleatSpec(draft) }, panel: true, status: "pleats: their numbers in the panel; Enter adds them, Escape drops them", error: false }; }
        catch (e) { return { panel: true, status: e.message }; }     // the last good frame stays
    };
    const t = {
        down(w, h) {
            if (phase === "draft") return {};
            if (phase === "line") {
                id = pieceOf(h) ?? (ctx.selection?.kind === "pattern" ? ctx.selection.id : null);
                if (!id) return { status: "pleats: drag the placement line on a piece" };
            }
            press = [...w];
            return {};
        },
        move(w) {
            if (phase === "draft") return {};          // the preview shows the folds now
            if (!press) return line ? { overlay: { lines: [line] } } : {};
            return { overlay: { lines: line ? [line, [press, [...w]]] : [[press, [...w]]] } };
        },
        up(w) {
            if (!press || phase === "draft") return {};
            const from = press;
            press = null;
            if (dist(from, w) < drag) return { overlay: { lines: line ? [line] : [] }, status: phase === "line" ? "pleats: drag the placement line, waist to hem" : "pleats: drag across the area to pleat" };
            if (phase === "line") { line = [from, [...w]]; phase = "across"; return { overlay: { lines: [line] }, status: "pleats: now drag across the area to pleat", error: false }; }
            draft = pleatDraft(line, [from, [...w]], prev);
            if (!draft) return { overlay: { lines: [line] }, status: "pleats: drag across the line, not along it" };
            phase = "draft";
            return { overlay: { lines: [] }, ...preview() };
        },
        key(k) {
            if (k === "Escape") { reset(); return { cancel: true, overlay: { lines: [] }, panel: true, done: true }; }
            if (k === "Enter" && phase === "draft") {
                let spec;
                try { spec = pleatSpec(draft); } catch (e) { return { status: e.message }; }
                const r = { cancel: true, pleat: { action: "add", id, spec }, panel: true, done: true, select: { kind: "pattern", id } };
                if (ctx.pleatNext) Object.assign(ctx.pleatNext, { depth: draft.depth, kind: draft.kind, direction: draft.direction, top_tack: draft.top_tack });
                reset();
                return r;
            }
            return {};
        },
        // the panel: the draft's numbers, and one of them changed
        draft() { return draft ? { id, ...draft } : null; },
        set(key, value) {
            if (!draft) return {};
            const err = pleatValidate(key, value);
            if (err) return { status: err, panel: true };
            draft = draftWith(draft, key, value);
            return preview();
        },
        lastPoint() { return press ? [...press] : null; },
    };
    return t;
}

// Rotate… (armed from a selected dart's panel, ctx.rotateDart = {id, index}): the pointer over the
// piece previews the dart moved to the outline point nearest it (the worker's dartPreview, from
// the piece as committed); a click there rotates it (one undo step); Escape drops it.
function dartRotateTool(ctx) {
    const target = ctx.rotateDart ?? null;
    const px = ctx.pxToWorld > 0 ? ctx.pxToWorld : 1, tol = 12 * px;
    let last = null;
    return {
        down() { return target ? {} : { status: "rotate: select a dart first", done: true }; },
        move(w) {
            if (!target || (last && dist(last, w) < 2 * px)) return {};
            last = [...w];
            return { dartPreview: { id: target.id, index: target.index, at: [...w], tol } };
        },
        up(w) {
            if (!target) return {};
            return { cancel: true, dart: { action: "rotate", id: target.id, index: target.index, at: [...w], tol }, done: true, select: { kind: "pattern", id: target.id } };
        },
        key(k) { return k === "Escape" ? { cancel: true, overlay: { lines: [] }, done: true, status: "rotate: cancelled", error: false } : {}; },
    };
}

export const S2_TOOLS = { pleat: pleatTool, "dart-rotate": dartRotateTool };
export const S2_SNAPPING = ["pleat"];
