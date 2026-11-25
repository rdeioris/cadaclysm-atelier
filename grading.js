// Grading (A3 spec): one size drafted, the others graded from it by per-point rules. The size
// table lives in the garment node's meta.atelier.grading = {sizes, base, current}; each graded
// piece keeps meta.atelier.grade = {base: its outline in the base size (no holes), rules:
// {<vertex index>: {<size>: [dx, dy]}}}. A missing rule is [0, 0]. This is the app's arithmetic
// on the user's rule table (like a transform's matrix): pure, no kernel, so Node tests it.

const EPS = 1e-12;
const clone = (v) => JSON.parse(JSON.stringify(v));
const add = (p, d) => [p[0] + d[0], p[1] + d[1]];
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const isZero = (d) => !d || (Math.abs(d[0]) <= EPS && Math.abs(d[1]) <= EPS);
const segEnd = (s) => s.to ?? s.points.at(-1);

// ---- the size table ----
export const gradingOf = (garment) => garment?.meta?.atelier?.grading ?? null;
export const gradeOf = (pattern) => pattern?.meta?.atelier?.grade ?? null;

function checkName(name) {
    const n = typeof name === "string" ? name.trim() : "";
    if (!n) throw new Error("a size needs a name");
    return n;
}
// The table with size `name` added at `at` (the end by default). With no table, a new one with
// that size as base and current.
export function addSize(table, name, at = null) {
    const n = checkName(name);
    if (!table) return { sizes: [n], base: n, current: n };
    if (table.sizes.includes(n)) throw new Error(`size ${n} exists already`);
    const sizes = [...table.sizes];
    sizes.splice(at == null ? sizes.length : Math.max(0, Math.min(at, sizes.length)), 0, n);
    return { ...table, sizes };
}
// Every grade's rules with size keys renamed by fn(size) -> size (null drops it).
function mapRuleSizes(grades, fn) {
    const out = {};
    for (const [id, g] of Object.entries(grades)) {
        const rules = {};
        for (const [v, bySize] of Object.entries(g.rules ?? {})) {
            const r = {};
            for (const [s, d] of Object.entries(bySize)) { const k = fn(s); if (k != null) r[k] = d; }
            if (Object.keys(r).length) rules[v] = r;
        }
        out[id] = { ...g, rules };
    }
    return out;
}
// Size `from` renamed `to`: in the table (base and current with it) and in every rule.
// grades: {id: grade}. -> {table, grades}
export function renameSize(table, grades, from, to) {
    const n = checkName(to);
    if (!table?.sizes.includes(from)) throw new Error(`no size ${from}`);
    if (n !== from && table.sizes.includes(n)) throw new Error(`size ${n} exists already`);
    const r = (s) => (s === from ? n : s);
    return { table: { sizes: table.sizes.map(r), base: r(table.base), current: r(table.current) }, grades: mapRuleSizes(grades, r) };
}
// Size `name` removed with its rules. The base cannot go (choose another base first); the current
// size, if removed, becomes the base (the caller grades the outlines back). -> {table, grades}
export function removeSize(table, grades, name) {
    if (!table?.sizes.includes(name)) throw new Error(`no size ${name}`);
    if (name === table.base) throw new Error(`size ${name} is the base: choose another base first`);
    return {
        table: { sizes: table.sizes.filter((s) => s !== name), base: table.base, current: table.current === name ? table.base : table.current },
        grades: mapRuleSizes(grades, (s) => (s === name ? null : s)),
    };
}
// The sizes in a new order (the same names).
export function reorderSizes(table, sizes) {
    if (!table) throw new Error("no size table");
    if (sizes.length !== table.sizes.length || !table.sizes.every((s) => sizes.includes(s))) throw new Error("reorder: the same sizes, in a new order");
    return { ...table, sizes: [...sizes] };
}
// The base changed to `name`: every rule re-expressed against it (rule' = rule - rule(name)) and
// each base path that size's outline. -> {table, grades}
export function changeBase(table, grades, name) {
    if (!table?.sizes.includes(name)) throw new Error(`no size ${name}`);
    const out = {};
    for (const [id, g] of Object.entries(grades)) {
        const rules = {};
        for (const [v, bySize] of Object.entries(g.rules ?? {})) {
            const at = bySize[name] ?? [0, 0], r = {};
            for (const s of table.sizes) {
                const d = bySize[s] ?? [0, 0], e = [d[0] - at[0], d[1] - at[1]];
                if (s !== name && !isZero(e)) r[s] = e;
            }
            if (Object.keys(r).length) rules[v] = r;
        }
        out[id] = { base: gradedPath(g.base, g.rules, name), rules };
    }
    return { table: { ...table, base: name }, grades: out };
}

