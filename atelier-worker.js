// The Atelier worker: it owns the cadaclysm wasm module, one Atelier (the garment document)
// and the View on the page's 3D canvas. The main thread sends edits; every change answers with
// `doc` and redraws the 3D window. No geometry is checked here: the kernel does that.
//
// The live drape: the solver runs in the cloth worker (cloth-worker.js), reached over the
// MessagePort the page hands this worker (`clothPort`). This worker builds it from the saved
// document, sends it every later change (it re-meshes or goes stale), and draws its frames: one
// mesh per pattern, moved in place by setMeshPositions as each frame arrives. The View keeps
// drawing and orbiting at the display rate however slowly the cloth steps.
// On a WebGPU View (and no ?cloth=cpu) clothPort is gpu-drape.js's host instead: the cloth
// steps on this View's GPU, drawn as one item the host shows; no positions come per frame.
import { load, open, version, licenseInfo, View } from "./pkg/index.js";
import { receiveControls } from "./pkg/view.js";
import * as k from "./pkg/index.js";
import { Atelier, forPage, linkOf } from "./kernel.js";
import { drawFrame, frame12, showSeams, isSelected, ItemMap, fabricColours, ACCENT, sceneBox, WrappedMeshCache, atSlot, slotFields, nearestTriangle } from "./arrange.js";
import { reslotOps } from "./reslot.js";
import { GIZMO_LAYER, GIZMO_COLOURS, GIZMO_HOVER, PARTS, gizmoPivot, gizmoSize, gizmoShapes, gizmoDrag, gizmoOps, ringHandle, RING } from "./gizmo.js";
import { setPattern } from "./model.js";
import { splitByPattern, gather, nearestVertex, dragBasis, dragTarget, avatarMesh, healthOf, RateMeter } from "./drape.js";
import { specs2d, Items2d, Overlay2d, LAYER_2D } from "./scene2d.js";
import { unionBounds, boxPiece, mmPerPx } from "./view2d.js";
import { Pointer2d } from "./pointer2d.js";
import { GpuDrapeHost, gpuClothOk } from "./gpu-drape.js";
import { filmCommand } from "./film.js";
import { valueAt, recolourMeshes, BurstCache } from "./fitmap.js";
import { TapeMeasures } from "./tape3d.js";
import { concatParts, positionsBox, specKey } from "./dressform.js";

const ready = (async () => {
    const module = await load();
    try {
        const r = await fetch(new URL("./cadaclysm.lic", import.meta.url));
        if (r.ok) module.license(await r.text());
    } catch { /* no licence beside the page: notices go to the console */ }
    return module;
})();

// `started` resolves once the viewer, the kernel and the Atelier all exist; every message
// but `canvas` waits on it.
let startedResolve, startedReject;
const started = new Promise((resolve, reject) => { startedResolve = resolve; startedReject = reject; });
started.catch(() => {});
let viewer = null;
let atelier = null;
let avatar = null;                       // { id, bounds, name, landmarks, dispose, formKey }
let forms = [];                          // assets/forms.json: the dress forms and their landmarks
let formAsk = 0;                         // bumped by every Form pick: a pick overtaken while it fetched is dropped
let drawn = [];                          // View item ids of the slabs and seam lines
let selection = null;
const items = new ItemMap();
const slabs = new Map();                 // pattern id -> { item, colour }
const seamLines = new Map();             // seam id -> { item, colour }
const slabBoxes = new Map();             // pattern id -> its slab's world box [x0, y0, z0, x1, y1, z1]
const wrappedMeshes = new WrappedMeshCache();   // a wrapped piece's mesh, kept while its drawing, frame and wrap stay
let canvasRef = null;                    // the OffscreenCanvas: its height is the drag's pixel scale
let items2d = null, overlay2d = null, rects = null, hover2d = null, pointSel = [], ipointSel = [];
let tool2d = "edit";           // the page's 2D tool: Move ("transform") draws its box and handles

// ---- the live drape ---------------------------------------------------------------------------
const PIN_COLOUR = "#ff4d6d";
let clothPort = null;
// "gpu": the cloth steps on this View (gpu-drape.js's host is clothPort); "cpu": cloth-worker.js
let clothEngine = "cpu";
let avatarCollider = null;               // the avatar as the cloth's mesh, sent at every build
let lastSaved = null;                    // the committed document's text, kept outside previews
const sim = {
    live: false, running: false, building: false, stale: null,
    meshes: [],                          // { item, id (pattern), verts, buf, colour }
    positions: null, pins: null, pinsItem: 0,
    status: null, phase: "", health: null,
    rate: new RateMeter(),
    meshGen: 0,                          // bumped by every new mesh (a build, a re-mesh)
    film: false,                         // ?film=1: Simulate builds paused, the driver steps it
    lastMs: null,                        // the last reported frame's step time
    stops: 0,                            // how many times the cloth has said it stopped
    drawn: null,                         // film: the View's framesDrawn after it drew the last stop
};
let dragging = null;                     // { vertex, start, x, y, basis } while a cloth drag is on
let fitmap = null;                       // the fit map ({key, code, min, max}) the engines draw, or null
const mapCache = new BurstCache();       // the GPU cloth's map values, read once per hover burst
let tapes = null;                        // the Tape tool's measures (tape3d.js)

async function createViewer(canvas) {
    await ready;
    // the dress forms are in CLO's frame: millimetres, y up, facing +z. A fixed extent makes
    // the grid the world's floor (4 m square about the origin, at y = 0): without one the View
    // sizes and places it from the scene's bounds, and the live cloth moves those every frame.
    const v = await View.create(canvas, { upAxis: "y", background: "#1e2024", grid: { step: 100, extent: 2000 } });
    if (typeof v.pickRect !== "function" || typeof v.setSnapBase !== "function")
        throw new Error("Atelier needs the View's picking and snapping (view 1.30, cadaclysm 0.16 or a master build): npm run setup -- --pkg <folder>");
    receiveControls(v);
    v.start();
    return v;
}

const post = (msg) => self.postMessage(msg);
const doc = () => ({ nodes: atelier.nodes(), drawings: atelier.drawings().map(forPage), seams: atelier.seams(), issues: atelier.issues() });

const selected = (kind, id) => isSelected(selection, kind, id);

