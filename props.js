// The property editor's model: a selection -> field descriptors, and a field edit -> ops.
// Pure (no DOM, no kernel), so Node tests it. atelier.js draws the fields and posts the ops.
import * as model from "./model.js";
import { PRESETS, presetParams, DISPLAY, presetNote, matchingPreset } from "./fabrics.js";
import { SLOTS, HOOD_SLOTS, slotFields } from "./arrange.js";

const find = (nodes, id) => nodes.find((n) => n.id === id);

// -> [{key, label, unit, type: "text"|"number"|"select"|"numbers"|"readonly"|"action", value, options?}]
export function fieldsFor(selection, nodes, drawings, avatar = null) {
    if (!selection) return [];
    if (selection.kind === "avatar") {
        if (!avatar) return [];
        const size = [0, 1, 2].map((i) => (avatar.bounds[i + 3] - avatar.bounds[i]).toFixed(0)).join(" × ");
        const forms = avatar.forms?.length
            ? [{ key: "form", label: "Form", unit: "", type: "select", value: avatar.name, options: avatar.forms.map((f) => ({ value: f.name, label: f.label ?? f.name })) }]
            : [];
        return [
            { key: "name", label: "Name", unit: "", type: "readonly", value: avatar.name },
            ...forms,
            { key: "bounds", label: "Size", unit: "mm", type: "readonly", value: size },
            { key: "load", label: "Load STEP", unit: "", type: "action", value: null },
        ];
    }
    const n = find(nodes, selection.id);
    if (!n) return [];
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
            { key: "slot", label: "Slot", unit: "", type: "select", value: n.meta?.atelier?.slot ?? "none", options: slots },
            { key: "remove", label: "Remove piece", unit: "", type: "action", value: null },
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
            ...model.FABRIC_FIELDS.map((key) => ({ key, label: DISPLAY[key].label, unit: DISPLAY[key].unit, type: "number", value: DISPLAY[key].toShown(n[key]) })),
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
        }
    } else if (selection.kind === "fabric") {
        if (key === "label") {
            if (typeof value !== "string" || !value.trim()) return "a label cannot be empty";
            if (nodes.some((n) => n.kind === "garment.fabric" && n.id !== selection.id && n.label === value)) return `another fabric is already called "${value}"`;
        } else if (key !== "preset" && !num(value)) return "not a number";
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
        return model.setPattern(nodes, id, { [key]: value });
    }
    if (selection.kind === "seam") {
        if (key === "remove") return model.removeSeam(nodes, id);
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
        return [{ op: "set", id, fields: { [key]: DISPLAY[key].fromShown(value) } }];
    }
    throw new Error(`nothing to edit for ${selection.kind}`);
}
