// The garment as a blacksmith document: node builders and the op lists that edit it.
// Pure: no kernel calls. Every function takes the current node list (document_nodes) and
// returns ops for one batch, so one user action is one undo step.
// (sewing.js imports addSeam from here: neither module touches the other's exports at load.)
import { shiftAnchors, splitAnchors, mergeAnchors } from "./sewing.js";

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
// An open path through `points` (an internal line): curves[i] = {c1, c2} makes the segment from
// point i to point i + 1 a cubic, else it is a line.
export function openPath(points, curves = []) {
    const segments = points.slice(1).map((p, i) => {
        const c = curves[i];
        return c ? { type: "bezier", c1: pt(c.c1), c2: pt(c.c2), to: pt(p) } : { type: "line", to: pt(p) };
    });
    return { start: pt(points[0]), segments };
}

export const rectPath = (x, y, w, h) => polyPath([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]);

// A segment's end point: `to`, or a NURBS span's last control point.
export const segmentEnd = (s) => s.to ?? s.points.at(-1);
export const pathPoints = (path) => [path.start, ...path.segments.slice(0, -1).map(segmentEnd)].map(pt);

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

// A copy of fabric `id` -- the same cloth numbers and meta, so the same physics -- as a new
// node: id `<id>_2` (or the next free number), label "<label> copy" (or "copy 2", ...).
export function duplicateFabric(nodes, id) {
    const map = byId(nodes), src = map.get(id);
    if (!src || src.kind !== "garment.fabric") throw new Error(`no fabric ${id}`);
    let k = 2;
    while (map.has(`${id}_${k}`)) k++;
    const labels = new Set(nodes.filter((n) => n.kind === "garment.fabric").map((n) => n.label));
    const base = `${src.label ?? id} copy`;
    let label = base;
    for (let j = 2; labels.has(label); j++) label = `${base} ${j}`;
    const node = { id: `${id}_${k}`, kind: "garment.fabric", label };
    for (const f of FABRIC_FIELDS) node[f] = src[f];
    if (src.meta) node.meta = JSON.parse(JSON.stringify(src.meta));
    return { id: node.id, ops: [{ op: "add", node }] };
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

// A fillet's ops: the new outline, the allowance list with the arc's width (its neighbour's)
// inserted, the notches re-placed, and the seam anchors past the arc moved up one; the commit's
// re-anchor (reanchorId) then sets their arc lengths. One batch.
export function filletOps(nodes, id, path, insertAt, notches) {
    const p = byId(nodes).get(id), oldSides = path.segments.length - 1;
    const allowance = p.allowance ?? [10];
    const list = allowance.length === oldSides && oldSides > 1
        ? [...allowance.slice(0, insertAt), allowance[Math.max(insertAt - 1, 0)], ...allowance.slice(insertAt)] : allowance;
    return [...setOutline(nodes, id, path), ...setPattern(nodes, id, { allowance: list, ...(p.notches ? { notches } : {}) }), ...shiftAnchors(nodes, id, insertAt)];
}

// Point editing (spec §3), each one batch; the commit's re-anchor (reanchorId) then sets the
// seams' arc lengths from the anchors written here.
// A point inserted on side `side` at fraction `t0` of its arc length (kernel.js insertPointOps):
// the new outline, the split side's allowance width given to both halves, the seam anchors split
// (sewing.js splitAnchors). The outline is the same curve, so notches keep their arc lengths.
export function insertPointOps(nodes, id, path, side, t0) {
    const p = byId(nodes).get(id), oldSides = path.segments.length - 1;
    const allowance = p.allowance ?? [10];
    const list = allowance.length === oldSides && oldSides > 1
        ? [...allowance.slice(0, side + 1), allowance[side], ...allowance.slice(side + 1)] : allowance;
    return [...setOutline(nodes, id, path), ...(list !== allowance ? setPattern(nodes, id, { allowance: list }) : []), ...splitAnchors(nodes, id, side, t0)];
}
// Points removed (kernel.js removePointsOps): `steps` in the order the kernel took them, each
// {vertex, count (sides before it), w (the first merged side's share)}; each removal drops the
// allowance entry of the side that starts at the point (the merged side keeps the one before's),
// and merges the seam anchors (sewing.js mergeAnchors). The notches re-placed by the kernel.
export function removePointsOps(nodes, id, path, steps, notches) {
    const p = byId(nodes).get(id);
    let list = [...(p.allowance ?? [10])], cur = nodes;
    const seamSets = new Map();
    for (const { vertex, count, w } of steps) {
        if (list.length === count && count > 1) list.splice(vertex, 1);
        const ops = mergeAnchors(cur, id, vertex, count, w);
        for (const o of ops) seamSets.set(o.id, o);
        cur = withAdded(cur, ops);
    }
    const fields = { ...(p.allowance && list.length !== p.allowance.length ? { allowance: list } : {}), ...(p.notches ? { notches } : {}) };
    return [...setOutline(nodes, id, path), ...(Object.keys(fields).length ? setPattern(nodes, id, fields) : []), ...seamSets.values()];
}
// Points made curve points or corners: the same sides, so the anchors stand; notches re-placed.
export const smoothPointsOps = (nodes, id, path, notches) =>
    [...setOutline(nodes, id, path), ...(byId(nodes).get(id)?.notches ? setPattern(nodes, id, { notches }) : [])];
// Internal entry `line` of piece `id` with a new path (its point edited).
export function setInternalPath(nodes, id, line, path) {
    const p = byId(nodes).get(id);
    return setPattern(nodes, id, { internal: (p.internal ?? []).map((l, i) => (i === line ? { ...l, path: { start: path.start, segments: path.segments } } : l)) });
}

// A hole added to piece `id`'s outline (path JSON, closed). Hole edges are not sewn this round.
export function addHole(nodes, id, path) {
    const outline = byId(nodes).get(`${id}_outline`).path;
    return setOutline(nodes, id, { ...outline, holes: [...(outline.holes ?? []), { start: path.start, segments: path.segments }] });
}

// An internal entry on piece `id`: a line, or a closed shape (the internal shape tools).
export function addInternal(nodes, id, path, kind = "line") {
    const p = byId(nodes).get(id);
    return setPattern(nodes, id, { internal: [...(p.internal ?? []), { kind, path: { start: path.start, segments: path.segments } }] });
}
// Internal entry `index` of piece `id`, a closed shape, moved into the outline's holes: one batch.
// null for an open or missing entry.
export function convertToHole(nodes, id, index) {
    const p = byId(nodes).get(id), entry = p?.internal?.[index];
    if (!entry || !isClosedPath(entry.path)) return null;
    return [...setPattern(nodes, id, { internal: p.internal.filter((_, i) => i !== index) }), ...addHole(nodes, id, entry.path)];
}

// A piece traced from internal shape `path` of piece `id` (spec §4: Trace): the source's fabric,
// layer, first allowance and grain, labelled "‹label› trace" (suffixed when taken).
export function tracePattern(nodes, id, path) {
    const p = byId(nodes).get(id);
    return addPattern(nodes, { label: freeLabel(nodes, `${p.label ?? "Piece"} trace`), path, fabric: p.fabric, layer: p.layer ?? 0, allowance: (p.allowance ?? [10])[0], grain: p.grain ?? [0, 1] });
}

// `nodes` with ops applied (add, set, remove): what a batch leaves, for the next builder's ids.
export function withAdded(nodes, ops) {
    let out = nodes.slice();
    for (const o of ops) {
        if (o.op === "add") out = [...out, o.node];
        else if (o.op === "set") out = out.map((n) => (n.id === o.id ? { ...n, ...o.fields } : n));
        else if (o.op === "remove") out = out.filter((n) => n.id !== o.id);
    }
    return out;
}

// Piece `id` replaced by `pieces` (a cut): each a new pattern with the old one's fabric, grain,
// layer and frame, and its allowance (a per-side list collapsed to its first width: ruling 14);
// each seam end moved to its piece (`seamMoves`), `dropped` seams removed, and with `sew` one seam
// joining the two cut edges. One batch. -> {ops, ids, collapsed}
export function replacePattern(nodes, id, pieces, { seamMoves = [], dropped = [], sew = null } = {}) {
    const old = byId(nodes).get(id);
    const allowance = old.allowance ?? [10];
    const collapsed = new Set(allowance).size > 1;
    const ops = [], ids = [];
    let cur = nodes;
    for (const p of pieces) {
        const r = addPattern(cur, { label: freeLabel(cur, p.label), path: p.path, fabric: old.fabric, layer: old.layer ?? 0, allowance: allowance[0], grain: old.grain ?? [0, 1] });
        const node = r.ops.find((o) => o.node?.kind === "garment.pattern").node;
        if (p.notches?.length) node.notches = p.notches;
        if (p.internal?.length) node.internal = p.internal;
        if (old.frame !== undefined) node.frame = old.frame;
        ops.push(...r.ops); ids.push(r.id);
        cur = withAdded(cur, r.ops);
    }
    const bySeam = new Map();
    for (const mv of seamMoves) bySeam.set(mv.id, [...(bySeam.get(mv.id) ?? []), mv]);
    for (const [sid, moves] of bySeam) {
        const seam = byId(cur).get(sid);
        const fields = {}, anchor = { ...(seam.meta?.atelier ?? {}) };
        for (const mv of moves) {
            fields[mv.end] = ids[mv.piece]; fields[`${mv.end}_from`] = mv.from; fields[`${mv.end}_to`] = mv.to;
            anchor[mv.end] = mv.anchor;
        }
        fields.meta = { ...(seam.meta ?? {}), atelier: anchor };
        ops.push({ op: "set", id: sid, fields });
    }
    // the new pieces take the cut piece's place in the list
    const g = byId(cur).get("garment");
    const patterns = g.patterns.filter((p) => !ids.includes(p)).flatMap((p) => (p === id ? ids : [p]));
    ops.push({ op: "set", id: "garment", fields: { patterns, seams: g.seams.filter((s) => !dropped.includes(s)) } });
    for (const s of dropped) ops.push({ op: "remove", id: s });
    ops.push({ op: "remove", id }, { op: "remove", id: `${id}_outline` });
    if (sew) {
        // its id is new against every seam before the batch, the dropped ones too (a status names those)
        const after = withAdded(nodes, ops);
        ops.push(...addSeam(after, { id: nextId(cur, "s"), a: ids[0], b: ids[1], a_from: sew.a.from, a_to: sew.a.to, b_from: sew.b.from, b_to: sew.b.to, reversed: sew.reversed, anchor: { a: sew.a.anchor, b: sew.b.anchor } }).ops);
    }
    return { ops, ids, collapsed };
}

// Piece `id` set to a transformed piece r = {path, internal, notches, grain} (kernel.js
// transformedPiece): its outline, and its internal lines, notches and grain where it has them
// or the transform gives them. The caller re-anchors the seams in the same commit.
// `ids`: every piece the same matrix moves. An unfolded piece's half and axis move with it (r.unfold);
// a linked piece's axis moves only when its partner is among `ids` (spec §6: moving one piece
// keeps the axis, and the partner is rebuilt the mirrored way).
export function pieceOps(nodes, id, r, ids = [id]) {
    const n = byId(nodes).get(id), fields = {};
    if (n?.internal || r.internal?.length) fields.internal = r.internal ?? [];
    if (n?.notches || r.notches?.length) fields.notches = r.notches ?? [];
    if (r.grain) fields.grain = r.grain;
    let meta = n?.meta;
    if (r.unfold && meta?.atelier?.unfold) meta = atelierMeta(meta, "unfold", r.unfold);
    const link = meta?.atelier?.link;
    if (r.linkAxis && link && ids.includes(link.partner)) meta = atelierMeta(meta, "link", { ...link, axis: r.linkAxis });
    if (meta !== n?.meta) fields.meta = meta;
    return [...setOutline(nodes, id, r.path), ...(Object.keys(fields).length ? setPattern(nodes, id, fields) : [])];
}

// The in-app clipboard (spec §2): copies of pieces `ids` (each its node and outline path) and the
// seams with both ends among them. Plain data: it outlives the pieces.
export function copyPieces(nodes, ids) {
    const map = byId(nodes), clone = (v) => JSON.parse(JSON.stringify(v));
    const live = ids.filter((id) => map.get(id)?.kind === "garment.pattern" && map.has(`${id}_outline`));
    return {
        pieces: live.map((id) => ({ node: clone(map.get(id)), path: clone(map.get(`${id}_outline`).path) })),
        seams: nodes.filter((n) => n.kind === "garment.seam" && live.includes(n.a) && live.includes(n.b)).map(clone),
    };
}

// The clipboard's pieces added as new ones, each from `placed[i]` ({path, internal, notches,
// grain}: the kernel's moved copy of piece i), labelled "‹label› copy" (made unique), keeping
// fabric, layer, allowance, mesh size and the rest but not the slot (no frame, no meta slot: it
// lies on the floor); its inner seams copied onto the new pieces. One batch. -> {ops, ids}
export function pasteOps(nodes, clip, placed) {
    const ops = [], ids = [], idOf = new Map();
    let cur = nodes;
    clip.pieces.forEach(({ node }, i) => {
        const r = addPattern(cur, { label: freeLabel(cur, `${node.label ?? "Piece"} copy`), path: placed[i].path, fabric: node.fabric });
        const add = r.ops.find((o) => o.node?.kind === "garment.pattern");
        const { id: _i, outline: _o, label: _l, frame: _f, meta, ...rest } = JSON.parse(JSON.stringify(node));
        Object.assign(add.node, rest, { grain: placed[i].grain ?? rest.grain ?? [0, 1] });
        if (placed[i].internal?.length) add.node.internal = placed[i].internal; else delete add.node.internal;
        if (placed[i].notches?.length) add.node.notches = placed[i].notches; else delete add.node.notches;
        if (meta) {
            const atelier = { ...(meta.atelier ?? {}) };
            delete atelier.slot;
            // a copy is linked to nothing (spec §6); an unfolded one keeps its half, moved with it
            delete atelier.link;
            if (placed[i].unfold) atelier.unfold = placed[i].unfold; else delete atelier.unfold;
            const m2 = { ...meta, atelier };
            if (!Object.keys(atelier).length) delete m2.atelier;
            if (Object.keys(m2).length) add.node.meta = m2;
        }
        ops.push(...r.ops); ids.push(r.id); idOf.set(node.id, r.id);
        cur = withAdded(cur, r.ops);
    });
    // an M:N group's copies form a new group when all its ranges' pieces were copied, else they
    // are plain seams (seamgroup.js)
    const groupIds = new Map();
    let groupNo = Math.max(0, ...nodes.map((n) => /^g(\d+)$/.exec(n.meta?.atelier?.group?.id ?? "")?.[1] ?? 0).map(Number));
    for (const sm of clip.seams) {
        const { id: _s, kind: _k, a, b, ...rest } = JSON.parse(JSON.stringify(sm));
        const g = rest.meta?.atelier?.group;
        if (g) {
            const all = [...g.a, ...g.b].every((r) => idOf.has(r.pattern));
            if (all) {
                if (!groupIds.has(g.id)) groupIds.set(g.id, `g${++groupNo}`);
                const map = (rs) => rs.map((r) => ({ ...r, pattern: idOf.get(r.pattern) }));
                rest.meta.atelier.group = { ...g, id: groupIds.get(g.id), a: map(g.a), b: map(g.b) };
            } else { delete rest.meta.atelier.group; delete rest.meta.atelier.member; }
        }
        const id = nextId(cur, "s");
        const r = [{ op: "add", node: { id, kind: "garment.seam", a: idOf.get(a), b: idOf.get(b), ...rest } },
            ...garmentOps(cur, listOf(cur, "patterns"), [...listOf(cur, "seams"), id])];
        ops.push(...r);
        cur = withAdded(cur, r);
    }
    return { ops, ids };
}

// `id` (optional): the new seam's id, when `nodes` lacks seams whose ids must not come back.
export function addSeam(nodes, { a, b, a_from, a_to, b_from, b_to, reversed, anchor, id = nextId(nodes, "s") }) {
    const node = { id, kind: "garment.seam", a, b, a_from, a_to, b_from, b_to, reversed: !!reversed };
    if (anchor) node.meta = { atelier: anchor };
    return { id, ops: [{ op: "add", node }, ...garmentOps(nodes, listOf(nodes, "patterns"), [...listOf(nodes, "seams"), id])] };
}

// Seams `ids` removed in one batch.
export const removeSeams = (nodes, ids) => (ids.length
    ? [...garmentOps(nodes, listOf(nodes, "patterns"), listOf(nodes, "seams").filter((s) => !ids.includes(s))), ...ids.map((id) => ({ op: "remove", id }))]
    : []);

// `meta` with meta.atelier[key] set to `value` (undefined: removed; an empty atelier goes too).
export function atelierMeta(meta, key, value) {
    const atelier = { ...(meta?.atelier ?? {}) };
    if (value === undefined) delete atelier[key]; else atelier[key] = value;
    const out = { ...(meta ?? {}) };
    if (Object.keys(atelier).length) out.atelier = atelier; else delete out.atelier;
    return out;
}

// Spec §6, the Sym tool: piece `id`'s mirrored copy `piece` ({path, internal, notches, grain}:
// kernel.js mirroredPiece across `axis`) added as its linked partner, "‹label› (sym)" with the
// source's fabric, layer and allowance list (the kernel keeps the side order); both pieces get
// meta.atelier.link = {partner, axis}. One batch. -> {id, ops}
export function linkedCopyOps(nodes, id, piece, axis) {
    const src = byId(nodes).get(id);
    if (!src) throw new Error(`no pattern ${id}`);
    if (src.meta?.atelier?.link) throw new Error("sym: the piece is linked already");
    if (src.meta?.atelier?.unfold) throw new Error("sym: the piece is unfolded: fold it back or unlink it first");
    const r = addPattern(nodes, { label: freeLabel(nodes, `${src.label ?? "Piece"} (sym)`), path: piece.path, fabric: src.fabric, layer: src.layer ?? 0, allowance: src.allowance ?? [10], grain: piece.grain ?? src.grain ?? [0, 1] });
    const node = r.ops.find((o) => o.op === "add" && o.node?.kind === "garment.pattern").node;
    if (piece.internal?.length) node.internal = piece.internal;
    if (piece.notches?.length) node.notches = piece.notches;
    node.meta = { atelier: { link: { partner: id, axis: [...axis] } } };
    return { id: r.id, ops: [...r.ops, ...setPattern(nodes, id, { meta: atelierMeta(src.meta, "link", { partner: r.id, axis: [...axis] }) })] };
}
// Unlink (spec §6): piece `id` without its link (and its partner without the link back) or
// without its unfold (the whole stays as an ordinary piece). One batch; [] when it has neither.
export function unlinkOps(nodes, id) {
    const map = byId(nodes), n = map.get(id), link = n?.meta?.atelier?.link;
    if (!link && !n?.meta?.atelier?.unfold) return [];
    const ops = setPattern(nodes, id, { meta: atelierMeta(atelierMeta(n.meta, "link"), "unfold") });
    const partner = link && map.get(link.partner);
    if (partner?.meta?.atelier?.link?.partner === id) ops.push(...setPattern(nodes, partner.id, { meta: atelierMeta(partner.meta, "link") }));
    return ops;
}

export const removeSeam = (nodes, id) =>
    [...garmentOps(nodes, listOf(nodes, "patterns"), listOf(nodes, "seams").filter((s) => s !== id)), { op: "remove", id }];

// A path that comes back to its start: the last segment lands exactly on `start` (the shape
// tools write it so), or within 1e-9 of it.
export function isClosedPath(path) {
    const last = path?.segments?.at(-1);
    const end = last && segmentEnd(last);
    return !!end && Math.hypot(end[0] - path.start[0], end[1] - path.start[1]) <= 1e-9;
}
