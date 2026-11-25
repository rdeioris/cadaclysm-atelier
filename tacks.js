// Tacks as document nodes: a `garment.tack` joins point `a_at` of pattern `a` to point `b_at`
// of pattern `b` (pattern space, the 2D window's coordinates), listed in the garment's `tacks`
// input list as seams are in `seams`. Pure: no kernel, no imports, so model.js and simtools.js
// both build on it.

const tacksOf = (nodes) => nodes.find((n) => n.id === "garment")?.tacks ?? [];
// The garment's `tacks` list as a field: an empty list is no param at all (a null removes it),
// so a garment without tacks saves as one that never had any.
const listField = (ids) => ({ tacks: ids.length ? ids : null });

// The first free `t<n>` id.
function nextTackId(nodes) {
    let max = 0;
    for (const n of nodes) { const m = /^t(\d+)$/.exec(n.id); if (m) max = Math.max(max, Number(m[1])); }
    return `t${max + 1}`;
}

const pt = (p) => [Number(p[0]), Number(p[1])];

// A tack joining (a, aAt) to (b, bAt): the node and the garment's list. -> {id, ops}
export function addTack(nodes, { a, a_at, b, b_at, id = nextTackId(nodes) }) {
    const node = { id, kind: "garment.tack", a, b, a_at: pt(a_at), b_at: pt(b_at) };
    return { id, ops: [{ op: "add", node }, { op: "set", id: "garment", fields: listField([...tacksOf(nodes), id]) }] };
}

// Tack `id` out of the garment's list, then the node.
export const removeTack = (nodes, id) => removeTacks(nodes, [id]);
export function removeTacks(nodes, ids) {
    if (!ids.length) return [];
    return [{ op: "set", id: "garment", fields: listField(tacksOf(nodes).filter((t) => !ids.includes(t))) }, ...ids.map((t) => ({ op: "remove", id: t }))];
}

// The tacks with an end on one of `patterns` (ids): what goes when those pieces go.
export const tacksOn = (nodes, patterns) =>
    nodes.filter((n) => n.kind === "garment.tack" && (patterns.includes(n.a) || patterns.includes(n.b))).map((n) => n.id);
