// The live drape's pure helpers: the cloth's triangles split per pattern for drawing, the
// nearest vertex to a picked point, a drag's plane from the View's camera, what a garment edit
// does to a live cloth, the two phases, the health line and the step rate. No kernel and no
// View in here, so Node can test it.

// The kernel hero's sewing frames: a new cloth sews with gravity off until every seam pair is
// welded, or for this many frames, whichever comes first.
export const SEW_FRAMES = 60;
// A particle faster than FAST_SPEED (mm/s) is flagged on the health line; faster than
// MAX_SPEED the cloth has blown up (a tangle, a piece pulled through the avatar) and the
// simulation pauses. A settled sample shirt still spikes to 7-10 m/s now and then (a weld
// snapping shut); the blow-ups measured ran 20-60 m/s with steps of seconds.
export const FAST_SPEED = 20000;
export const MAX_SPEED = 50000;
// A step slower than this (ms) means the same, seen from the clock: a collapsed cloth makes
// the self-collision search crawl.
export const MAX_STEP_MS = 5000;
// The status' eight doubles, by name (cloth_status).
export const STATUS = ["frame", "vertices", "triangles", "seamPairs", "welded", "nonFinite", "dropped", "maxSpeed"];
export const statusOf = (s) => Object.fromEntries(STATUS.map((n, i) => [n, s[i]]));

// The cloth's triangles drawn one mesh per pattern: each triangle goes to the pattern of its
// first vertex (patterns keep their own vertices: a seam is a weld, never a shared vertex).
// -> Map pattern -> { verts: Uint32Array (sim vertex indices), indices: Uint32Array (local) }
export function splitByPattern(triangles, vertexPatterns) {
    const groups = new Map();
    const group = (p) => {
        let g = groups.get(p);
        if (!g) { g = { local: new Map(), verts: [], indices: [] }; groups.set(p, g); }
        return g;
    };
    const localOf = (g, v) => {
        let i = g.local.get(v);
        if (i === undefined) { i = g.verts.length; g.local.set(v, i); g.verts.push(v); }
        return i;
    };
    for (let t = 0; t + 2 < triangles.length; t += 3) {
        const g = group(vertexPatterns[triangles[t]]);
        for (let k = 0; k < 3; k++) g.indices.push(localOf(g, triangles[t + k]));
    }
    const out = new Map();
    for (const [p, g] of groups) out.set(p, { verts: Uint32Array.from(g.verts), indices: Uint32Array.from(g.indices) });
    return out;
}

// A read scene's vertices are nine floats each: position, normal, colour.
export const SCENE_STRIDE = 9;
// A read scene (the avatar) as the cloth's collider: its vertex positions back in the file's
// coordinates (they are relative to origin()) and its triangle indices.
export function avatarMesh(vertices, origin, indices) {
    const n = Math.floor(vertices.length / SCENE_STRIDE);
    const positions = new Float64Array(3 * n);
    for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) positions[3 * i + a] = vertices[SCENE_STRIDE * i + a] + origin[a];
    return { positions, indices: Uint32Array.from(indices) };
}

// The xyz of `verts` out of the whole cloth's positions, as one Float32Array.
export function gather(positions, verts, out = new Float32Array(verts.length * 3)) {
    for (let i = 0; i < verts.length; i++) {
        const v = 3 * verts[i];
        out[3 * i] = positions[v]; out[3 * i + 1] = positions[v + 1]; out[3 * i + 2] = positions[v + 2];
    }
    return out;
}

// The sim vertex nearest `point`, among `verts` (every vertex when absent); -1 for none.
export function nearestVertex(positions, point, verts = null) {
    let best = -1, bestD = Infinity;
    const n = verts ? verts.length : positions.length / 3;
    for (let i = 0; i < n; i++) {
        const v = verts ? verts[i] : i;
        const dx = positions[3 * v] - point[0], dy = positions[3 * v + 1] - point[1], dz = positions[3 * v + 2] - point[2];
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bestD) { bestD = d; best = v; }
    }
    return best;
}

