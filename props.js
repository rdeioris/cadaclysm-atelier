// The property editor's model: a selection -> field descriptors, and a field edit -> ops.
// Pure (no DOM, no kernel), so Node tests it. atelier.js draws the fields and posts the ops.
import * as model from "./model.js";
import { PRESETS, presetParams, DISPLAY, presetNote, matchingPreset } from "./fabrics.js";
import { SLOTS, HOOD_SLOTS, slotFields, fabricColours, COLOUR } from "./arrange.js";
import { formOptions, bodyFields, poseFields, CUSTOM } from "./bodypanel.js";
import { groupOf, membersOf, groupRanges, ungroupOps } from "./seamgroup.js";

const find = (nodes, id) => nodes.find((n) => n.id === id);
// The notch kinds the kernel draws (spec §5), in its order, as the panel names them.
export const NOTCH_KINDS = [["slit", "Slit"], ["v", "V"], ["t", "T"], ["castle", "Castle"], ["u", "U"]];
// The Notch tool's next kind and depth after a selected notch's panel edit of `key` to `value`.
export function nextNotch(prev, key, value) {
    if (key === "kind") return { ...prev, kind: value };
    if (key === "depth") return { ...prev, depth: value };
    return prev;
}
export const DEFAULT_MESH = 20;   // the kernel's default particle_distance (cloth_default_options()[0])

// A number as a field shows it: seven significant digits (an integer as it is).
const showNumber = (v) => (typeof v === "number" && !Number.isInteger(v) ? String(Number(v.toPrecision(7))) : String(v));
// A grain component as shown: to 1e-4 (a mirrored piece's reflected grain is stored as
// 2.442346e-8, 1; showing it never changes the stored value). -0 shows as 0: String(-0) is "0".
const showGrain = (v) => showNumber(Math.round(v * 1e4) / 1e4);
// The text an input field holds for a field descriptor.
export function fieldText(f) {
    if (f.type === "numbers") return f.value.map(f.key === "grain" ? showGrain : showNumber).join(", ");
    if (f.type === "optnumber") return f.value == null ? "" : showNumber(f.value);
    if (f.type === "number") return showNumber(f.value);
    return String(f.value);
}