// ---- rules on a path ----
// A closed path's vertices: the start, then each segment's end but the last (which is the start).
export const vertices = (path) => [path.start, ...path.segments.slice(0, -1).map(segEnd)].map((p) => [p[0], p[1]]);
// Rules without zero moves or empty vertices.
export function normalRules(rules) {
    const out = {};
    for (const [v, bySize] of Object.entries(rules ?? {})) {
        const r = {};
        for (const [s, d] of Object.entries(bySize)) if (!isZero(d)) r[s] = [d[0] + 0, d[1] + 0];
        if (Object.keys(r).length) out[v] = r;
    }
    return out;
}
export const ruleOf = (rules, i, size) => rules?.[i]?.[size] ?? [0, 0];
// Each of n vertices' move for `size`.
export const deltasOf = (rules, size, n) => Array.from({ length: n }, (_, i) => [...ruleOf(rules, i, size)]);
// `path` (closed) with vertex i moved by deltas[i]: a Bézier's handles with their own vertex, a
// conic's control and an arc's centre by the mean of their ends' moves, a NURBS span's inner
// control points by the moves of its ends interpolated along the span. Holes are kept.
export function movedPath(path, deltas) {
    const n = path.segments.length, d = (i) => deltas[((i % n) + n) % n] ?? [0, 0];
    const out = clone(path);
    out.start = add(path.start, d(0));
    out.segments = path.segments.map((s, j) => {
        const a = d(j), b = d(j + 1), c = clone(s), mid = mix(a, b, 0.5);
        if (c.to) c.to = add(c.to, b);
        if (c.type === "bezier") { c.c1 = add(c.c1, a); c.c2 = add(c.c2, b); }
        else if (c.type === "conic") c.control = add(c.control, mid);
        else if (c.type === "arc") c.centre = add(c.centre, mid);
        else if (c.type === "nurbs") { const k = c.points.length; c.points = c.points.map((p, i) => add(p, mix(a, b, (i + 1) / k))); }
        return c;
    });
    return out;
}
// The base path in `size`: each vertex moved by its rule, its handles with it.
export const gradedPath = (base, rules, size) => movedPath(base, deltasOf(rules, size, base.segments.length));
// Whether two paths have the same segments (count and types).
export const sameShape = (a, b) => !!a && !!b && a.segments.length === b.segments.length && a.segments.every((s, i) => s.type === b.segments[i].type);
// Whether two path JSONs agree to `tol` in every number (and in everything else exactly).
export function nearPath(a, b, tol = 1e-6) {
    if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= tol;
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => nearPath(v, b[i], tol));
    if (a && b && typeof a === "object" && typeof b === "object") {
        const ka = Object.keys(a).filter((k) => k !== "holes"), kb = Object.keys(b).filter((k) => k !== "holes");
        return ka.length === kb.length && ka.every((k) => nearPath(a[k], b[k], tol));
    }
    return a === b;
}
// The vertex moves that take `base` to `path` when `path` is base with each vertex moved and
// its handles with it (movedPath); null when it is not (a handle moved on its own, a point added).
export function vertexMoves(base, path, tol = 1e-6) {
    if (!sameShape(base, path)) return null;
    const vb = vertices(base), vp = vertices(path), deltas = vb.map((p, i) => [vp[i][0] - p[0], vp[i][1] - p[1]]);
    return nearPath(movedPath(base, deltas), path, tol) ? deltas : null;
}
// rules with size `size` set to deltas (one per vertex).
export function withSize(rules, size, deltas) {
    const out = clone(rules ?? {});
    deltas.forEach((d, i) => { out[i] = { ...(out[i] ?? {}), [size]: [d[0], d[1]] }; });
    return normalRules(out);
}
// Every rule through the 2x2 linear part of m6 (a piece turned or mirrored with its rules).
export function turnRules(rules, m6) {
    const out = {};
    for (const [v, bySize] of Object.entries(rules ?? {}))
        out[v] = Object.fromEntries(Object.entries(bySize).map(([s, [x, y]]) => [s, [m6[0] * x + m6[1] * y, m6[3] * x + m6[4] * y]]));
    return normalRules(out);
}