// The 3D camera framed on the avatar and the garment's slabs (layer 0): the union of their
// boxes, never frame()/frameAll() of everything, which would take in the pattern pieces on
// layer 1 (plan ruling 6). The avatar alone, while there are no pieces, is framed as its item.
// frameSphere fits an orbit camera to the cube about the sphere, with its own margin: half the
// box's half-diagonal as the radius frames the avatar as frame(avatar) does.
const ORBIT_FIT = 0.5;
function frame3d() {
    const boxes = [...slabBoxes.values()];
    if (avatar && !boxes.length && viewer.frame(avatar.id, undefined, 0)) return;
    let b = avatar?.bounds ?? (boxes.length ? null : [-200, 0, -150, 200, 1700, 150]);
    for (const s of boxes) b = b ? [0, 1, 2].map((k) => Math.min(b[k], s[k])).concat([3, 4, 5].map((k) => Math.max(b[k], s[k]))) : s;
    const half = Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) / 2;
    viewer.frameSphere(0, [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2], ORBIT_FIT * half);
}
// A slab's world box: the drawing's 2D bounds through its frame.
function slabBox(bounds, frame) {
    const f = frame12(frame), out = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const [x, y] of [[bounds[0], bounds[1]], [bounds[2], bounds[1]], [bounds[0], bounds[3]], [bounds[2], bounds[3]]])
        for (let k = 0; k < 3; k++) { const v = f[k] + x * f[3 + k] + y * f[6 + k]; out[k] = Math.min(out[k], v); out[3 + k] = Math.max(out[3 + k], v); }
    return out;
}

// A mesh's world box (its xyz positions).
function meshBox(p) {
    const out = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = 0; i + 2 < p.length; i += 3) for (let k = 0; k < 3; k++) { out[k] = Math.min(out[k], p[i + k]); out[3 + k] = Math.max(out[3 + k], p[i + k]); }
    return out;
}

// The two windows: viewport 0 the orbit camera on layer 0 (the avatar, slabs, seams, cloth),
// viewport 1 an orthographic camera on the pattern plane z = 0 on layer 1. The first rects set
// them; later ones (the divider, F2/F3, a resize) only move them.
function setRects(r) {
    const first = !rects;
    rects = r;
    if (!first) { viewer.setViewportRects(r); return; }
    viewer.setViewports([
        { rect: r[0], camera: { kind: "orbit" }, grid: "front", layerMask: (1 << 0) | (1 << GIZMO_LAYER) },
        { rect: r[1], camera: { kind: "ortho", basis: "top", centre: [400, 300, 0], radius: 500 }, grid: "top", layerMask: 1 << LAYER_2D },
    ]);
    viewer.setViewportLabel(0, "3D", {});
    viewer.setViewportLabel(1, "2D", {});
    viewer.setWorkPlane({ origin: [0, 0, 0], xAxis: [1, 0, 0], normal: [0, 0, 1], step: 10 });
    items2d = new Items2d(viewer);
    overlay2d = new Overlay2d(viewer);
    frame3d();
    refresh2d();
    fit2d();
    if (gizmo) postGizmo();
}

function refresh2d() {
    if (!viewer || !atelier || !items2d) return;
    const nodes = atelier.nodes();
    const r = viewer.frameReport?.()[1], scale = r && r.rect[2] > 0 ? mmPerPx(r) : null;
    items2d.apply(specs2d({ drawings: atelier.drawings(), seams: atelier.seams(), nodes, selection, pointSel, ipointSel, hover: hover2d, colours: fabricColours(nodes), xform: tool2d === "transform", mmPerPx: scale }));
    post({ kind: "scene2d", items: items2d.byKey.size, hover: hover2d });
}

function fit2d() {
    const b = unionBounds(atelier.drawings()) ?? [-100, -100, 900, 900];
    viewer.frameSphere(1, [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2, 0], 0.55 * Math.hypot(b[2] - b[0], b[3] - b[1]) + 10);
}

// The 2D pointer events (pointer2d.js): the pick under each decoded through the item map, and
// the pattern point (snapped when the page asks and snapping is on), answered as `at2d` in order.
// A pick or snap the View never answers is given up after 2 s, so the chain always moves on.
const snapping = { on: false, grid: false };
// Snapping while a drawing tool is armed (spec §2), best first; the grid when the toggle is on.
const SNAP_KINDS = ["end", "vertex", "point", "midpoint", "intersection", "quadrant", "edge", "alignment"];
const pointers2d = new Pointer2d({
    viewer: () => viewer, items: () => items2d,
    drawings: () => new Map(atelier.drawings().map((d) => [d.id, d])),
    pieceAt: (at) => atelier.pieceAt(at),
    snapping: () => snapping.on,
    hovered: (id) => { if (id !== hover2d) { hover2d = id; refresh2d(); } },
    post,
});

// Box select over viewport 1 (device pixels local to it): the selected piece's points, or pieces.
// `what` is "points" or "pieces"; left to right a window, right to left a crossing box.
function boxSelect({ from, to, what }) {
    const [x, y] = from, w = to[0] - x, h = to[1] - y;
    const hits = viewer.pickRect(x, y, w, h, { viewport: 1, crossing: w < 0 });
    if (what === "points") {
        const item = selection?.kind === "pattern" ? items2d.item(`${selection.id}/points`) : 0;
        return { indices: item ? hits.filter((r) => r.item === item && r.kind === "point").map((r) => r.index) : [] };
    }
    const ids = new Set();
    for (const r of hits) { const id = boxPiece(items2d.what(r.item), w < 0); if (id) ids.add(id); }
    return { ids: [...ids] };
}

// Redraw the garment: a 1 mm slab per pattern at its frame (a wrapped one round its arm), each
// seam as its own lines item.
function refresh3d() {
    if (!viewer || !atelier) return;
    for (const id of drawn) viewer.remove(id);
    drawn = []; items.clear();
    if (avatar) items.set(avatar.id, { kind: "avatar", id: "avatar" });
    for (const m of sim.meshes) items.set(m.item, { kind: "pattern", id: m.id });
    const nodes = atelier.nodes();
    const colours = fabricColours(nodes);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const bounds = avatar?.bounds ?? [-200, 0, -150, 200, 1700, 150];
    const frames = new Map(), wraps = new Map();
    let first = null;
    slabs.clear(); seamLines.clear(); slabBoxes.clear();
    for (const d of atelier.drawings()) {
        const node = byId.get(d.id);
        const frame = drawFrame(node, bounds);
        frames.set(d.id, frame);
        // a wrapped piece (a sleeve, a cuff on it) is drawn round its arm, as the cloth starts:
        // its fill arranged through the wrap, not a flat slab at its frame
        if (node.wrap && frame === node.frame && d.fill) {
            wraps.set(d.id, node.wrap);
            try {
                const w = wrappedMeshes.get(d.id, d.sig, frame, node.wrap, d.fill);
                const colour = colours.get(node.fabric) ?? "#cccccc";
                const id = viewer.showMesh({ positions: w.positions, indices: w.indices, colour: selected("pattern", d.id) ? ACCENT : colour });
                drawn.push(id); items.set(id, { kind: "pattern", id: d.id });
                slabs.set(d.id, { item: id, colour });
                slabBoxes.set(d.id, meshBox(w.positions));
            } catch (e) { first ??= e; }
            continue;
        }
        if (d.bounds) slabBoxes.set(d.id, slabBox(d.bounds, frame));
        try {
            const solid = atelier.withOutline(d.id, (p) => k.cadaclysm_blacksmith_extrude(p, frame12(frame), 1));
            try {
                const id = viewer.showSolid(solid, {
                    tolerance: 0.5, colour: selected("pattern", d.id) ? ACCENT : colours.get(node.fabric) ?? "#cccccc",
                    opacity: 0.85, material: "matte",
                });
                drawn.push(id); items.set(id, { kind: "pattern", id: d.id });
                slabs.set(d.id, { item: id, colour: colours.get(node.fabric) ?? "#cccccc" });
            } finally { k.cadaclysm_blacksmith_solid_free(solid); }
        } catch (e) { first ??= e; }
    }
    wrappedMeshes.keep(new Set(wraps.keys()));
    const { shown, error } = showSeams(viewer, atelier.seams(), frames, selection, wraps);
    for (const s of shown) { drawn.push(s.item); items.set(s.item, { kind: "seam", id: s.id }); seamLines.set(s.id, s); }
    if (sim.meshes.length) flatVisible(false);
    drawGizmo();
    first ??= error;
    if (first) post({ kind: "error", text: String(first.message ?? first) });
}