// -> [{key, label, unit, type: "text"|"number"|"optnumber"|"select"|"numbers"|"colour"|"readonly"|"action", value, options?, placeholder?}]
// An "optnumber" may be empty (value null): the default its placeholder shows.
export function fieldsFor(selection, nodes, drawings, avatar = null) {
    if (!selection) return [];
    if (selection.kind === "avatar") {
        if (!avatar) return [];
        const size = [0, 1, 2].map((i) => (avatar.bounds[i + 3] - avatar.bounds[i]).toFixed(0)).join(" × ");
        const forms = avatar.forms?.length
            ? [{ key: "form", label: "Form", unit: "", type: "select", value: avatar.draft || avatar.landmarks?.form ? CUSTOM : avatar.name, options: formOptions(avatar.forms) }]
            : [];
        return [
            { key: "name", label: "Name", unit: "", type: "readonly", value: avatar.name },
            ...forms,
            { key: "bounds", label: "Size", unit: "mm", type: "readonly", value: size },
            ...(avatar.draft ? [...bodyFields(avatar.draft, avatar), ...poseFields(avatar.draft)] : []),
            { key: "load", label: "Load STEP", unit: "", type: "action", value: null },
        ];
    }
    const n = find(nodes, selection.id);
    if (!n) return [];
    if (selection.kind === "notch") {
        const nt = n.notches?.[selection.index];
        if (!nt) return [];
        return [
            { key: "kind", label: "Kind", unit: "", type: "select", value: nt.kind ?? "slit", options: NOTCH_KINDS.map(([value, label]) => ({ value, label })) },
            { key: "depth", label: "Depth", unit: "mm", type: "number", value: nt.depth ?? 6 },
            { key: "at", label: "At", unit: "mm", type: "number", value: nt.at, tip: "Where the notch stands: its arc length along the outline from the outline's start." },
            { key: "remove", label: "Remove notch", unit: "", type: "action", value: null },
        ];
    }
    if (selection.kind === "pattern") {
        const fabrics = nodes.filter((x) => x.kind === "garment.fabric").map((f) => ({ value: f.id, label: f.label ?? f.id }));
        const placed = nodes.filter((x) => x.kind === "garment.pattern" && x.id !== n.id && x.frame && x.frame !== "xy");
        const slots = [{ value: "none", label: "none (floor)" },
            ...Object.entries(SLOTS).map(([value, s]) => ({ value, label: s.label })),
            ...(avatar?.landmarks?.head ? Object.entries(HOOD_SLOTS).map(([value, s]) => ({ value, label: s.label })) : []),
            ...placed.map((x) => ({ value: `on:${x.id}`, label: `On ${x.label ?? x.id}` }))];
        return [
            { key: "label", label: "Label", unit: "", type: "text", value: n.label ?? n.id },
            { key: "fabric", label: "Fabric", unit: "", type: "select", value: n.fabric ?? "", options: fabrics },
            { key: "layer", label: "Layer", unit: "", type: "number", value: n.layer ?? 0 },
            { key: "allowance", label: "Allowance", unit: "mm", type: "numbers", value: n.allowance ?? [0] },
            { key: "grain", label: "Grain", unit: "", type: "numbers", value: n.grain ?? [0, 1] },
            { key: "particle_distance", label: "Mesh", unit: "mm", type: "optnumber", value: n.particle_distance ?? null, placeholder: String(DEFAULT_MESH),
                tip: `This piece's cloth particle distance. Empty: the garment's ${DEFAULT_MESH} mm. Finer (10 mm) where a piece gathers or creases, as a cuff; it costs about four times the vertices on that piece. Pieces sewn together must be within 2x of each other: the drape refuses a seam whose pieces differ by more.` },
            { key: "slot", label: "Slot", unit: "", type: "select", value: n.meta?.atelier?.slot ?? "none", options: slots },
            // the transforms (spec §2): about the selection's bounds centre, through the kernel
            { key: "rotate", label: "Rotate", unit: "deg", type: "number", value: 0, tip: "Rotate the selected pieces by this many degrees (counter-clockwise) about their bounds' centre." },
            { key: "scale", label: "Scale", unit: "%", type: "number", value: 100, tip: "Scale the selected pieces uniformly about their bounds' centre. The seam allowances stay as they are." },
            { key: "flipH", label: "Flip H", unit: "", type: "action", value: null },
            { key: "flipV", label: "Flip V", unit: "", type: "action", value: null },
            { key: "duplicate", label: "Duplicate", unit: "", type: "action", value: null },
            { key: "remove", label: "Remove piece", unit: "", type: "action", value: null },
            // spec §6: a linked pair's or an unfolded piece's actions
            ...(n.meta?.atelier?.unfold ? [{ key: "foldBack", label: "Fold back", unit: "", type: "action", value: null, tip: "Back to the half this piece was unfolded from: seams on the mirrored side are dropped." }] : []),
            ...(n.meta?.atelier?.link || n.meta?.atelier?.unfold ? [{ key: "unlink", label: "Unlink", unit: "", type: "action", value: null,
                tip: n.meta.atelier.link ? `Linked to ${find(nodes, n.meta.atelier.link.partner)?.label ?? n.meta.atelier.link.partner}: unlinked, each piece is edited on its own.` : "The whole becomes an ordinary piece: its halves are edited on their own." }] : []),
        ];
    }
    if (selection.kind === "seam" && groupOf(n)) {
        // an M:N group (A2 spec §1): its ranges and lengths, Ungroup, Remove
        const g = groupOf(n), label = (id) => find(nodes, id)?.label ?? id;
        const ranges = groupRanges(g, (id) => drawings?.get(id)?.sides);
        const total = (side) => ranges.filter((r) => r.side === side).reduce((t, r) => t + r.length, 0);
        const mm = (v) => (Number.isFinite(v) ? `${v.toFixed(1)} mm` : "gone");
        return [
            { key: "members", label: "Seams", unit: "", type: "readonly", value: `${membersOf(nodes, n.id).length} (M:N ${g.a.length}:${g.b.length})` },
            ...ranges.map((r) => ({ key: `range-${r.side}${r.k + 1}`, label: `${r.side}${r.k + 1}`, unit: "", type: "readonly", value: `${label(r.pattern)}, ${mm(r.length)}` })),
            { key: "lengthA", label: "A length", unit: "", type: "readonly", value: mm(total("A")) },
            { key: "lengthB", label: "B length", unit: "", type: "readonly", value: mm(total("B")) },
            { key: "ungroup", label: "Ungroup", unit: "", type: "action", value: null, tip: "The group's seams stay as plain 1:1 seams, no longer re-distributed after an edit." },
            { key: "remove", label: "Remove group", unit: "", type: "action", value: null },
        ];
    }
    if (selection.kind === "seam") {
        const yesNo = [{ value: "false", label: "no" }, { value: "true", label: "yes" }];
        return [
            ...["a_from", "a_to", "b_from", "b_to"].map((key) => ({ key, label: key.replace("_", " "), unit: "mm", type: "number", value: n[key] })),
            { key: "reversed", label: "Reversed", unit: "", type: "select", value: n.reversed ? "true" : "false", options: yesNo },
            { key: "remove", label: "Remove seam", unit: "", type: "action", value: null },
        ];
    }
    if (selection.kind === "fabric") {
        const matched = matchingPreset(n);
        return [
            { key: "label", label: "Label", unit: "", type: "text", value: n.label ?? n.id },
            { key: "colour", label: "Colour", unit: "", type: "colour", value: fabricColours(nodes).get(n.id) ?? "#cccccc", tip: "How the fabric is drawn (#rrggbb): the 2D fills, the 3D pieces and the cloth. Looks only: the physics is the numbers below." },
            // at the top, with the label and colour: the panel's 20 numbers scroll
            { key: "duplicate", label: "Duplicate fabric", unit: "", type: "action", value: null },
            ...model.FABRIC_FIELDS.map((key) => ({ key, label: DISPLAY[key].label, unit: DISPLAY[key].unit, type: "number", value: DISPLAY[key].toShown(n[key]),
                ...(DISPLAY[key].tip ? { tip: DISPLAY[key].tip } : {}) })),
            { key: "preset", label: "Apply preset", unit: "", type: "select", value: "", options: PRESETS.map((p) => ({ value: p.slug, label: p.label })) },
            ...(matched ? [{ key: "source", label: matched.estimated ? "Source (ESTIMATE)" : "Source", unit: "", type: "readonly", value: presetNote(matched) }] : []),
        ];
    }
    return [];
}

