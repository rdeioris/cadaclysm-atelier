// The fit map: the cloth coloured by its strain or stress (the kernel's cloth_strain maps), the
// legend over the 3D window's corner and the value under the pointer. The page keeps the state
// (FitMap) and the legend; the View's worker hands the map to the engine: the GPU cloth draws it
// itself (View.setClothMap, gpu-drape.js), the CPU cloth worker sends cloth_strain_colours with
// its frames, at most every MAP_EVERY_MS, and the pattern meshes are re-shown with them
// (recolourMeshes). The colours are the kernel's on both engines, byte for byte.
// No View and no DOM at the top level: the worker imports it too.
import { gather, nearestVertex } from "./drape.js";

// The maps, as the 3D strip's select lists them. `code` is cloth_strain's map number, `key`
// setClothMap's name. Strains are fractions, shown in % (x 100); stress is in the solver's
// g/s^2 (= mN/m), shown in N/m (/ 1000).
export const MAPS = [
    { key: "off", label: "Off" },
    { key: "strain", code: 1, label: "Strain", unit: "%" },
    { key: "weft", code: 2, label: "Weft", unit: "%" },
    { key: "warp", code: 3, label: "Warp", unit: "%" },
    { key: "bias", code: 4, label: "Bias", unit: "%" },
    { key: "stress", code: 5, label: "Stress", unit: "N/m" },
];
export const mapOf = (key) => MAPS.find((m) => m.key === key) ?? MAPS[0];
// The kernel's ramp (spec "Colour"): five stops, blue at the minimum to red at the maximum.
export const RAMP = ["#0000ff", "#00ffff", "#00ff00", "#ffff00", "#ff0000"];
export const legendGradient = () => `linear-gradient(to right, ${RAMP.join(", ")})`;
// The CPU engine's colours: at most one set every this many ms (5 a second).
export const MAP_EVERY_MS = 200;
// Default ranges, in the kernel's units: 0-10 % strain; stress 0 to the largest stretch
// stiffness of the document's fabrics times 5 %.
export const STRAIN_MAX = 0.1, STRESS_AT = 0.05;

// A value in the kernel's units as the legend shows it, and back.
export const toShown = (key, v) => (key === "stress" ? v / 1000 : v * 100);
export const fromShown = (key, v) => (key === "stress" ? v * 1000 : v / 100);

// The default [lo, hi] of map `key` for the document's `nodes` (kernel units).
export function defaultRange(key, nodes = []) {
    if (key !== "stress") return [0, STRAIN_MAX];
    let k = 0;
    for (const n of nodes) if (n.kind === "garment.fabric") k = Math.max(k, Number(n.stretch_warp) || 0, Number(n.stretch_weft) || 0);
    return [0, (k > 0 ? k : 50000) * STRESS_AT];
}

// A shown number, rounded for the legend's inputs and the read-out.
export function shownText(key, v) {
    if (!Number.isFinite(v)) return "";
    const s = toShown(key, v);
    return String(Number(s.toFixed(Math.abs(s) >= 100 ? 0 : Math.abs(s) >= 10 ? 1 : 2)));
}
// The read-out under the pointer: "Strain 4.25 %"; NaN (a vertex with no live triangle) says so.
export function valueText(key, v) {
    const m = mapOf(key);
    if (m.key === "off") return "";
    return Number.isFinite(v) ? `${m.label} ${shownText(key, v)} ${m.unit}` : `${m.label}: no value here`;
}

