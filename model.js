// The garment as a blacksmith document: node builders and the op lists that edit it.
// Pure: no kernel calls. Every function takes the current node list (document_nodes) and
// returns ops for one batch, so one user action is one undo step.

export const FABRIC_FIELDS = [
    "stretch_warp", "stretch_weft", "shear_left", "shear_right",
    "bending_warp", "bending_weft", "bending_bias_left", "bending_bias_right",
    "buckling_ratio_warp", "buckling_ratio_weft", "buckling_ratio_bias_left", "buckling_ratio_bias_right",
    "buckling_stiffness_warp", "buckling_stiffness_weft", "buckling_stiffness_bias_left", "buckling_stiffness_bias_right",
    "density", "thickness", "friction", "internal_damping",
];

export const byId = (nodes) => new Map(nodes.map((n) => [n.id, n]));

export function nextId(nodes, prefix) {
    const re = new RegExp(`^${prefix}(\\d+)$`);
    let max = 0;
    for (const n of nodes) { const m = re.exec(n.id); if (m) max = Math.max(max, Number(m[1])); }
    return `${prefix}${max + 1}`;
}

// A garment's pattern labels must be distinct (the kernel refuses a repeat).
const labels = (nodes) => new Set(nodes.filter((n) => n.kind === "garment.pattern").map((n) => n.label));
// `label`, or `label 2`, `label 3`... when it is taken.
export function freeLabel(nodes, label) {
    const taken = labels(nodes);
    let l = label;
    for (let k = 2; taken.has(l); k++) l = `${label} ${k}`;
    return l;
}
// A drawn piece's label: `Piece n`, n from the piece count + 1 up to the first free one.
export function pieceLabel(nodes) {
    const taken = labels(nodes);
    let n = nodes.filter((x) => x.kind === "garment.pattern").length + 1;
    while (taken.has(`Piece ${n}`)) n++;
    return `Piece ${n}`;
}

const pt = (p) => [Number(p[0]), Number(p[1])];

export function polyPath(points, curves = []) {
    const segments = points.map((_, i) => {
        const to = pt(points[(i + 1) % points.length]);
        const c = curves[i];
        return c ? { type: "bezier", c1: pt(c.c1), c2: pt(c.c2), to } : { type: "line", to };
    });
    return { start: pt(points[0]), segments };
}

export const rectPath = (x, y, w, h) => polyPath([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]);

export const pathPoints = (path) => [path.start, ...path.segments.slice(0, -1).map((s) => s.to)].map(pt);

function garmentOps(nodes, patterns, seams) {
    const g = byId(nodes).get("garment");
    if (!g) return [{ op: "add", node: { id: "garment", kind: "garment.garment", patterns, seams } }];
    return [{ op: "set", id: "garment", fields: { patterns, seams } }];
}
const listOf = (nodes, key) => byId(nodes).get("garment")?.[key] ?? [];

export function newDocumentOps(fabric) {
    return [...addFabric([], fabric.slug, fabric.label, fabric.params).ops, ...garmentOps([], [], [])];
}

export function addFabric(nodes, slug, label, params) {
    const id = `f_${slug}`;
    if (byId(nodes).has(id)) return { id, ops: [] };
    const node = { id, kind: "garment.fabric", label };
    for (const f of FABRIC_FIELDS) node[f] = params[f];
    return { id, ops: [{ op: "add", node }] };
}

export const setFabric = (nodes, id, params) =>
    [{ op: "set", id, fields: Object.fromEntries(FABRIC_FIELDS.filter((f) => f in params).map((f) => [f, params[f]])) }];

export function addPattern(nodes, { label, path, fabric, layer = 0, allowance = 10, grain = [0, 1] }) {
    const id = nextId(nodes, "p");
    const outline = `${id}_outline`;
    const ops = [
        { op: "add", node: { id: outline, kind: "profile.path", path } },
        { op: "add", node: { id, kind: "garment.pattern", label, outline, fabric, layer, allowance: [allowance].flat(), grain } },
        ...garmentOps(nodes, [...listOf(nodes, "patterns"), id], listOf(nodes, "seams")),
    ];
    return { id, ops };
}

export const removePattern = (nodes, id) => removePatterns(nodes, [id]);
// Several pieces, their seams and outlines in one batch (one undo step): a seam between two of
// them is removed once.
export function removePatterns(nodes, ids) {
    const seams = nodes.filter((n) => n.kind === "garment.seam" && (ids.includes(n.a) || ids.includes(n.b))).map((n) => n.id);
    return [
        ...garmentOps(nodes, listOf(nodes, "patterns").filter((p) => !ids.includes(p)), listOf(nodes, "seams").filter((s) => !seams.includes(s))),
        ...seams.map((s) => ({ op: "remove", id: s })),
        ...ids.flatMap((id) => [{ op: "remove", id }, { op: "remove", id: `${id}_outline` }]),
    ];
}

export const setOutline = (nodes, id, path) => [{ op: "set", id: `${id}_outline`, fields: { path } }];
export const setPattern = (nodes, id, fields) => [{ op: "set", id, fields }];

export function addSeam(nodes, { a, b, a_from, a_to, b_from, b_to, reversed, anchor }) {
    const id = nextId(nodes, "s");
    const node = { id, kind: "garment.seam", a, b, a_from, a_to, b_from, b_to, reversed: !!reversed };
    if (anchor) node.meta = { atelier: anchor };
    return { id, ops: [{ op: "add", node }, ...garmentOps(nodes, listOf(nodes, "patterns"), [...listOf(nodes, "seams"), id])] };
}

export const removeSeam = (nodes, id) =>
    [...garmentOps(nodes, listOf(nodes, "patterns"), listOf(nodes, "seams").filter((s) => s !== id)), { op: "remove", id }];

// A path that comes back to its start: the last segment lands exactly on `start` (the shape
// tools write it so), or within 1e-9 of it.
export function isClosedPath(path) {
    const last = path?.segments?.at(-1);
    const end = last?.to ?? last?.points?.at(-1);
    return !!end && Math.hypot(end[0] - path.start[0], end[1] - path.start[1]) <= 1e-9;
}