// ---- affine fits (row-major 2x3 m6: x' = m0 x + m1 y + m2, y' = m3 x + m4 y + m5) ----
export const IDENTITY = [1, 0, 0, 0, 1, 0];
export const applyAffine = (m6, [x, y]) => [m6[0] * x + m6[1] * y + m6[2], m6[3] * x + m6[4] * y + m6[5]];
// The least-squares 2D affine map taking points `from` to points `to` (as many each). Fewer than
// three points, or all on one line: the mean move alone.
export function affineFit(from, to) {
    const n = from.length;
    if (!n || n !== to.length) return [...IDENTITY];
    const mean = (ps) => ps.reduce((s, p) => [s[0] + p[0] / n, s[1] + p[1] / n], [0, 0]);
    const [mx, my] = mean(from), [ux, uy] = mean(to);
    let sxx = 0, sxy = 0, syy = 0, sxu = 0, syu = 0, sxv = 0, syv = 0;
    for (let i = 0; i < n; i++) {
        const x = from[i][0] - mx, y = from[i][1] - my, u = to[i][0] - ux, v = to[i][1] - uy;
        sxx += x * x; sxy += x * y; syy += y * y; sxu += x * u; syu += y * u; sxv += x * v; syv += y * v;
    }
    const det = sxx * syy - sxy * sxy, scale = (sxx + syy) ** 2;
    if (n < 3 || !(Math.abs(det) > 1e-12 * scale)) return [1, 0, ux - mx, 0, 1, uy - my];
    const a = (sxu * syy - syu * sxy) / det, b = (syu * sxx - sxu * sxy) / det;
    const d = (sxv * syy - syv * sxy) / det, e = (syv * sxx - sxv * sxy) / det;
    return [a, b, ux - a * mx - b * my, d, e, uy - d * mx - e * my];
}
// The largest distance between to[i] and m6(from[i]).
export const fitResidual = (m6, from, to) => from.reduce((r, p, i) => { const q = applyAffine(m6, p); return Math.max(r, Math.hypot(q[0] - to[i][0], q[1] - to[i][1])); }, 0);
export function invertAffine(m) {
    const det = m[0] * m[4] - m[1] * m[3];
    if (!(Math.abs(det) > 1e-12)) return null;
    const a = m[4] / det, b = -m[1] / det, d = -m[3] / det, e = m[0] / det;
    return [a, b, -(a * m[2] + b * m[5]), d, e, -(d * m[2] + e * m[5])];
}
// p -> outer(inner(p))
export const composeAffine = (outer, inner) => [
    outer[0] * inner[0] + outer[1] * inner[3], outer[0] * inner[1] + outer[1] * inner[4], outer[0] * inner[2] + outer[1] * inner[5] + outer[2],
    outer[3] * inner[0] + outer[4] * inner[3], outer[3] * inner[1] + outer[4] * inner[4], outer[3] * inner[2] + outer[4] * inner[5] + outer[5],
];
export const isIdentity = (m, tol = 1e-12) => m.every((v, i) => Math.abs(v - IDENTITY[i]) <= tol);
// Every control point of a path (vertices, handles, controls, centres, NURBS points), in order.
export function controlPoints(path) {
    const out = [[...path.start]];
    for (const s of path.segments) {
        if (s.type === "bezier") out.push(s.c1, s.c2);
        else if (s.type === "conic") out.push(s.control);
        else if (s.type === "arc") out.push(s.centre);
        if (s.points) out.push(...s.points); else out.push(s.to);
    }
    return out.map((p) => [p[0], p[1]]);
}
// The rigid motion (a turn and a move, or a mirror and a move) taking path `from` onto `to`,
// every control point, or null: a piece placed (moved, turned), not reshaped.
export function rigidMotion(from, to, tol = 1e-6) {
    if (!sameShape(from, to)) return null;
    const a = controlPoints(from), b = controlPoints(to);
    if (a.length < 2) return null;
    const m6 = a.length >= 3 ? affineFit(a, b) : [1, 0, b[0][0] - a[0][0], 0, 1, b[0][1] - a[0][1]];
    if (fitResidual(m6, a, b) > tol) return null;
    const [p, q, , r, s] = m6;
    const ortho = Math.abs(p * p + r * r - 1) < 1e-9 && Math.abs(q * q + s * s - 1) < 1e-9 && Math.abs(p * q + r * s) < 1e-9;
    return ortho ? m6 : null;
}