// The selection's accent on the slabs already drawn.
function paintSelection() {
    for (const [id, s] of slabs) viewer.setColour(s.item, selected("pattern", id) ? ACCENT : s.colour);
    for (const [id, s] of seamLines) viewer.setColour(s.item, selected("seam", id) ? ACCENT : s.colour);
    for (const m of sim.meshes) if (!m.gpu && !sim.mapColours) viewer.setColour(m.item, selected("pattern", m.id) ? ACCENT : m.colour);
}

// The flat slabs and seam lines, shown while there is no cloth.
function flatVisible(on) {
    for (const s of slabs.values()) viewer.setItemVisible(s.item, on);
    for (const s of seamLines.values()) viewer.setItemVisible(s.item, on);
}

// The text and preview ops the cloth worker builds or updates from: the committed document,
// with the open preview's last good frame on top during a 2D drag.
function garmentNow() {
    if (!atelier.previewing || lastSaved === null) lastSaved = atelier.save();
    return { text: lastSaved, ops: atelier.previewing ? atelier.open.ops ?? null : null };
}

function simPost() {
    const r = sim.rate;
    // a film's cloth stands still between steps but is shown as running, as in a live run
    const running = sim.running || (sim.film && sim.live && !sim.stale && !sim.building);
    post({
        kind: "sim", live: sim.live, running, building: sim.building, stale: sim.stale,
        health: sim.health, phase: sim.phase, fps: r.fps, ms: r.ms, pins: sim.pins ? sim.pins.length / 3 : 0, meshGen: sim.meshGen,
        engine: clothEngine, frame: sim.status ? sim.status[0] : null, stepMs: sim.lastMs, stops: sim.stops, drawn: sim.drawn,
    });
}

function removeCloth() {
    for (const m of sim.meshes) { if (!m.gpu) viewer.remove(m.item); items.items.delete(m.item); }
    sim.meshes = [];
    if (sim.pinsItem) { viewer.remove(sim.pinsItem); sim.pinsItem = 0; }
    sim.positions = null; sim.pins = null; sim.health = null; sim.status = null; sim.lastMs = null;
    sim.mapColours = sim.mapValues = sim.triangles = null;
    dragging = null;
    flatVisible(true);
}

function showPins() {
    const pins = sim.pins ?? new Float32Array(0);
    if (!sim.pinsItem) {
        if (!pins.length) return;
        sim.pinsItem = viewer.showPoints(pins, PIN_COLOUR, 9);
        viewer.setOnTop?.(sim.pinsItem, true);
    } else viewer.setPoints(sim.pinsItem, pins);
}

// A new mesh from the cloth worker (a build or a re-mesh): one showMesh per pattern.
function onTopology(t) {
    for (const m of sim.meshes) { if (!m.gpu) viewer.remove(m.item); items.items.delete(m.item); }
    sim.meshes = [];
    const nodes = atelier.nodes();
    const colours = fabricColours(nodes);
    const fabricOf = new Map(nodes.filter((n) => n.kind === "garment.pattern").map((n) => [n.id, n.fabric]));
    // the GPU cloth: one item, shown by the host; the vertex patterns kept for picks
    sim.vertexPatterns = t.vertexPatterns; sim.patterns = t.patterns; sim.triangles = t.triangles;
    if (t.gpu) sim.meshes.push({ item: t.gpu.item, id: null, verts: null, gpu: true, colour: null });
    else for (const [p, g] of splitByPattern(t.triangles, t.vertexPatterns)) {
        const id = t.patterns[p];
        const colour = colours.get(fabricOf.get(id)) ?? "#cccccc";
        const buf = gather(t.positions, g.verts);
        const item = viewer.showMesh({ positions: buf, indices: g.indices, colour: selected("pattern", id) ? ACCENT : colour });
        sim.meshes.push({ item, id, verts: g.verts, indices: g.indices, buf, colour });
        items.set(item, { kind: "pattern", id });
    }
    sim.positions = t.positions; sim.pins = t.pins; sim.status = t.status; sim.phase = t.phase;
    sim.health = healthOf(t.status, t.phase);
    sim.stale = t.stale ?? null;
    sim.live = true; sim.building = false; sim.meshGen++;
    dragging = null;
    flatVisible(false);
    drawGizmo();
    showPins();
    simPost();
}

function onFrame(f) {
    sim.positions = f.positions ?? sim.positions; sim.pins = f.pins; sim.status = f.status; sim.phase = f.phase;
    if (f.health) { sim.health = f.health; sim.lastMs = f.ms; sim.rate.add(performance.now(), f.ms); }
    if (f.positions) for (const m of sim.meshes) viewer.setMeshPositions(m.item, gather(f.positions, m.verts, m.buf), null);
    showPins();
    simPost();
}

function onCloth({ data: m }) {
    try {
        switch (m.kind) {
            case "hello": if (avatarCollider) clothPort.postMessage({ kind: "avatar", avatar: avatarCollider }); break;
            case "topology": onTopology(m); break;
            case "frame": onFrame(m); break;
            case "colours": onColours(m); break;
            case "pinned": post({ kind: "status", text: m.on ? "pinned" : "unpinned" }); break;
            case "state":
                sim.running = m.running; sim.stale = m.stale ?? sim.stale;
                if (!m.running) { sim.rate.clear(); sim.stops++; }
                if (!m.live) { sim.live = false; sim.building = false; sim.stale = null; removeCloth(); drawGizmo(); }
                // film: draw the stop's frame now, so a step resolves on a frame the View has drawn
                if (sim.film && !m.running) { viewer.draw(); sim.drawn = viewer.stats().framesDrawn; }
                if (m.error) { sim.building = false; post({ kind: "error", text: `simulation: ${m.error}` }); }
                if (m.reason) post({ kind: "status", text: m.reason });
                simPost();
                break;
        }
    } catch (e) { post({ kind: "error", text: `simulation: ${e.message ?? e}` }); }
}

