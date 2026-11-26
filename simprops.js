// The simulation controls in the property panel (spec S1 §6): a piece's Freeze, Strengthen,
// Pressure and saved pins; a fabric's shrinkage; a seam's strength and elastic; an internal
// line's kind, fold and elastic; a tack's ends. Pure, as props.js (which calls in here): fields,
// validation and ops. Every value is stored as the kernel's document takes it (kinds/garment.rs)
// and left out (a null removes it) when it is the default, so a garment that uses none of these
// saves exactly as before.
import { setPattern } from "./model.js";
import { removeTack } from "./tacks.js";
import { s2Fields, groupOfLine } from "./pleats.js";

// An elastic's stiffness is a force per unit strain: the kernel's g·mm/s², the panel's newtons.
export const N = 1e6;                    // g·mm/s² per N
export const ELASTIC_N = 2;              // the default, an estimate (spec: "(estimated)")
// The selection kinds this module owns outright (props.js hands them over whole).
export const SIM_KINDS = new Set(["internal", "tack"]);

const find = (nodes, id) => nodes.find((n) => n.id === id);
const num = (v) => typeof v === "number" && Number.isFinite(v);
const yesNo = [{ value: "false", label: "no" }, { value: "true", label: "yes" }];
const truthy = (v) => v === true || v === "true";
// A percentage as shown: 1e-9 noise off (0.95 * 100 is 94.99999999999999).
const pct = (ratio) => Math.round(ratio * 1e9) / 1e7;
const elasticFields = (e) => [
    { key: "elastic_ratio", label: "Elastic", unit: "%", type: "optnumber", value: e ? pct(e.ratio) : null, placeholder: "none",
        tip: "The elastic's rest length as a share of the line's (70: it gathers the line to 70 %). Empty: no elastic." },
    { key: "elastic_stiffness", label: "Elastic stiffness", unit: "N", type: "optnumber", value: e ? e.stiffness / N : null, placeholder: `${ELASTIC_N} (estimated)`,
        tip: `The elastic's pull per unit strain, in newtons. Empty: ${ELASTIC_N} N, an estimate for a 1 cm knitted elastic.` },
];

// The extra rows for a piece, a seam or a fabric (props.js puts them in its own), or every row
// for an internal line or a tack. `n` is the selected node (the piece, for an internal line).
export function simFields(selection, n, nodes) {
    if (selection.kind === "pattern") {
        const pins = n.pins?.length ?? 0;
        return [
            { key: "frozen", label: "Freeze", unit: "", type: "select", value: n.frozen ? "true" : "false", options: yesNo,
                tip: "A frozen piece holds still in the simulation, and the others still collide with it (a table, a mannequin's shell). Applied at once to a live cloth." },
            { key: "strengthen", label: "Strengthen", unit: "×", type: "number", value: n.strengthen ?? 1,
                tip: "Multiplies the piece's stretch and bending stiffness (1: the fabric's own). A live cloth re-meshes the piece." },
            { key: "pressure", label: "Pressure", unit: "Pa", type: "number", value: n.pressure ?? 0,
                tip: "Pushes the piece along its front (outer) side, as air in a closed volume; negative pulls it in. 0: none." },
            ...(pins ? [{ key: "pins", label: "Saved pins", unit: "", type: "readonly", value: String(pins) },
                { key: "clear_pins", label: "Clear pins", unit: "", type: "action", value: null }] : []),
        ];
    }
    if (selection.kind === "seam") {
        return [
            { key: "strengthen", label: "Strengthen", unit: "×", type: "number", value: n.strengthen ?? 1,
                tip: "Multiplies the bending across the seam (1: as sewn). A live cloth re-meshes the two pieces." },
            ...elasticFields(n.elastic && Object.keys(n.elastic).length ? n.elastic : null),
        ];
    }
    if (selection.kind === "fabric") {
        const [warp, weft] = n.shrinkage?.length === 2 ? n.shrinkage : [1, 1];
        const tip = "CLO's shrinkage: the rest length as a share of the cut (100: none, 95: the fabric shrinks 5 %), 50 to 200.";
        return [
            { key: "shrink_warp", label: "Shrinkage warp", unit: "%", type: "number", value: pct(warp), tip },
            { key: "shrink_weft", label: "Shrinkage weft", unit: "%", type: "number", value: pct(weft), tip },
        ];
    }
    if (selection.kind === "internal") {
        const l = n.internal?.[selection.index];
        if (!l) return [];
        // a pleat group's line shows the group's numbers (S2): its lines are edited as one
        const s2 = s2Fields(n, selection.index);
        if (s2 && groupOfLine(n, selection.index) >= 0) return s2;
        const kinds = [{ value: "line", label: "line" }, { value: "fold", label: "fold" }, { value: "dart", label: "dart" }];
        return [
            { key: "line_kind", label: "Kind", unit: "", type: "select", value: l.kind, options: kinds,
                tip: "A fold line folds the cloth along it by its angle; a plain line and a dart are drawn only." },
            ...(l.kind === "fold" ? [
                { key: "angle", label: "Fold angle", unit: "°", type: "number", value: l.angle ?? 180,
                    tip: "CLO's fold angle: 180 lies flat, 0 folds the piece shut toward its front, 360 toward its back." },
                { key: "fold_strength", label: "Fold strength", unit: "×", type: "number", value: l.strength ?? 1,
                    tip: "Multiplies the bending that holds the fold (0: a free hinge)." },
            ] : []),
            ...elasticFields(l.elastic ?? null),
            // a dart's Close (cut), Close (fold) and Rotate… (S2)
            ...(s2 ?? []),
            { key: "remove", label: "Remove line", unit: "", type: "action", value: null },
        ];
    }
    if (selection.kind === "tack") {
        const label = (id) => find(nodes, id)?.label ?? id;
        return [
            { key: "pieces", label: "Joins", unit: "", type: "readonly", value: `${label(n.a)} – ${label(n.b)}` },
            { key: "a_at", label: `At ${label(n.a)}`, unit: "mm", type: "numbers", value: n.a_at },
            { key: "b_at", label: `At ${label(n.b)}`, unit: "mm", type: "numbers", value: n.b_at },
            { key: "remove", label: "Remove tack", unit: "", type: "action", value: null },
        ];
    }
    return [];
}