// ---- dragging on the plane facing the camera ------------------------------------------------
// The View's orbit camera (crates/cadaclysm-view camera.rs): the eye sits `distance` from the
// target, `pitch` above the orbit's XY plane and `yaw` round from -Y; under y up the orbit's
// frame maps to the model's by to_model (x, y, z) -> (x, z, -y). VERTICAL_HALF_FOV is 0.4 rad.
const HALF_FOV = 0.4;
const toModel = ([x, y, z]) => [x, z, -y];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// The screen's right and up in world space, and the world length of one device pixel at
// `point`'s depth, from `camera` (the View's camera(0)) and the canvas height in device pixels.
// null for a camera without yaw/pitch (an ortho plane, a fixed camera).
export function dragBasis(camera, point, heightPx) {
    if (!camera || typeof camera.yaw !== "number" || typeof camera.pitch !== "number") return null;
    const sy = Math.sin(camera.yaw), cy = Math.cos(camera.yaw), sp = Math.sin(camera.pitch), cp = Math.cos(camera.pitch);
    const forward = toModel([-cp * sy, cp * cy, -sp]);
    const right = toModel([cy, sy, 0]);
    const up = toModel([-sp * sy, sp * cy, cp]);
    let eye = camera.eye;
    if (!eye && camera.target) {
        const off = toModel([cp * sy, -cp * cy, sp]);
        eye = [0, 1, 2].map((k) => camera.target[k] + camera.distance * off[k]);
    }
    if (!eye) return null;
    const depth = camera.orthographic ? camera.distance : dot([0, 1, 2].map((k) => point[k] - eye[k]), forward);
    const perPixel = (2 * Math.max(depth, 1e-6) * Math.tan(HALF_FOV)) / Math.max(heightPx, 1);
    return { right, up, perPixel, forward, eye };
}

// Where a drag that started at `start` (world) has moved to, after the pointer moved (dx, dy)
// device pixels (y down) on the plane through `start` facing the camera.
export function dragTarget(start, basis, dx, dy) {
    const s = basis.perPixel;
    return [0, 1, 2].map((k) => start[k] + basis.right[k] * dx * s - basis.up[k] * dy * s);
}

// ---- what a garment edit does to a live cloth -----------------------------------------------
// Compare the document's nodes before and after an edit:
//   { kind: "same" }                      nothing the cloth reads changed (labels, allowance,
//                                         notches, the 3D arrangement: Reset picks those up);
//   { kind: "remesh", patterns: [ids] }   outlines, grains, layers, mesh sizes or seam ranges changed:
//                                         cloth_remesh_pattern each, the drape kept;
//   { kind: "stale", why }                patterns, seams or fabrics added, removed or
//                                         changed otherwise: Reset rebuilds the cloth.
// The simulation controls (S1): a piece's strengthen and pressure, its outline elastics' numbers,
// its fold lines and elastic lines, a fabric's shrinkage, a seam's strength and elastic numbers
// and a tack's ends re-mesh the pieces they are on (cloth_remesh_pattern reads them); adding or
// removing a tack or an elastic is a rebuild, and so is a new particle distance in the saved
// options. A piece's `frozen` and `pins` and the other options are live edits (frozenChanges,
// optionsChanged): the same mesh.
const PATTERN_KEYS = ["grain", "layer", "particle_distance", "strengthen", "pressure"];
const SEAM_RANGE = ["a_from", "a_to", "b_from", "b_to", "reversed", "strengthen"];
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const hasElastic = (e) => !!e && Object.keys(e).length > 0;
// A piece's internal lines as the cloth reads them: fold lines and elastic lines (a plain line or
// a dart is drawn only).
const clothLines = (p) => (p.internal ?? []).filter((l) => l.kind === "fold" || hasElastic(l.elastic));
// How many elastics a piece carries: its outline elastics and its elastic lines.
const elasticCount = (p) => (p.elastic?.length ?? 0) + (p.internal ?? []).filter((l) => hasElastic(l.elastic)).length;
const optionsOf = (byId) => byId.get("garment")?.sim_options ?? {};
export function garmentChange(before, after) {
    const kinds = (nodes, kind) => new Map(nodes.filter((n) => n.kind === kind).map((n) => [n.id, n]));
    const byId = (nodes) => new Map(nodes.map((n) => [n.id, n]));
    const b = byId(before), a = byId(after);
    const pb = kinds(before, "garment.pattern"), pa = kinds(after, "garment.pattern");
    const sb = kinds(before, "garment.seam"), sa = kinds(after, "garment.seam");
    const fb = kinds(before, "garment.fabric"), fa = kinds(after, "garment.fabric");
    const tb = kinds(before, "garment.tack"), ta = kinds(after, "garment.tack");
    const keys = (m) => [...m.keys()].sort().join(",");
    if (keys(pb) !== keys(pa)) return { kind: "stale", why: "the pieces changed" };
    if (keys(sb) !== keys(sa)) return { kind: "stale", why: "the seams changed" };
    if (keys(fb) !== keys(fa)) return { kind: "stale", why: "the fabrics changed" };
    if (keys(tb) !== keys(ta) || !same(b.get("garment")?.tacks, a.get("garment")?.tacks)) return { kind: "stale", why: "the tacks changed" };
    if (!same(b.get("garment")?.patterns, a.get("garment")?.patterns)) return { kind: "stale", why: "the pieces changed" };
    if (!same(optionsOf(b).particle_distance, optionsOf(a).particle_distance)) return { kind: "stale", why: "the particle distance changed" };
    const changed = new Set();
    for (const [id, f] of fa) {
        const { label, colour, meta, shrinkage, ...rest } = f;
        const { label: l0, colour: c0, meta: m0, shrinkage: s0, ...rest0 } = fb.get(id);
        if (!same(rest, rest0)) return { kind: "stale", why: `fabric ${label ?? id} changed` };
        // a new shrinkage re-meshes every piece cut from the fabric
        if (!same(shrinkage, s0)) for (const [pid, p] of pa) if (p.fabric === id) changed.add(pid);
    }
    for (const [id, p] of pa) {
        const q = pb.get(id);
        if (p.fabric !== q.fabric) return { kind: "stale", why: `${p.label ?? id} changed fabric` };
        if (elasticCount(p) !== elasticCount(q)) return { kind: "stale", why: `${p.label ?? id}'s elastics changed` };
        if (PATTERN_KEYS.some((k) => !same(p[k], q[k]))) changed.add(id);
        if (!same(p.elastic, q.elastic) || !same(clothLines(p), clothLines(q))) changed.add(id);
        if (!same(a.get(p.outline), b.get(q.outline)) || p.outline !== q.outline) changed.add(id);
    }
    for (const [id, s] of sa) {
        const t = sb.get(id);
        if (s.a !== t.a || s.b !== t.b) return { kind: "stale", why: "the seams changed" };
        if (hasElastic(s.elastic) !== hasElastic(t.elastic)) return { kind: "stale", why: "a seam's elastic changed" };
        // a seam re-anchored by an outline edit moves with its pattern; one edited alone
        // re-meshes both its sides
        if ((SEAM_RANGE.some((k) => !same(s[k], t[k])) || !same(s.elastic, t.elastic)) && !changed.has(s.a) && !changed.has(s.b)) { changed.add(s.a); changed.add(s.b); }
    }
    for (const [id, t] of ta) {
        const u = tb.get(id);
        if (t.a !== u.a || t.b !== u.b) return { kind: "stale", why: "the tacks changed" };
        if (!same(t.a_at, u.a_at) || !same(t.b_at, u.b_at)) { changed.add(t.a); changed.add(t.b); }
    }
    return changed.size ? { kind: "remesh", patterns: [...changed] } : { kind: "same" };
}