function simCommand(action, data = {}) {
    if (!clothPort) throw new Error("the cloth worker is not connected");
    if (action === "reset") { clothPort.postMessage({ kind: "reset" }); return; }
    const film = filmCommand(action, sim, data);            // step / run / pause, the film's toggle
    if (film !== undefined) { if (film) clothPort.postMessage(film); return; }
    if (action !== "toggle") return;
    // running: pause (stale or not); stopped: rebuild a missing or stale cloth, else run on
    if (sim.live && sim.running) clothPort.postMessage({ kind: "pause" });
    else if (!sim.live || sim.stale) {
        if (sim.building) return;
        sim.building = true; sim.rate.clear(); sim.lastMs = null;
        clothPort.postMessage({ kind: "build", ...garmentNow(), run: !sim.film });
        simPost();
    } else clothPort.postMessage({ kind: "run" });
}

// Pin and drag on the cloth: `phase` down / move / up, x y in device pixels. A press picks the
// cloth and takes the nearest sim vertex of the piece hit.
let pressId = 0;
async function tool3d(data) {
    if (data.tool === "place") { if (data.phase === "down") await placeOnAvatar(data); return; }
    if (data.tool === "gizmo") { gizmoEvent(data); return; }
    if (data.phase === "down") {
        const press = ++pressId;
        dragging = null;
        if (!sim.live) { post({ kind: "status", text: "Simulate first: pins and drags act on the cloth" }); return; }
        const p = await viewer.pick(0, data.x - (rects?.[0]?.[0] ?? 0), data.y - (rects?.[0]?.[1] ?? 0));
        const hit = p && sim.meshes.find((m) => m.item === p.item);
        const positions = hit?.gpu && p.point ? await clothPort.positions() : sim.positions;   // the GPU's, read back
        if (!hit || !p.point || !positions) { post({ kind: "status", text: "not on the cloth" }); return; }
        const vertex = nearestVertex(positions, p.point, hit.verts);
        if (data.tool === "pin") { clothPort.postMessage({ kind: "pin", vertex }); return; }
        if (press !== pressId) {                   // a drag let go before the pick came back: say so (CPU or GPU)
            post({ kind: "status", text: "let go before the cloth answered: hold the press a moment, then drag" });
            return;
        }
        const start = Array.from(positions.subarray(3 * vertex, 3 * vertex + 3));
        const basis = dragBasis(viewer.camera(0), start, rects?.[0]?.[3] ?? canvasRef?.height ?? 800);
        if (!basis) { post({ kind: "status", text: "dragging needs the orbit camera" }); return; }
        dragging = { vertex, start, x: data.x, y: data.y, basis };
        clothPort.postMessage({ kind: "drag", vertex, target: start });
        post({ kind: "status", text: sim.running || sim.film ? "dragging the cloth" : "paused: the drag acts when the cloth runs" });
    } else if (data.phase === "move" && dragging) {
        const d = dragging;
        clothPort.postMessage({ kind: "drag", vertex: d.vertex, target: dragTarget(d.start, d.basis, data.x - d.x, data.y - d.y) });
    } else if (data.phase === "up") {
        pressId++;
        if (dragging) clothPort.postMessage({ kind: "drag", vertex: dragging.vertex, target: null });
        dragging = null;
    }
}

// Place on avatar (spec §4): a click on the avatar puts the selected piece there. The pick gives
// the point; the normal is the collider's triangle under it, turned toward the eye. One batch:
// the piece and the pieces on it (they follow, as a re-placed host's do).
async function placeOnAvatar(data) {
    const id = selection?.kind === "pattern" ? selection.id : null;
    if (!id) { post({ kind: "status", text: "Place on avatar: select a pattern piece first" }); return; }
    if (atelier.previewing) return;
    const p = await viewer.pick(0, ...at3d(data));
    if (!avatar || !p?.point || p.item !== avatar.id) { post({ kind: "status", text: "Place on avatar: click the avatar" }); return; }
    const hit = avatarCollider ? nearestTriangle(avatarCollider.positions, avatarCollider.indices, p.point) : null;
    if (!hit) { post({ kind: "error", text: "Place on avatar: the avatar has no collider triangles" }); return; }
    const basis = dragBasis(viewer.camera(0), p.point, rects?.[0]?.[3] ?? canvasRef?.height ?? 800);
    const b = avatar.bounds, away = basis?.eye ?? [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2];
    const sign = basis?.eye ? 1 : -1;      // toward the eye, or away from the avatar's centre
    let n = hit.normal;
    if (sign * n.reduce((s, v, i) => s + v * (away[i] - p.point[i]), 0) < 0) n = n.map((v) => -v);
    const nodes = atelier.nodes(), node = nodes.find((x) => x.id === id), drawings = atelier.slotBounds();
    const bounds = drawings.get(id)?.bounds;
    if (!bounds) { post({ kind: "error", text: "Place on avatar: the piece has no outline to place" }); return; }
    const slot = atSlot(p.point, n, data.wrap !== false);
    const fields = slotFields(node, slot, b, bounds, { landmarks: avatar.landmarks, up: basis?.up ?? null });
    const after = nodes.map((x) => (x.id === id ? { ...x, ...fields } : x));
    const follow = reslotOps(after, drawings, atelier.avatar ?? { bounds: b, landmarks: avatar.landmarks }, new Set([id])).ops.filter((o) => o.id !== id);
    atelier.apply([...setPattern(nodes, id, fields), ...follow], "place on avatar");
    changed();
    post({ kind: "status", text: `placed ${node.label ?? id} on the avatar${fields.wrap ? ", wrapped round the arm" : ""}` });
}

