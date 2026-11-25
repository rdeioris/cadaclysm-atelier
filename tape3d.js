// The Tape tool in the 3D window: a tape laid on the avatar or the garment, measured by the
// kernel (cloth_tape_path, cloth_tape_girth). Two modes:
//   Path:  clicks place points; the tape follows the surface between them; a double click or
//          Enter ends it, Escape drops it.
//   Girth: one click draws the horizontal loop through the point: on the avatar a real tape's
//          (the loop's convex hull, over the hollows), on the garment the actual loop. The Hull
//          box switches between the two, remembered for each (on for the avatar, off for the
//          garment), and re-measures the last girth.
// The page keeps the tool's state (TapeTool: clicks in, `tape` messages out); the View's worker
// measures and draws (TapeMeasures): one lines item on top and a label per measure, kept until
// Clear. Lengths are in mm, shown in cm with one decimal. No View and no DOM at the top level.

// A horizontal loop: the plane's normal is the world's up (the forms are y up).
export const UP = [0, 1, 0];
export const TAPE_COLOUR = "#ffb347";             // arrange.js ACCENT
const DOUBLE_MS = 400, DOUBLE_PX = 4;             // a double click: two clicks this close

// The length of a polyline of xyz triples; `closed` adds the side back to the first.
export function tapeLength(points, closed = false) {
    const n = Math.floor(points.length / 3);
    let s = 0;
    for (let i = 1; i < n + (closed && n > 2 ? 1 : 0); i++) {
        const a = 3 * (i - 1), b = 3 * (i % n);
        s += Math.hypot(points[b] - points[a], points[b + 1] - points[a + 1], points[b + 2] - points[a + 2]);
    }
    return s;
}
export const cmText = (mm) => `${(mm / 10).toFixed(1)} cm`;

// The polyline as showLines' segments (six numbers a side).
export function segmentsOf(points, closed = false) {
    const n = Math.floor(points.length / 3), sides = closed && n > 2 ? n : n - 1;
    const out = new Float64Array(Math.max(sides, 0) * 6);
    for (let i = 0; i < sides; i++) {
        const a = 3 * i, b = 3 * ((i + 1) % n);
        out.set([points[a], points[a + 1], points[a + 2], points[b], points[b + 1], points[b + 2]], 6 * i);
    }
    return out;
}

// Where a measure's label goes: a path's halfway point along it, a girth's point nearest the click.
export function labelPoint(points, closed, near = null) {
    const n = Math.floor(points.length / 3);
    if (!n) return [0, 0, 0];
    const at = (i) => [points[3 * i], points[3 * i + 1], points[3 * i + 2]];
    if (closed && near) {
        let best = 0, bd = Infinity;
        for (let i = 0; i < n; i++) { const d = Math.hypot(points[3 * i] - near[0], points[3 * i + 1] - near[1], points[3 * i + 2] - near[2]); if (d < bd) { bd = d; best = i; } }
        return at(best);
    }
    const half = tapeLength(points, false) / 2;
    let s = 0;
    for (let i = 1; i < n; i++) {
        const a = at(i - 1), b = at(i), d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        if (s + d >= half && d > 0) { const f = (half - s) / d; return [0, 1, 2].map((k) => a[k] + (b[k] - a[k]) * f); }
        s += d;
    }
    return at(n - 1);
}