// The page's map state: the map and its range (kernel units), what goes to the worker.
export class FitMap {
    constructor() { this.key = "off"; this.lo = 0; this.hi = STRAIN_MAX; }
    get on() { return this.key !== "off"; }
    get map() { return mapOf(this.key); }
    // A new map takes its default range.
    set(key, nodes) {
        this.key = mapOf(key).key;
        [this.lo, this.hi] = defaultRange(this.key, nodes);
        return this.message();
    }
    // The range typed in the legend (shown units): -> the message, or { error }.
    setRange(loText, hiText) {
        const lo = Number(String(loText).trim()), hi = Number(String(hiText).trim());
        if (String(loText).trim() === "" || String(hiText).trim() === "" || !Number.isFinite(lo) || !Number.isFinite(hi)) return { error: "the map's minimum and maximum are numbers" };
        if (lo >= hi) return { error: "the map's minimum is below its maximum" };
        this.lo = fromShown(this.key, lo); this.hi = fromShown(this.key, hi);
        return this.message();
    }
    // The worker's `fitmap` message: { map: null } or { map: { key, code, min, max } }.
    message() { return { kind: "fitmap", map: this.on ? { key: this.key, code: this.map.code, min: this.lo, max: this.hi } : null }; }
    // The legend's content: title, unit, the range as shown.
    legend() { const m = this.map; return { on: this.on, title: m.label, unit: m.unit ?? "", lo: shownText(this.key, this.lo), hi: shownText(this.key, this.hi), gradient: legendGradient() }; }
}

// One request in flight, the newest waiting, older ones dropped (the View's pick rule: keep
// one pick in flight, latest wins). `send(x)` starts one; call `done()` when it is answered.
export class Latest {
    constructor(send) { this.send = send; this.busy = false; this.next = null; }
    push(x) { this.next = x; if (!this.busy) this.flush(); }
    flush() {
        const x = this.next;
        this.next = null;
        if (x == null) return;
        this.busy = true;
        this.send(x);
    }
    done() { this.busy = false; this.flush(); }
    drop() { this.next = null; }
}

// A value read once per hover burst: kept while hovers come closer than `gapMs` apart, read
// afresh after a pause or when its `key` changes (the GPU cloth's positions and their map).
export class BurstCache {
    constructor(gapMs = 300) { this.gapMs = gapMs; this.key = null; this.at = -Infinity; this.value = null; }
    get(key, now, read) {
        if (this.value === null || key !== this.key || now - this.at > this.gapMs) { this.key = key; this.value = read(); }
        this.at = now;
        return this.value;
    }
    clear() { this.value = null; }
}

// ---- the View's worker -------------------------------------------------------------------------
// The value under a picked point: the nearest sim vertex's (among `verts`, a CPU pattern
// mesh's, or every vertex of the GPU cloth). NaN when there is none.
export function valueAt(values, positions, point, verts = null) {
    if (!values || !positions || !point) return NaN;
    const v = nearestVertex(positions, point, verts);
    return v >= 0 ? values[v] : NaN;
}

// The CPU cloth's pattern meshes re-shown with the map's colours (`colours`: three a sim
// vertex, or null for each piece's fabric colour): each mesh gets a new item; `onItem(old,
// next, mesh)` keeps the item map for picks.
export function recolourMeshes(viewer, meshes, colours, onItem) {
    for (const m of meshes) {
        if (m.gpu || !m.indices) continue;
        const old = m.item;
        const shown = colours ? { colours: gather(colours, m.verts) } : { colour: m.colour };
        m.item = viewer.showMesh({ positions: m.buf, indices: m.indices, ...shown });
        viewer.remove(old);
        onItem?.(old, m.item, m);
    }
}

// ---- the legend (the page) ---------------------------------------------------------------------
// Fills the legend element from FitMap.legend(): the gradient, the two inputs and the unit.
export function renderLegend(el, legend) {
    el.hidden = !legend.on;
    if (!legend.on) return;
    el.querySelector(".map-title").textContent = legend.title;
    el.querySelector(".map-bar").style.background = legend.gradient;
    for (const u of el.querySelectorAll(".map-unit")) u.textContent = legend.unit;
    const lo = el.querySelector(".map-lo"), hi = el.querySelector(".map-hi");
    if (el.ownerDocument?.activeElement !== lo) lo.value = legend.lo;
    if (el.ownerDocument?.activeElement !== hi) hi.value = legend.hi;
}