// ---- the 3D gizmo (gizmo.js, spec §3) -----------------------------------------------------------
// Over the selected placed piece while the cloth is not live: arrows, rings and the centre
// square on a layer of their own, on top. A drag previews the piece's frame (and wrap); the
// release commits it, one undo step, the slot "custom" and the pieces on it following.
let gizmo = null;                        // { id, pivot, size, radius, parts: part -> item, handles }
let gizmoItems = [];
let gz = null;                           // the drag: { id, part, start, pivot, basis, c, grab, nodes, ops }
function drawGizmo() {
    if (!viewer || !atelier) return;
    for (const id of gizmoItems) { viewer.remove(id); items.items.delete(id); }
    gizmoItems = [];
    const was = gizmo?.id ?? null;
    gizmo = null;
    const id = selection?.kind === "pattern" && !(selection.ids?.length > 1) ? selection.id : null;
    const node = id ? atelier.nodes().find((n) => n.id === id) : null;
    const bounds = node ? atelier.drawings().find((d) => d.id === id)?.bounds : null;
    if (sim.live || !node || !node.frame || node.frame === "xy" || !bounds) { if (was !== null) postGizmo(); return; }
    const pivot = gizmoPivot(node, bounds), size = gizmoSize(bounds), shapes = gizmoShapes(pivot, node.frame, size);
    const parts = {};
    for (const part of PARTS) {
        const item = part === "plane" ? viewer.showPoints(shapes.plane, GIZMO_COLOURS.plane, 12) : viewer.showLines(shapes[part], GIZMO_COLOURS[part]);
        viewer.setItemLayer(item, GIZMO_LAYER);
        viewer.setOnTop?.(item, true);
        items.set(item, { kind: "gizmo", part });
        parts[part] = item;
        gizmoItems.push(item);
    }
    gizmo = { id, pivot, size, radius: RING * size, parts, handles: shapes.handles };
    if (gz?.part) paintGizmo(gz.part);
    postGizmo();
}
// Where a press grabs each part, in canvas device pixels (the browser test presses there).
function gizmoHandles() {
    const o = rects?.[0] ?? [0, 0], c = viewer.project(0, gizmo.pivot);
    if (!c) return null;
    const at = (p) => { const s = viewer.project(0, p); return s ? [s[0] + o[0], s[1] + o[1]] : null; };
    const out = { plane: [c[0] + o[0], c[1] + o[1]] };
    for (const part of ["tx", "ty", "tz"]) out[part] = at(gizmo.handles[part]);
    const arrows = ["tx", "ty", "tz"].filter((p) => out[p]).map((p) => [out.plane[0], out.plane[1], out[p][0], out[p][1]]);
    for (const part of ["rn", "rx", "ry"]) out[part] = ringHandle(gizmo.handles[part].map(at).filter(Boolean), out.plane, arrows);
    return out;
}
function postGizmo() { post({ kind: "gizmo", id: gizmo?.id ?? null, handles: gizmo ? gizmoHandles() : null }); }
function paintGizmo(hover) {
    if (!gizmo) return;
    for (const [part, item] of Object.entries(gizmo.parts)) viewer.setColour(item, part === hover ? GIZMO_HOVER : GIZMO_COLOURS[part]);
}
async function gizmoHover(data) {
    let part = null;
    if (gizmo && !gz) {
        const p = await viewer.pick(0, ...at3d(data));
        const w = p ? items.resolve(p.item) : null;
        part = w?.kind === "gizmo" ? w.part : null;
        paintGizmo(part);
    }
    post({ kind: "gizmoHover", seq: data.seq, part });
}
const GIZMO_VERB = { tx: "move along X", ty: "move along Y", tz: "move along Z", plane: "move", rn: "turn about the normal", rx: "turn about x", ry: "turn about y" };
function gizmoEvent(data) {
    if (data.phase === "down") {
        gz = null;
        if (!gizmo || sim.live || atelier.previewing || !GIZMO_VERB[data.part]) return;
        const node = atelier.nodes().find((n) => n.id === gizmo.id);
        const basis = dragBasis(viewer.camera(0), gizmo.pivot, rects?.[0]?.[3] ?? canvasRef?.height ?? 800);
        const c = viewer.project(0, gizmo.pivot);
        if (!node || !basis || !c) { post({ kind: "status", text: "the gizmo needs the orbit camera" }); return; }
        const [x, y] = at3d(data);
        gz = {
            id: gizmo.id, part: data.part, start: { frame: node.frame, wrap: node.wrap ?? null }, pivot: gizmo.pivot, basis, c,
            grab: [x - c[0], y - c[1]], radius: gizmo.radius, nodes: atelier.nodes(), ops: null, label: node.label ?? node.id,
        };
        paintGizmo(data.part);
        post({ kind: "status", text: `${GIZMO_VERB[data.part]}: Shift snaps (10 mm, 15°), Escape cancels` });
    } else if (data.phase === "move" && gz) {
        const g = gz, [x, y] = at3d(data);
        const r = gizmoDrag(g.part, g.start, g.pivot, { basis: g.basis, grab: g.grab, now: [x - g.c[0], y - g.c[1]], radius: g.radius, shift: !!data.shift });
        const ops = gizmoOps(g.nodes, g.id, r, atelier.slotBounds(), atelier.avatar);
        try { atelier.preview(ops); g.ops = ops; } catch (e) { post({ kind: "error", text: String(e.message ?? e) }); }
        changed();
        const what = g.part[0] === "r" ? `${((r.angle * 180) / Math.PI).toFixed(1)}°` : `${Math.hypot(...r.shift).toFixed(1)} mm`;
        post({ kind: "status", text: `${GIZMO_VERB[g.part]} ${what}` });
    } else if (data.phase === "up" && gz) {
        const g = gz;
        gz = null;
        if (!g.ops) { paintGizmo(null); return; }        // a press without a move
        atelier.endPreview(false);
        try { atelier.apply(g.ops, "move in 3D"); }
        finally { changed(); }
        post({ kind: "status", text: `moved ${g.label} in 3D: its slot is custom` });
    } else if (data.phase === "escape" && gz) {
        const g = gz;
        gz = null;
        if (g.ops) { atelier.endPreview(false); changed(); } else paintGizmo(null);
        post({ kind: "status", text: "gizmo move cancelled" });
    }
}