// The pieces frozen or unfrozen between two node lists: [{id, on}] (a piece in both).
export function frozenChanges(before, after) {
    const was = new Map(before.filter((n) => n.kind === "garment.pattern").map((n) => [n.id, !!n.frozen]));
    return after.filter((n) => n.kind === "garment.pattern" && was.has(n.id) && was.get(n.id) !== !!n.frozen).map((n) => ({ id: n.id, on: !!n.frozen }));
}
// Whether the garment's saved options differ.
export const optionsChanged = (before, after) => !same(optionsOf(new Map(before.map((n) => [n.id, n]))), optionsOf(new Map(after.map((n) => [n.id, n]))));

// A 2D move is not a shape change. The outline path JSON `b` as `a` moved by (dx, dy): every
// point (each two-number array: start, to, controls, centres) shifted by the same amount and
// everything else equal. -> [dx, dy], or null when `b` is not `a` moved.
export function pathOffset(a, b, eps = 1e-6) {
    let d = null;
    const walk = (x, y) => {
        if (Array.isArray(x) && x.length === 2 && typeof x[0] === "number" && typeof x[1] === "number") {
            if (!Array.isArray(y) || y.length !== 2) return false;
            const dx = y[0] - x[0], dy = y[1] - x[1];
            if (!d) { d = [dx, dy]; return true; }
            return Math.abs(dx - d[0]) < eps && Math.abs(dy - d[1]) < eps;
        }
        if (Array.isArray(x)) return Array.isArray(y) && x.length === y.length && x.every((v, i) => walk(v, y[i]));
        if (x && typeof x === "object") {
            if (!y || typeof y !== "object" || Array.isArray(y)) return false;
            const kx = Object.keys(x).sort(), ky = Object.keys(y).sort();
            return kx.join() === ky.join() && kx.every((k) => walk(x[k], y[k]));
        }
        if (typeof x === "number") return typeof y === "number" && Math.abs(x - y) < eps;
        return x === y;
    };
    return walk(a, b) ? d ?? [0, 0] : null;
}
// The path JSON with every point moved by `d`.
export function translatePath(path, d) {
    const map = (x) => {
        if (Array.isArray(x) && x.length === 2 && typeof x[0] === "number" && typeof x[1] === "number") return [x[0] + d[0], x[1] + d[1]];
        if (Array.isArray(x)) return x.map(map);
        if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, map(v)]));
        return x;
    };
    return map(path);
}