const KEYS = {
    pattern: new Set(["frozen", "strengthen", "pressure", "clear_pins"]),
    seam: new Set(["strengthen", "elastic_ratio", "elastic_stiffness"]),
    fabric: new Set(["shrink_warp", "shrink_weft"]),
};
// Whether field `key` of `selection` is one of these.
export const isSimKey = (selection, key) => SIM_KINDS.has(selection.kind) || !!KEYS[selection.kind]?.has(key);

function elasticError(key, value, current) {
    if (key === "elastic_ratio" && value !== null && !(num(value) && value > 0 && value <= 100)) return "an elastic's length is above 0 and at most 100 % of the line's (empty: no elastic)";
    if (key === "elastic_stiffness") {
        if (value !== null && !(num(value) && value > 0)) return "an elastic's stiffness is above 0 N (empty: the estimate)";
        if (value !== null && !current) return "set the elastic's length (%) first";
    }
    return null;
}

// An error for a value these fields refuse, null when it is fine; undefined when `key` is not one
// of them (props.js goes on with its own).
export function simValidate(selection, nodes, key, value) {
    if (!isSimKey(selection, key)) return undefined;
    const n = find(nodes, selection.id);
    if (key === "strengthen" && !(num(value) && value >= 1 && value <= 1000)) return "strengthen is from 1 to 1000";
    if (key === "pressure" && !(num(value) && Math.abs(value) <= 1e5)) return "pressure is a number of pascals, at most 100000 either way";
    if ((key === "shrink_warp" || key === "shrink_weft") && !(num(value) && value >= 50 && value <= 200)) return "shrinkage is from 50 to 200 % (100: none)";
    if (selection.kind === "seam") return elasticError(key, value, n?.elastic && Object.keys(n.elastic).length);
    if (selection.kind === "internal") {
        const l = n?.internal?.[selection.index];
        if (!l) return "that line is gone";
        if (key === "line_kind" && !["line", "fold", "dart"].includes(value)) return "a line is a line, a fold or a dart";
        if (key === "angle" && !(num(value) && value >= 0 && value <= 360)) return "a fold angle is from 0 to 360 degrees (180: flat)";
        if (key === "fold_strength" && !(num(value) && value >= 0 && value <= 1000)) return "fold strength is from 0 to 1000";
        return elasticError(key, value, l.elastic);
    }
    if (selection.kind === "tack" && (key === "a_at" || key === "b_at") && !(Array.isArray(value) && value.length === 2 && value.every(num))) return "a tack's end is two numbers: x, y (mm)";
    return null;
}