// An error message when `value` cannot go into field `key` (what the kernel would reject), else null.
export function validate(selection, nodes, key, value) {
    const num = (v) => typeof v === "number" && Number.isFinite(v);
    if (selection.kind === "pattern") {
        if (key === "label") {
            if (typeof value !== "string" || !value.trim()) return "a label cannot be empty";
            if (nodes.some((n) => n.kind === "garment.pattern" && n.id !== selection.id && n.label === value)) return `another pattern is already called "${value}"`;
        } else if (key === "layer") {
            if (!Number.isInteger(value)) return "layer must be a whole number";
        } else if (key === "allowance") {
            if (!Array.isArray(value) || !value.length || !value.every((v) => num(v) && v >= 0)) return "allowance must be numbers of 0 mm or more";
        } else if (key === "grain") {
            if (!Array.isArray(value) || value.length !== 2 || !value.every(num) || (value[0] === 0 && value[1] === 0)) return "grain must be two numbers, not both 0";
        } else if (key === "rotate") {
            if (!num(value)) return "rotate takes a number of degrees";
        } else if (key === "scale") {
            if (!(num(value) && value > 0)) return "scale is a percentage above 0";
        } else if (key === "particle_distance") {
            if (value !== null && !(num(value) && value >= 10 && value <= 40)) return `mesh must be from 10 to 40 mm, or empty for the garment's ${DEFAULT_MESH}`;
        }
    } else if (selection.kind === "fabric") {
        if (key === "label") {
            if (typeof value !== "string" || !value.trim()) return "a label cannot be empty";
            if (nodes.some((n) => n.kind === "garment.fabric" && n.id !== selection.id && n.label === value)) return `another fabric is already called "${value}"`;
        } else if (key === "colour") {
            if (typeof value !== "string" || !COLOUR.test(value.trim())) return "a colour is #rrggbb (six hex digits)";
        } else if (key === "duplicate") return null;
        else if (key !== "preset" && !num(value)) return "not a number";
        else if (DISPLAY[key]?.range) {
            const [lo, hi] = DISPLAY[key].range;
            if (value < lo || value > hi) return `${DISPLAY[key].label} must be from ${lo} to ${hi}`;
        }
    } else if (selection.kind === "notch") {
        if (key === "kind" && !NOTCH_KINDS.some(([k]) => k === value)) return `a notch is one of ${NOTCH_KINDS.map(([, l]) => l).join(", ")}`;
        if (key === "depth" && !(num(value) && value > 0)) return "a notch's depth is above 0 mm";
        if (key === "at" && !(num(value) && value >= 0)) return "a notch stands at 0 mm or more along the outline";
    } else if (selection.kind === "seam") {
        if (["a_from", "a_to", "b_from", "b_to"].includes(key) && !(num(value) && value >= 0)) return "a seam position is a number of 0 mm or more";
    }
    return null;
}