// ---- shortcuts ----
// Distribute: the vertices strictly between `from` and `to` (forward along the outline) get
// rules interpolated by arc length between theirs, for every size in `sizes`. `arcs`: each
// vertex's arc length along the base outline, and the perimeter last (n + 1 numbers).
export function distribute(rules, from, to, arcs, sizes) {
    const n = arcs.length - 1, P = arcs[n], fwd = (x) => ((x % P) + P) % P;
    if (from === to) throw new Error("distribute: two different points");
    const span = fwd(arcs[to] - arcs[from]) || P;
    const out = clone(rules ?? {});
    for (let k = (from + 1) % n; k !== to; k = (k + 1) % n) {
        const t = fwd(arcs[k] - arcs[from]) / span, r = {};
        for (const s of sizes) r[s] = mix(ruleOf(rules, from, s), ruleOf(rules, to, s), t);
        out[k] = r;
    }
    return normalRules(out);
}
// Proportional: a width change `dw` and height change `dh` per size step from the base. Each
// vertex moves by its place relative to the bounds centre (a vertex on the right edge by dw / 2
// a step), scaled by the size steps from the base. `bounds` [x0, y0, x1, y1] (the vertices' by default).
export function proportional(path, sizes, base, dw, dh, bounds = null) {
    const vs = vertices(path);
    const [x0, y0, x1, y1] = bounds ?? [Math.min(...vs.map((p) => p[0])), Math.min(...vs.map((p) => p[1])), Math.max(...vs.map((p) => p[0])), Math.max(...vs.map((p) => p[1]))];
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, w = x1 - x0, h = y1 - y0, b = sizes.indexOf(base);
    if (b < 0) throw new Error(`no size ${base}`);
    const rules = {};
    vs.forEach(([x, y], i) => {
        const fx = w > 0 ? (x - cx) / w : 0, fy = h > 0 ? (y - cy) / h : 0;
        rules[i] = Object.fromEntries(sizes.map((s, k) => [s, [dw * fx * (k - b), dh * fy * (k - b)]]));
    });
    return normalRules(rules);
}