// ---- the page: the tool's state ----------------------------------------------------------------
export class TapeTool {
    constructor() {
        this.on = false;
        this.mode = "path";                          // "path" | "girth"
        this.hull = { avatar: true, cloth: false };  // the Hull box, per target
        this.target = "avatar";                      // the Hull box shows this target's choice
        this.current = null;                         // the path being drawn: { id, target, points }
        this.lastGirth = null;                       // { id, target, point }: the Hull box re-measures it
        this.ids = [];                               // the measures kept
        this.nextId = 0;
        this.lastClick = null;                       // { t, xy }: a double click ends a path
    }
    get hullOn() { return this.hull[this.target]; }
    // A press without a drag in the 3D window (`t` ms, `xy` CSS px): "end" for the second click
    // of a double click on a path being drawn (no new point), else "pick".
    press(t, xy) {
        const last = this.lastClick;
        this.lastClick = { t, xy };
        const double = last && t - last.t < DOUBLE_MS && Math.hypot(xy[0] - last.xy[0], xy[1] - last.xy[1]) < DOUBLE_PX;
        if (double) this.lastClick = null;
        return double && this.mode === "path" && this.current ? "end" : "pick";
    }
    // The pick's answer: `target` "avatar" | "cloth" | null, `point` xyz.
    // -> { post: [messages], status, error }
    click(target, point) {
        if (!target || !point) return { post: [], status: "Tape: click the avatar or the garment", error: true };
        if (this.mode === "girth") {
            const id = ++this.nextId;
            this.target = target;
            this.lastGirth = { id, target, point };
            this.ids.push(id);
            return { post: [{ kind: "tape", op: "girth", id, target, point, hull: this.hull[target] }], status: `girth on the ${target === "avatar" ? "avatar" : "garment"}${this.hull[target] ? " (hull)" : ""}` };
        }
        if (this.current && this.current.target !== target) return { post: [], status: `Tape: this path is on the ${this.current.target === "avatar" ? "avatar" : "garment"}; Enter ends it`, error: true };
        if (!this.current) {
            this.current = { id: ++this.nextId, target, points: [point] };
            return { post: [], status: "Tape: click the next point; double click or Enter ends it, Escape drops it", error: false };
        }
        this.current.points.push(point);
        return { post: [{ kind: "tape", op: "path", id: this.current.id, target, points: this.current.points.flat() }], status: "", error: false };
    }
    // Enter or a double click: the path is kept (a single point is dropped).
    end() {
        const c = this.current;
        this.current = null;
        if (!c) return { post: [] };
        if (c.points.length < 2) return { post: [] };
        this.ids.push(c.id);
        return { post: [], status: "tape kept: Clear removes the measures" };
    }
    // Escape: the path being drawn goes.
    escape() {
        const c = this.current;
        this.current = null;
        return c ? { post: [{ kind: "tape", op: "remove", id: c.id }], status: "tape dropped" } : null;
    }
    clear() {
        this.current = null; this.lastGirth = null; this.ids = [];
        return { post: [{ kind: "tape", op: "clear" }], status: "measures cleared" };
    }
    // The Hull box: the choice for the last girth's target, that girth measured again with it.
    setHull(on) {
        this.hull[this.target] = !!on;
        const g = this.lastGirth;
        return { post: g && g.target === this.target ? [{ kind: "tape", op: "girth", id: g.id, target: g.target, point: g.point, hull: !!on }] : [] };
    }
    setMode(mode) {
        const out = this.current ? this.end() : { post: [] };
        this.mode = mode === "girth" ? "girth" : "path";
        return out;
    }
    toggle() {
        this.on = !this.on;
        if (!this.on && this.current) return this.end();
        return { post: [] };
    }
}

// ---- the View's worker: measuring and drawing ----------------------------------------------------
export class TapeMeasures {
    // `viewer` the View, `k` the kernel module.
    constructor(viewer, k) {
        this.viewer = viewer;
        this.k = k;
        this.shown = new Map();                       // id -> { lines, label, length }
    }
    // The items a pick may land on (the tape itself, not a surface).
    owns(item) { for (const s of this.shown.values()) if (s.lines === item || s.label === item) return true; return false; }
    // -> the loop's points (xyz triples)
    girth(mesh, point, hull) {
        return this.k.cadaclysm_blacksmith_cloth_tape_girth(Float64Array.from(mesh.positions), Uint32Array.from(mesh.indices), Float64Array.from(point), Float64Array.from(UP), !!hull);
    }
    path(mesh, points) {
        return this.k.cadaclysm_blacksmith_cloth_tape_path(Float64Array.from(mesh.positions), Uint32Array.from(mesh.indices), Float64Array.from(points), false);
    }
    // Measure `op` ("path" | "girth") on `mesh` ({ positions, indices }) and draw it as `id`
    // (replacing what `id` drew). -> its length, mm.
    measure(data, mesh) {
        const closed = data.op === "girth";
        const pts = closed ? this.girth(mesh, data.point, data.hull) : this.path(mesh, data.points);
        const length = tapeLength(pts, closed);
        this.draw(data.id, pts, closed, length, closed ? data.point : null);
        return length;
    }
    draw(id, pts, closed, length, near) {
        this.remove(id);
        const v = this.viewer;
        const lines = v.showLines(segmentsOf(pts, closed), TAPE_COLOUR);
        v.setOnTop?.(lines, true);
        const label = v.showText(cmText(length), { at: labelPoint(pts, closed, near), size: 13, colour: "#1b1d21", box: TAPE_COLOUR, padding: 3, align: "bottom", offset: [0, -8], onTop: true });
        this.shown.set(id, { lines, label, length });
    }
    remove(id) {
        const s = this.shown.get(id);
        if (!s) return;
        this.viewer.remove(s.lines);
        this.viewer.remove(s.label);
        this.shown.delete(id);
    }
    clear() { for (const id of [...this.shown.keys()]) this.remove(id); }
}