// The cloth keeps each pattern where it was meshed: a pattern moved in 2D (and maybe edited
// since) is put back by the offset it moved, so a re-mesh maps its points onto the old
// triangles. `base` the nodes the cloth was meshed from (outlines in its frame), `nodes` the
// garment now, `offsets` pattern id -> [dx, dy] so far (updated in place).
// -> the ops that set every moved outline, with its internal lines and saved pins, back into the
// cloth's frame (none when nothing moved).
export function frameOps(base, nodes, offsets) {
    const byId = (ns) => new Map(ns.map((n) => [n.id, n]));
    const b = byId(base), n = byId(nodes);
    const ops = [];
    for (const p of nodes) {
        if (p.kind !== "garment.pattern") continue;
        const was = b.get(b.get(p.id)?.outline)?.path, now = n.get(p.outline)?.path;
        if (!was || !now) continue;
        const moved = pathOffset(was, now);
        if (moved) {
            if (moved[0] || moved[1]) { offsets.set(p.id, moved); ops.push({ op: "set", id: p.outline, fields: { path: was } }, ...pieceBack(p, moved)); }
            else offsets.delete(p.id);
            continue;
        }
        const off = offsets.get(p.id);
        if (off) ops.push({ op: "set", id: p.outline, fields: { path: translatePath(now, [-off[0], -off[1]]) } }, ...pieceBack(p, off));
    }
    // a tack's end on a moved piece (model.pieceOps carries it with the piece) goes back too
    for (const t of nodes) {
        if (t.kind !== "garment.tack") continue;
        const fields = {};
        for (const [end, at] of [["a", "a_at"], ["b", "b_at"]]) {
            const off = offsets.get(t[end]);
            if (off && t[at]) fields[at] = [t[at][0] - off[0], t[at][1] - off[1]];
        }
        if (Object.keys(fields).length) ops.push({ op: "set", id: t.id, fields });
    }
    return ops;
}
// What else of piece `p` the document holds in its own frame, moved back by `off`: its internal
// lines (a 2D move carries them with the outline: kernel.js transformedPiece) and its saved pins
// (Drape.pinPlace saves them where the piece stands).
function pieceBack(p, off) {
    const fields = {}, back = [-off[0], -off[1]];
    if (p.internal?.length) fields.internal = p.internal.map((l) => (l.path ? { ...l, path: translatePath(l.path, back) } : l));
    if (p.pins?.length) fields.pins = p.pins.map((q) => [q[0] + back[0], q[1] + back[1]]);
    return Object.keys(fields).length ? [{ op: "set", id: p.id, fields }] : [];
}

// ---- phases, health, rate --------------------------------------------------------------------
// Whether a cloth still sewing (gravity off) should start draping, from its status.
export function sewingDone(status, sewFrames = SEW_FRAMES) {
    const s = statusOf(status);
    return s.seamPairs === 0 || s.welded >= s.seamPairs || s.frame >= sewFrames;
}

// The health line from the status: { text, warn, stop }. `warn` when particles were dropped,
// went non-finite or move faster than FAST_SPEED; `stop` (the simulation pauses) when any
// went non-finite or one is faster than MAX_SPEED.
export function healthOf(status, phase) {
    const s = statusOf(status);
    const parts = [`frame ${s.frame}`, phase, `seams ${s.welded}/${s.seamPairs}`, `${s.vertices} vertices`, `${s.triangles} triangles`,
        `max ${Math.round(s.maxSpeed)} mm/s`];
    if (s.nonFinite) parts.push(`${s.nonFinite} non-finite`);
    if (s.dropped) parts.push(`${s.dropped} dropped`);
    const fast = s.maxSpeed > FAST_SPEED, wild = s.maxSpeed > MAX_SPEED;
    if (fast) parts.push(wild ? "unstable" : "fast");
    return { text: parts.join(" · "), warn: !!(s.nonFinite || s.dropped || fast), stop: !!s.nonFinite || wild };
}

// Simulated frames per second over the last `window` ms of step end times, and the mean step time.
export class RateMeter {
    constructor(window = 3000) { this.window = window; this.marks = []; }
    clear() { this.marks = []; }
    add(t, ms) {
        this.marks.push([t, ms]);
        while (this.marks.length > 2 && t - this.marks[0][0] > this.window) this.marks.shift();
    }
    get fps() {
        const m = this.marks;
        if (m.length < 2) return 0;
        const span = m[m.length - 1][0] - m[0][0];
        return span > 0 ? ((m.length - 1) * 1000) / span : 0;
    }
    get ms() { return this.marks.length ? this.marks.reduce((s, [, ms]) => s + ms, 0) / this.marks.length : 0; }
}