// ---- index shift ----
// After a point is inserted at vertex index `at` (delta +1), or vertex `at` removed (delta -1):
// the rules re-indexed. An inserted point takes `copy`'s rule (a vertex index before the shift),
// or with `t` the rule between its neighbours (old `at - 1` and old `at`, `n` the old count)
// interpolated at t; else none.
export function shiftRules(rules, at, delta, { t = null, n = null, copy = null } = {}) {
    const out = {};
    for (const [v, r] of Object.entries(rules ?? {})) {
        const i = Number(v);
        if (delta > 0) out[i >= at ? i + 1 : i] = r;
        else if (i !== at) out[i > at ? i - 1 : i] = r;
    }
    if (delta > 0) {
        if (copy != null && rules?.[copy]) out[at] = clone(rules[copy]);
        else if (t != null && n) {
            const a = rules?.[(at - 1 + n) % n] ?? {}, b = rules?.[at % n] ?? {}, r = {};
            for (const s of new Set([...Object.keys(a), ...Object.keys(b)])) r[s] = mix(a[s] ?? [0, 0], b[s] ?? [0, 0], t);
            out[at] = r;
        }
    }
    return normalRules(out);
}
// Rules carried from path `from` onto path `to` (a point more or fewer: a rebuilt partner or
// unfolded whole) by position: a vertex of `to` on one of `from` takes its rule; a new one between
// two kept ones takes the rule of the nearest dropped vertex between them (a rounded corner), or
// else theirs interpolated by distance (a point added on a side).
export function carryRules(rules, from, to, tol = 1e-6) {
    const vf = vertices(from), vt = vertices(to), nf = vf.length, nt = vt.length;
    const match = vt.map((p) => { const k = vf.findIndex((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= tol); return k < 0 ? null : k; });
    const out = {};
    match.forEach((k, i) => { if (k != null && rules?.[k]) out[i] = clone(rules[k]); });
    if (!match.some((k) => k != null)) return normalRules(out);
    const used = new Set(match.filter((k) => k != null));
    for (let i = 0; i < nt; i++) {
        if (match[i] != null) continue;
        let a = i, b = i;
        do a = (a - 1 + nt) % nt; while (match[a] == null);
        do b = (b + 1) % nt; while (match[b] == null);
        const dropped = [];
        for (let k = (match[a] + 1) % nf; k !== match[b] && k !== match[a]; k = (k + 1) % nf) if (!used.has(k)) dropped.push(k);
        const p = vt[i];
        if (dropped.length) {
            const k = dropped.reduce((best, j) => (Math.hypot(vf[j][0] - p[0], vf[j][1] - p[1]) < Math.hypot(vf[best][0] - p[0], vf[best][1] - p[1]) ? j : best));
            if (rules?.[k]) out[i] = clone(rules[k]);
            continue;
        }
        const da = Math.hypot(p[0] - vt[a][0], p[1] - vt[a][1]), db = Math.hypot(p[0] - vt[b][0], p[1] - vt[b][1]);
        const t = da + db > 0 ? da / (da + db) : 0, ra = rules?.[match[a]] ?? {}, rb = rules?.[match[b]] ?? {}, r = {};
        for (const s of new Set([...Object.keys(ra), ...Object.keys(rb)])) r[s] = mix(ra[s] ?? [0, 0], rb[s] ?? [0, 0], t);
        out[i] = r;
    }
    return normalRules(out);
}

// ---- notches ----
// Notches re-placed at the same fraction of their side: `from`/`to` each side's start arc
// length and the perimeter last (as many sides on each).
export function notchesByFraction(notches, from, to) {
    const n = from.length - 1;
    return (notches ?? []).map((nt) => {
        let k = 0;
        for (let i = 0; i < n; i++) if (from[i] <= nt.at + 1e-9) k = i;
        const len = from[k + 1] - from[k], t = len > 0 ? Math.min(1, Math.max(0, (nt.at - from[k]) / len)) : 0;
        return { ...nt, at: to[k] + t * (to[k + 1] - to[k]) };
    });
}

// ---- a cut's pieces ----
// The rules of a new outline's vertices, each placed on the graded outline `base` (with `rules`):
// {vertex: k} on its vertex k takes its rule; {side: k, t} at arc fraction t along its side k
// (vertex k to k + 1) the two ends' rules interpolated at t; {point: [x, y]} inside the piece
// (a cutter's bend) the move of the affine fit of the piece's vertices in each size. -> rules
export function rulesAtPlaces(rules, base, places) {
    const vb = vertices(base), n = vb.length, sizes = [...new Set(Object.values(rules ?? {}).flatMap((r) => Object.keys(r)))];
    const fits = new Map();
    const fit = (s) => { if (!fits.has(s)) fits.set(s, affineFit(vb, vertices(gradedPath(base, rules, s)))); return fits.get(s); };
    const out = {};
    places.forEach((pl, i) => {
        const r = {};
        for (const s of sizes) {
            if (pl.vertex != null) r[s] = [...ruleOf(rules, pl.vertex, s)];
            else if (pl.side != null) r[s] = mix(ruleOf(rules, pl.side, s), ruleOf(rules, (pl.side + 1) % n, s), pl.t);
            else { const q = applyAffine(fit(s), pl.point); r[s] = [q[0] - pl.point[0], q[1] - pl.point[1]]; }
        }
        out[i] = r;
    });
    return normalRules(out);
}