// The elastic after field `key` = `value` (null: none).
function elasticAfter(old, key, value) {
    if (key === "elastic_ratio") return value === null ? null : { ratio: value / 100, stiffness: old?.stiffness ?? ELASTIC_N * N };
    return old ? { ratio: old.ratio, stiffness: (value ?? ELASTIC_N) * N } : null;
}
// `v` unless it is the default `d` (then null: the param removed).
const unlessDefault = (v, d) => (v === d ? null : v);

// The ops for one of these fields; null when `key` is not one of them.
export function simOps(selection, nodes, key, value) {
    if (!isSimKey(selection, key)) return null;
    const id = selection.id, n = find(nodes, id);
    if (!n) throw new Error(`no ${selection.kind} ${id}`);
    const set = (fields) => [{ op: "set", id, fields }];
    if (selection.kind === "pattern") {
        if (key === "frozen") return set({ frozen: truthy(value) ? true : null });
        if (key === "clear_pins") return set({ pins: null });
        return set({ [key]: unlessDefault(value, key === "strengthen" ? 1 : 0) });
    }
    if (selection.kind === "seam") {
        if (key === "strengthen") return set({ strengthen: unlessDefault(value, 1) });
        const old = n.elastic && Object.keys(n.elastic).length ? n.elastic : null;
        return set({ elastic: elasticAfter(old, key, value) });
    }
    if (selection.kind === "fabric") {
        const [warp, weft] = n.shrinkage?.length === 2 ? n.shrinkage : [1, 1];
        const next = key === "shrink_warp" ? [value / 100, weft] : [warp, value / 100];
        return set({ shrinkage: next[0] === 1 && next[1] === 1 ? null : next });
    }
    if (selection.kind === "internal") {
        const list = (n.internal ?? []).map((l) => ({ ...l }));
        const l = list[selection.index];
        if (!l) throw new Error("that line is gone");
        if (key === "remove") return setPattern(nodes, id, { internal: list.filter((_, i) => i !== selection.index) });
        if (key === "line_kind") {
            l.kind = value;
            // a fold's angle and strength are for fold lines only (the kernel refuses them on another)
            if (value !== "fold") { delete l.angle; delete l.strength; }
        } else if (key === "angle") { if (value === 180) delete l.angle; else l.angle = value; }
        else if (key === "fold_strength") { if (value === 1) delete l.strength; else l.strength = value; }
        else {
            const e = elasticAfter(l.elastic ?? null, key, value);
            if (e) l.elastic = e; else delete l.elastic;
        }
        return setPattern(nodes, id, { internal: list });
    }
    if (selection.kind === "tack") {
        if (key === "remove") return removeTack(nodes, id);
        if (key === "a_at" || key === "b_at") return set({ [key]: value.map(Number) });
        return [];
    }
    return null;
}

// A pin made (`on`) or let go on the cloth, as its piece's saved `pins` ([[u, v], ...], pattern
// space): a new pin is added; a released one removes the saved pin nearest it (within `tol` mm,
// a re-meshed vertex lies within a fraction of the particle distance of the pin it was made for).
export function pinOps(nodes, pattern, at, on, tol = 5) {
    const n = find(nodes, pattern);
    if (!n) return [];
    const pins = (n.pins ?? []).map((p) => [p[0], p[1]]);
    const round = (v) => Math.round(v * 1e6) / 1e6;
    if (on) return [{ op: "set", id: pattern, fields: { pins: [...pins, [round(at[0]), round(at[1])]] } }];
    let best = -1, bestD = tol;
    pins.forEach((p, i) => { const d = Math.hypot(p[0] - at[0], p[1] - at[1]); if (d <= bestD) { bestD = d; best = i; } });
    if (best < 0) return [];
    const rest = pins.filter((_, i) => i !== best);
    return [{ op: "set", id: pattern, fields: { pins: rest.length ? rest : null } }];
}