// ---- the fit map and the Tape tool (fitmap.js, tape3d.js) ---------------------------------------
// The CPU cloth's map colours: its pattern meshes re-shown with them (or their fabric colours).
function onColours(m) {
    sim.mapColours = m.colours; sim.mapValues = m.values;
    recolourMeshes(viewer, sim.meshes, m.colours, (old, next, mesh) => { items.items.delete(old); items.set(next, { kind: "pattern", id: mesh.id }); });
    if (!m.colours) paintSelection();
}
const at3d = (data) => [data.x - (rects?.[0]?.[0] ?? 0), data.y - (rects?.[0]?.[1] ?? 0)];
// The map's value under the pointer: the nearest sim vertex's.
async function mapHover(data) {
    const p = await viewer.pick(0, ...at3d(data));
    const hit = fitmap && p?.point ? sim.meshes.find((m) => m.item === p.item) : null;
    let value = null;
    if (hit?.gpu) {
        const r = await mapCache.get(`${fitmap.code}:${sim.meshGen}`, performance.now(), () => clothPort.strain(fitmap.code).catch(() => null));
        value = valueAt(r?.values, r?.positions, p.point);
    } else if (hit) value = valueAt(sim.mapValues, sim.positions, p.point, hit.verts);
    post({ kind: "mapValue", seq: data.seq, value: hit ? value : null });
}
// What a tape click landed on: "avatar", "cloth" or null (the tape itself, a flat slab, nothing).
function tapeTarget(p) {
    if (!p?.point || tapes.owns(p.item)) return null;
    if (avatar && p.item === avatar.id) return "avatar";
    return sim.live && sim.meshes.some((m) => m.item === p.item) ? "cloth" : null;
}
async function tapeOp(data) {
    if (data.op === "clear") { tapes.clear(); return; }
    if (data.op === "remove") { tapes.remove(data.id); return; }
    let mesh;
    if (data.target === "avatar") mesh = avatarCollider;
    else if (sim.live && sim.triangles) mesh = { positions: clothEngine === "gpu" ? await clothPort.positions() : sim.positions, indices: sim.triangles };
    if (!mesh?.positions) throw new Error(`tape: no ${data.target === "avatar" ? "avatar" : "cloth"} to measure`);
    post({ kind: "taped", id: data.id, op: data.op, target: data.target, length: tapes.measure(data, mesh) });
}

// `seq` echoes the request's own `seq`, so the page knows which change a `doc` answers.
// A live cloth hears every change: it re-meshes what an outline edit touched, or goes stale.
function changed(seq) {
    post({ kind: "doc", seq: seq ?? null, ...doc() });
    refresh3d();
    refresh2d();
    if (!atelier.previewing) lastSaved = null;
    if (sim.live && clothPort) clothPort.postMessage({ kind: "update", ...garmentNow() });
    syncForm();
}

// `form` is the forms.json entry (its landmarks) for a dress form from assets; a user's STEP or
// STL passes none, so a file that happens to be called f-M does not inherit f-M's landmarks.
// `format` is the reader's: "step" or "stl" (arrange.js avatarFormat). An STL is a mesh scene:
// its collider comes from its triangles as a STEP's does.
async function loadAvatar(bytes, name, form = null, format = "step") {
    const v = viewer;
    // read and show first: a bad file keeps the avatar already there, and frees what it made
    const scene = open(new Uint8Array(bytes), format, undefined, "native");
    let b, id;
    try {
        b = sceneBox(scene.vertices(), scene.origin());
        id = v.showScene(scene);
    } catch (e) { scene.free(); throw e; }
    let collider = null;
    try { collider = avatarMesh(scene.vertices(), scene.origin(), scene.indices()); }
    catch (e) { post({ kind: "error", text: `avatar collider: ${e.message ?? e}` }); }
    if (form) lastShipped = name;
    setAvatar({ id, collider, bounds: b, name, landmarks: form, dispose: () => scene.free() });
}

// The avatar shown, whatever made it (a STEP or STL file, a shipped form, a form built from
// measurements): the old one removed and disposed, the cloth told (the drape goes stale), the
// page told, the kernel facade told (every later batch re-places the pieces it edits on it), then
// every placed piece re-placed on it in one undo step (kernel.js reslot).
function setAvatar({ id, collider, bounds, name, landmarks = null, dispose = null, formKey = null, extra = {} }) {
    if (avatar) { viewer.remove(avatar.id); avatar.dispose?.(); }
    avatar = { id, bounds, name, landmarks, dispose, formKey };
    atelier?.setAvatar({ bounds, landmarks });
    shownFormKey = formKey;
    avatarCollider = collider;
    try {
        if (collider) clothPort?.postMessage({ kind: "avatar", avatar: collider });
        if (sim.live) { sim.stale = "the avatar changed"; simPost(); }
    } catch (e) { post({ kind: "error", text: `avatar collider: ${e.message ?? e}` }); }
    if (rects) frame3d();
    post({ kind: "avatar", name, bounds, landmarks, formKey, ...extra });
    reslotPieces();
    if (atelier) refresh3d();
}

function reslotPieces() {
    if (!atelier || !avatar || atelier.previewing) return;
    try {
        const r = atelier.reslot("re-arrange on the form");
        if (!r.ops.length) return;
        changed();
        post({ kind: "status", text: `re-arranged ${r.moved.length} piece${r.moved.length === 1 ? "" : "s"} on the form` });
    } catch (e) { post({ kind: "error", text: `re-arrange: ${e.message ?? e}` }); }
}

// ---- dress forms built from measurements (form-worker.js) ------------------------------------
// The document's meta atelier.form is what is built: every change runs syncForm, so Build,
// Apply, undo, redo and Open all arrive here. A build answers on the form worker; only the
// latest ask (formAsk, shared with the shipped-form picks) is shown.
const FORM_COLOUR = "#d8cbb8";
let formWorker = null;
let shownFormKey = null;         // the built form on the View (its spec key), null for any other avatar
let pendingFormKey = null;       // the build in flight
let lastShipped = "f-M";         // the shipped form an undo past the first build goes back to
let changeCause = null;          // the message kind of the change being handled

function syncForm() {
    if (!atelier) return;
    const spec = atelier.formMeta(), key = specKey(spec);
    if (key) {
        if (key !== shownFormKey && key !== pendingFormKey) requestForm(spec, key);
    } else if (changeCause === "open" || changeCause === "new") {
        if (pendingFormKey) { pendingFormKey = null; formAsk++; }      // the avatar stays as it is
    } else if (shownFormKey && (changeCause === "undo" || changeCause === "redo")) {
        pendingFormKey = null;
        loadShippedForm(lastShipped).catch((e) => post({ kind: "error", text: `avatar: ${e.message ?? e}` }));
    }
}

function requestForm(spec, key) {
    if (!formWorker) {
        formWorker = new Worker(new URL("./form-worker.js", import.meta.url), { type: "module" });
        formWorker.onmessage = ({ data }) => { try { onFormBuilt(data); } catch (e) { post({ kind: "error", text: `form: ${e.message ?? e}` }); } };
        formWorker.onerror = (e) => { e.preventDefault?.(); pendingFormKey = null; post({ kind: "error", text: `form worker: ${e.message || "failed"}` }); };
    }
    const ask = ++formAsk;
    pendingFormKey = key;
    post({ kind: "formBuilding", key });
    formWorker.postMessage({ kind: "build", ask, key, spec });
}