// A seam's anchor after a typed end: that end's [side, tFrom, tTo(, sideTo)] from the typed arc
// lengths and its piece's sides (the form sewing.js writes), so an outline edit re-anchors it to
// the typed place. Without the sides the stale end is dropped. A "from" on a corner starts the
// next side; a "to" on a corner ends the side before it.
function typedAnchor(seam, end, after, drawings) {
    const anchor = { ...seam.meta.atelier };
    const sides = drawings?.get(seam[end])?.sides;
    if (!sides || sides.length < 2) { delete anchor[end]; return anchor; }
    const last = sides.length - 2;
    const at = (s, isTo) => {
        let i = sides.findIndex((v, k) => k <= last && (isTo ? s > v && s <= sides[k + 1] : s >= v && s < sides[k + 1]));
        if (i < 0) i = isTo ? 0 : last;
        const len = sides[i + 1] - sides[i];
        return [i, len > 0 ? Math.min(1, Math.max(0, (s - sides[i]) / len)) : 0];
    };
    const [sf, tf] = at(after[`${end}_from`], false), [st, tt] = at(after[`${end}_to`], true);
    anchor[end] = sf === st && tf <= tt ? [sf, tf, tt] : [sf, tf, tt, st];
    return anchor;
}

// The pattern fields that go through the kernel as a transform of the selected pieces (a
// matrix from transformMatrix), or as a duplicate: not plain ops.
export const TRANSFORM_KEYS = new Set(["rotate", "scale", "flipH", "flipV"]);
// The selected pieces' ids: a multi-selection's, else the one.
export const selectedIds = (selection) => (selection?.kind === "pattern" ? selection.ids ?? [selection.id] : []);
// The union of pieces `ids`' bounds [x0, y0, x1, y1] (each drawing's kernel bounds); null for none.
export function unionBounds(drawings, ids) {
    const bs = ids.map((id) => drawings.get(id)?.bounds).filter(Boolean);
    if (!bs.length) return null;
    return [Math.min(...bs.map((b) => b[0])), Math.min(...bs.map((b) => b[1])), Math.max(...bs.map((b) => b[2])), Math.max(...bs.map((b) => b[3]))];
}
// The kernel's row-major 2x3 (x' = m0 x + m1 y + m2, y' = m3 x + m4 y + m5) for a transform field
// about the centre of `bounds`: rotate by `value` degrees counter-clockwise, scale by `value` %,
// or flip across the centre's vertical (flipH) or horizontal (flipV) line. null for no change.
export function transformMatrix(key, value, bounds) {
    const cx = (bounds[0] + bounds[2]) / 2, cy = (bounds[1] + bounds[3]) / 2;
    if (key === "rotate") {
        if (!value || value % 360 === 0) return null;
        const a = (value * Math.PI) / 180;
        // exact quarter turns: no 6e-17 in the matrix
        const snap = (v) => (Math.abs(v) < 1e-15 ? 0 : Math.abs(Math.abs(v) - 1) < 1e-15 ? Math.sign(v) : v);
        const c = snap(Math.cos(a)), s = snap(Math.sin(a));
        return [c, -s, cx - c * cx + s * cy, s, c, cy - s * cx - c * cy];
    }
    if (key === "scale") {
        if (value === 100) return null;
        const k = value / 100;
        return [k, 0, cx * (1 - k), 0, k, cy * (1 - k)];
    }
    if (key === "flipH") return [-1, 0, 2 * cx, 0, 1, 0];
    if (key === "flipV") return [1, 0, 0, 0, -1, 2 * cy];
    throw new Error(`no transform ${key}`);
}

// ctx: {avatarBounds, landmarks, drawings} for the slot field and a typed seam end.
export function opsFor(selection, nodes, key, value, ctx = {}) {
    const id = selection.id;
    if (selection.kind === "pattern") {
        if (key === "slot") {
            const n = find(nodes, id);
            const d = ctx.drawings?.get(id);
            if (value !== "none" && !ctx.avatarBounds) throw new Error("no avatar to place the piece around");
            if (value !== "none" && !d) throw new Error("the pattern has no outline to place");
            const host = value.startsWith("on:") ? find(nodes, value.slice(3)) : null;
            return model.setPattern(nodes, id, slotFields(n, value, ctx.avatarBounds, d?.bounds, { landmarks: ctx.landmarks ?? null, host }));
        }
        if (key === "remove") return model.removePattern(nodes, id);
        if (key === "unlink") return model.unlinkOps(nodes, id);
        if (key === "foldBack") throw new Error("fold back goes through the kernel (atelier.js commitField)");
        if (TRANSFORM_KEYS.has(key) || key === "duplicate") throw new Error(`${key} goes through the kernel (atelier.js transformSelected / duplicate)`);
        return model.setPattern(nodes, id, { [key]: value });
    }
    if (selection.kind === "notch") {
        const list = find(nodes, id)?.notches ?? [], i = selection.index;
        if (!list[i]) throw new Error("the notch is gone");
        if (key === "remove") return model.setPattern(nodes, id, { notches: list.filter((_, j) => j !== i) });
        if (key === "at") {
            const P = ctx.drawings?.get(id)?.sides?.at(-1);
            if (P > 0 && value >= P) throw new Error(`the outline is ${P.toFixed(1)} mm round: at must be less`);
        }
        return model.setPattern(nodes, id, { notches: list.map((nt, j) => (j === i ? { ...nt, [key]: value } : nt)) });
    }
    if (selection.kind === "seam") {
        const members = membersOf(nodes, id);
        if (key === "remove") return members ? model.removeSeams(nodes, members) : model.removeSeam(nodes, id);
        if (key === "ungroup") return members ? ungroupOps(nodes, members) : [];
        if (members) throw new Error("a seam of an M:N group is edited through its group: Ungroup it first");
        const v = key === "reversed" ? value === true || value === "true" : value;
        const fields = { [key]: v };
        const n = find(nodes, id);
        const end = /^([ab])_(from|to)$/.exec(key)?.[1];
        if (end && n?.meta?.atelier?.[end]) fields.meta = { ...n.meta, atelier: typedAnchor(n, end, { ...n, ...fields }, ctx.drawings) };
        return [{ op: "set", id, fields }];
    }
    if (selection.kind === "fabric") {
        if (key === "label") return [{ op: "set", id, fields: { label: value } }];
        if (key === "preset") return model.setFabric(nodes, id, presetParams(value));
        if (key === "duplicate") return model.duplicateFabric(nodes, id).ops;
        if (key === "colour") {
            const n = find(nodes, id);
            return [{ op: "set", id, fields: { meta: { ...(n?.meta ?? {}), atelier: { ...(n?.meta?.atelier ?? {}), colour: value.trim().toLowerCase() } } } }];
        }
        return [{ op: "set", id, fields: { [key]: DISPLAY[key].fromShown(value) } }];
    }
    throw new Error(`nothing to edit for ${selection.kind}`);
}