function onFormBuilt(m) {
    if (m.ask !== formAsk) return;              // a later pick or build is on its way
    pendingFormKey = null;
    if (m.kind === "buildError") { post({ kind: "error", text: `form: ${m.text}` }); post({ kind: "formFailed", key: m.key }); return; }
    const all = concatParts(m.parts);
    const id = viewer.showMesh({ positions: all.positions, normals: all.normals, indices: all.indices, colour: FORM_COLOUR });
    const spec = JSON.parse(m.key);
    setAvatar({
        id, collider: { positions: all.positions, indices: all.indices }, bounds: positionsBox(all.positions), name: "custom form",
        landmarks: { ...m.landmarks, name: "custom", label: "Custom form", form: spec, girths: m.girths },
        formKey: m.key,
        extra: { timings: m.timings, separate: m.separate, cached: m.cached, triangles: all.indices.length / 3 },
    });
}

async function loadShippedForm(name) {
    const ask = ++formAsk;
    const form = forms.find((f) => f.name === name);
    if (!form) throw new Error(`no form ${name}`);
    const r = await fetch(new URL(`./assets/${form.file}`, import.meta.url));
    if (!r.ok) throw new Error(`${form.file}: ${r.status}`);
    const bytes = await r.arrayBuffer();
    if (ask !== formAsk) return;               // a later pick is loading: the last one chosen wins
    await loadAvatar(bytes, form.name, form);
}

// A transform/mirror request answers with the new outline path; the document is not changed.
function answer(data, make) {
    try { post({ kind: "path", reqId: data.reqId, path: make() }); }
    catch (e) { post({ kind: "error", reqId: data.reqId, text: String(e && e.message ? e.message : e) }); }
}

// The messages that change the document; each answers with `doc` (see changed()).
const CHANGES = new Set(["ops", "preview", "endPreview", "undo", "redo", "open", "new", "importDxf", "cut", "trace", "fillet", "point", "unfold", "foldBack", "form"]);

self.onmessage = async ({ data }) => {
    try {
        if (data.cadaclysm) return;      // forwarded input: receiveControls hears it
        if (data.kind === "clothPort") { if (clothEngine === "cpu") { clothPort = data.port; clothPort.onmessage = onCloth; if (fitmap) clothPort.postMessage({ kind: "map", map: fitmap }); } return; }
        if (data.kind === "canvas") {
            canvasRef = data.canvas;
            sim.film = !!data.film;
            try {
                viewer = await createViewer(data.canvas);
                atelier = new Atelier(await ready);
                tapes = new TapeMeasures(viewer, await ready);
                if (gpuClothOk(viewer) && !data.cpuCloth) {
                    clothEngine = "gpu";
                    clothPort = new GpuDrapeHost(viewer, await ready);
                    clothPort.onmessage = onCloth;
                }
                startedResolve();
            } catch (e) { startedReject(e); throw e; }
            try {
                const r = await fetch(new URL("./assets/forms.json", import.meta.url));
                if (r.ok) forms = (await r.json()).forms ?? [];
            } catch { forms = []; }        // no forms list: the avatar loads with no landmarks
            post({ kind: "forms", forms });
            try {
                const r = await fetch(new URL("./assets/f-M.stp", import.meta.url));
                if (r.ok) await loadAvatar(await r.arrayBuffer(), "f-M", forms.find((f) => f.name === "f-M") ?? null);
            } catch (e) { post({ kind: "error", text: `avatar: ${e.message ?? e}` }); }
            post({ kind: "ready", backend: viewer.backend, version: version(), license: licenseInfo(), clothEngine });
            changed();
            return;
        }
        await started;
        changeCause = data.kind;
        switch (data.kind) {
            // a hole added too small for its allowance is kept, with a word on the status line
            // `reanchor` (a pattern id or a list): those pieces' seams re-anchored in the same commit
            case "ops": {
                const cutless = atelier.cutlessHoles();
                const r = atelier.commit(data.ops, data.message, data.reanchor ?? null);
                if (r.removed.length) post({ kind: "status", text: `removed seam${r.removed.length === 1 ? "" : "s"} ${r.removed.join(", ")}: the side is gone` });
                changed(data.seq);
                const warn = atelier.newCutlessHoles(cutless);
                if (warn) post({ kind: "status", text: warn });
                break;
            }
            case "preview": atelier.preview(data.ops); changed(data.seq); break;
            // a committed edit re-anchors the seams of the pattern it changed, in the same commit
            case "endPreview": {
                const r = atelier.endPreview(data.commit, data.reanchor ?? null);
                changed(data.seq);
                if (r.removed.length) post({ kind: "status", text: `removed seam${r.removed.length === 1 ? "" : "s"} ${r.removed.join(", ")}: the side is gone` });
                break;
            }
            // a cut (and sew): one batch; a refusal changes nothing and says why (the error)
            case "cut": {
                // a linked piece is unlinked first (spec §6): the cut's pieces are linked to nothing,
                // and the partner's link goes in the same batch (kernel.js symmetryOps)
                const partner = linkOf(atelier.nodes().find((n) => n.id === data.id))?.partner;
                const r = atelier.cutOps(data.id, data.cutter, { sew: data.sew, consume: data.consume });
                atelier.apply(r.ops, data.sew ? "cut & sew" : "cut");
                changed(data.seq);
                const notes = [];
                if (r.dropped.length) notes.push(`dropped seam${r.dropped.length === 1 ? "" : "s"} ${r.dropped.join(", ")}: the cut split its range`);
                if (r.collapsed) notes.push("the per-side allowance is now one width");
                if (partner) notes.push(`unlinked from ${atelier.nodes().find((n) => n.id === partner)?.label ?? partner} first`);
                post({ kind: "status", text: [data.sew ? "cut and sewn" : "cut", ...notes].join("; ") });
                break;
            }
            // a trace: one batch; a refusal changes nothing and says why (the error)
            case "trace": atelier.apply(atelier.traceOps(data.id, data.index), "trace"); changed(data.seq); break;
            // a fillet: one batch with its seams re-anchored; a refusal changes nothing and says why
            case "fillet": atelier.commit(atelier.filletOps(data.id, data.corner, data.radius), "fillet", data.id); changed(data.seq); break;
            // a point inserted, removed or made a corner/curve point (kernel.js pointOps): one batch,
            // an outline's seams re-anchored in it; a refusal changes nothing and names the point
            case "point": atelier.commit(atelier.pointOps(data), "point", data.line == null ? data.id : null); changed(data.seq); break;
            // Unfold and Fold back (spec §6): one batch each, the piece's seams re-anchored in it; the
            // seams that lose their side are named
            case "unfold": case "foldBack": {
                const r = data.kind === "unfold" ? atelier.unfoldOps(data.id, data.side) : atelier.foldBackOps(data.id);
                atelier.commit(r.ops, data.kind === "unfold" ? "unfold" : "fold back", data.id);
                changed(data.seq);
                const what = data.kind === "unfold" ? "unfolded" : "folded back";
                post({ kind: "status", text: r.dropped.length ? `${what}; dropped seam${r.dropped.length === 1 ? "" : "s"} ${r.dropped.join(", ")}: ${data.kind === "unfold" ? "on the fold side" : "on the mirrored side"}` : what });
                break;
            }
            case "undo": { const did = atelier.undo(); changed(data.seq); if (!did) post({ kind: "status", text: "nothing to undo" }); break; }
            case "redo": atelier.redo(); changed(data.seq); break;
            // the whole piece: outline, internal lines, notches and grain (kernel.js transformedPiece)
            case "transform": answer(data, () => atelier.transformedPiece(data.id, data.matrix)); break;
            case "mirror": answer(data, () => atelier.mirroredPiece(data.id, data.axis)); break;
            case "ellipse": answer(data, () => atelier.ellipsePath(data.cx, data.cy, data.rx, data.ry)); break;
            case "transformAll": answer(data, () => Object.fromEntries(data.ids.map((id) => [id, atelier.transformedPiece(id, data.matrix)]))); break;
            // the clipboard's pieces ([{node, path}]) moved for a paste: [{path, internal, notches, grain}]
            case "placePieces": answer(data, () => atelier.piecesThrough(data.pieces, data.matrix)); break;
            case "pickRect": answer(data, () => (rects && items2d ? boxSelect(data) : { indices: [], ids: [] })); break;
            case "save": post({ kind: "saved", text: atelier.save() }); break;
            case "viewStats": answer(data, () => viewer.stats()); break;
            // the cloth's sim vertex positions (xyz, mm) as they stand, read back from the GPU (film.js
            // clothPositions); null with no GPU cloth
            case "clothPositions": {
                try { const p = clothPort?.positions ? await clothPort.positions() : null; post({ kind: "path", reqId: data.reqId, path: p ? Array.from(p) : null }); }
                catch (e) { post({ kind: "error", reqId: data.reqId, text: String(e?.message ?? e) }); }
                break;
            }
            // an opened garment is framed with the avatar: its pieces may stand beyond the form
            case "open": atelier.load(data.text); changed(data.seq); if (rects) frame3d(); break;
            case "new": atelier.reset(data.ops); changed(data.seq); break;
            case "importDxf": atelier.apply(atelier.fromDxf(data.text, data.fabric), "import"); changed(data.seq); break;
            case "exportDxf": post({ kind: "dxf", text: atelier.toDxf() }); break;
            case "avatar": await loadAvatar(data.bytes, data.name, null, data.format ?? "step"); break;
            case "avatarAsset": await loadShippedForm(data.name); break;
            // Build / Apply: the form's spec into the document (one undo step); syncForm builds it
            case "form": atelier.apply([atelier.formMetaOp(data.spec ?? null)], data.spec ? "build form" : "shipped form"); changed(data.seq); break;
            case "select": selection = data.selection ?? null; pointSel = []; ipointSel = []; paintSelection(); refresh2d(); drawGizmo(); break;
            // always answered: the page keeps one gizmo hover in flight
            case "gizmoHover": await gizmoHover(data).catch(() => post({ kind: "gizmoHover", seq: data.seq, part: null })); break;
            case "pick3d": {
                const p = await viewer.pick(0, data.x - (rects?.[0]?.[0] ?? 0), data.y - (rects?.[0]?.[1] ?? 0));
                // the Tape tool's click: the point and what it is on
                if (data.tape) { post({ kind: "picked", tape: true, target: tapeTarget(p), point: p?.point ?? null }); break; }
                let selection = p ? items.resolve(p.item) : null;
                // the GPU cloth is one item: the piece is the nearest vertex's
                if (p?.point && sim.meshes.some((m) => m.gpu && m.item === p.item)) {
                    const positions = await clothPort.positions();
                    const v = positions ? nearestVertex(positions, p.point) : -1;
                    selection = v >= 0 ? { kind: "pattern", id: sim.patterns[sim.vertexPatterns[v]] } : null;
                }
                post({ kind: "picked", seq: data.seq ?? null, selection });
                break;
            }
            case "resize": viewer.resize?.(data.width, data.height, data.dpr); break;
            case "sim": simCommand(data.action, data); break;
            // GIA on the GPU cloth (the CPU worker always runs it): the host re-shows a live cloth with it
            case "gia": if (clothEngine === "gpu") clothPort.postMessage({ kind: "gia", on: !!data.on }); break;
            case "tool3d": await tool3d(data); break;
            case "fitmap": fitmap = data.map ?? null; mapCache.clear(); clothPort?.postMessage({ kind: "map", map: fitmap }); break;
            // always answered: the page keeps one hover in flight
            case "mapHover": await mapHover(data).catch(() => post({ kind: "mapValue", seq: data.seq, value: null })); break;
            case "tape": await tapeOp(data); break;
            case "rects": setRects(data.rects); break;
            case "pointer2d": pointers2d.event(data); break;
            case "snapping":
                snapping.on = !!data.on; snapping.grid = !!data.grid;
                viewer.setSnap(snapping.on ? { kinds: snapping.grid ? [...SNAP_KINDS, "grid"] : SNAP_KINDS, marker: true } : null);
                if (!snapping.on) viewer.clearSnap();
                break;
            case "snapBase": viewer.setSnapBase(data.point ? [data.point[0], data.point[1], 0] : null, 45); break;
            // the pointer left the 2D window: no piece is hovered (after the events before it)
            case "leave2d": pointers2d.after(() => { if (hover2d !== null) { hover2d = null; refresh2d(); } }); break;
            // the ellipse being dragged is the kernel's, as Béziers
            case "overlay2d": {
                let curves = null;
                // a flat drag has no ellipse yet: no curve (any other kernel failure is reported)
                if (data.ellipse && data.ellipse[2] > 0 && data.ellipse[3] > 0) curves = atelier.ellipseBeziers(...data.ellipse);
                overlay2d?.set({ lines: data.lines ?? [], points: data.points ?? [], curves, labels: data.labels ?? [], text: data.text ?? null });
                break;
            }
            case "pointSel": pointSel = data.indices ?? []; ipointSel = data.internal ?? []; refresh2d(); break;
            case "tool2d": tool2d = data.name; refresh2d(); break;
            case "fit2d": if (rects) fit2d(); break;
        }
    } catch (e) {
        post({ kind: "error", reqId: data.reqId, text: String(e && e.message ? e.message : e) });
        // a change that failed (refused, say) still answers its `seq`: the page takes the
        // kernel's state again instead of keeping what it expected
        if (CHANGES.has(data.kind) && atelier) {
            try { changed(data.seq); } catch (e2) { post({ kind: "error", text: String(e2 && e2.message ? e2.message : e2) }); }
        }
    }
};
