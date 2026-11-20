// The Atelier worker: it owns the cadaclysm wasm module, one Atelier (the garment document)
// and the View on the page's 3D canvas. The main thread sends edits; every change answers with
// `doc` and redraws the 3D window. No geometry is checked here: the kernel does that.
//
// The live drape: the solver runs in the cloth worker (cloth-worker.js), reached over the
// MessagePort the page hands this worker (`clothPort`). This worker builds it from the saved
// document, sends it every later change (it re-meshes or goes stale), and draws its frames: one
// mesh per pattern, moved in place by setMeshPositions as each frame arrives. The View keeps
// drawing and orbiting at the display rate however slowly the cloth steps.
import { load, open, version, licenseInfo, View } from "./pkg/index.js";
import { receiveControls } from "./pkg/view.js";
import * as k from "./pkg/index.js";
import { Atelier, forPage } from "./kernel.js";
import { drawFrame, frame12, showSeams, isSelected, ItemMap, fabricColours, ACCENT, sceneBox } from "./arrange.js";
import { splitByPattern, gather, nearestVertex, dragBasis, dragTarget, avatarMesh, healthOf, RateMeter } from "./drape.js";
import { specs2d, Items2d, Overlay2d, LAYER_2D } from "./scene2d.js";
import { unionBounds, boxPiece } from "./view2d.js";
import { Pointer2d } from "./pointer2d.js";

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
let avatar = null;                       // { scene, id, bounds, name }
let drawn = [];                          // View item ids of the slabs and seam lines
let selection = null;
const items = new ItemMap();
const slabs = new Map();                 // pattern id -> { item, colour }
const seamLines = new Map();             // seam id -> { item, colour }
const slabBoxes = new Map();             // pattern id -> its slab's world box [x0, y0, z0, x1, y1, z1]
let canvasRef = null;                    // the OffscreenCanvas: its height is the drag's pixel scale
let items2d = null, overlay2d = null, rects = null, hover2d = null, pointSel = [];

// ---- the live drape ---------------------------------------------------------------------------
const PIN_COLOUR = "#ff4d6d";
let clothPort = null;
let avatarCollider = null;               // the avatar as the cloth's mesh, sent at every build
let lastSaved = null;                    // the committed document's text, kept outside previews
const sim = {
    live: false, running: false, building: false, stale: null,
    meshes: [],                          // { item, id (pattern), verts, buf, colour }
    positions: null, pins: null, pinsItem: 0,
    status: null, phase: "", health: null,
    rate: new RateMeter(),
    meshGen: 0,                          // bumped by every new mesh (a build, a re-mesh)
};
let dragging = null;                     // { vertex, start, x, y, basis } while a cloth drag is on

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

// The two windows: viewport 0 the orbit camera on layer 0 (the avatar, slabs, seams, cloth),
// viewport 1 an orthographic camera on the pattern plane z = 0 on layer 1. The first rects set
// them; later ones (the divider, F2/F3, a resize) only move them.
function setRects(r) {
    const first = !rects;
    rects = r;
    if (!first) { viewer.setViewportRects(r); return; }
    viewer.setViewports([
        { rect: r[0], camera: { kind: "orbit" }, grid: "front", layerMask: 1 << 0 },
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
}

function refresh2d() {
    if (!viewer || !atelier || !items2d) return;
    const nodes = atelier.nodes();
    items2d.apply(specs2d({ drawings: atelier.drawings(), seams: atelier.seams(), nodes, selection, pointSel, hover: hover2d, colours: fabricColours(nodes) }));
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
    for (const r of hits) { const id = boxPiece(items2d.what(r.item)); if (id) ids.add(id); }
    return { ids: [...ids] };
}

// Redraw the garment: a 1 mm slab per pattern at its frame, each seam as its own lines item.
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
    const frames = new Map();
    let first = null;
    slabs.clear(); seamLines.clear(); slabBoxes.clear();
    for (const d of atelier.drawings()) {
        const node = byId.get(d.id);
        const frame = drawFrame(node, bounds);
        frames.set(d.id, frame);
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
    const { shown, error } = showSeams(viewer, atelier.seams(), frames, selection);
    for (const s of shown) { drawn.push(s.item); items.set(s.item, { kind: "seam", id: s.id }); seamLines.set(s.id, s); }
    if (sim.meshes.length) flatVisible(false);
    first ??= error;
    if (first) post({ kind: "error", text: String(first.message ?? first) });
}

// The selection's accent on the slabs already drawn.
function paintSelection() {
    for (const [id, s] of slabs) viewer.setColour(s.item, selected("pattern", id) ? ACCENT : s.colour);
    for (const [id, s] of seamLines) viewer.setColour(s.item, selected("seam", id) ? ACCENT : s.colour);
    for (const m of sim.meshes) viewer.setColour(m.item, selected("pattern", m.id) ? ACCENT : m.colour);
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
    post({
        kind: "sim", live: sim.live, running: sim.running, building: sim.building, stale: sim.stale,
        health: sim.health, phase: sim.phase, fps: r.fps, ms: r.ms, pins: sim.pins ? sim.pins.length / 3 : 0, meshGen: sim.meshGen,
    });
}

function removeCloth() {
    for (const m of sim.meshes) { viewer.remove(m.item); items.items.delete(m.item); }
    sim.meshes = [];
    if (sim.pinsItem) { viewer.remove(sim.pinsItem); sim.pinsItem = 0; }
    sim.positions = null; sim.pins = null; sim.health = null; sim.status = null;
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
    for (const m of sim.meshes) { viewer.remove(m.item); items.items.delete(m.item); }
    sim.meshes = [];
    const nodes = atelier.nodes();
    const colours = fabricColours(nodes);
    const fabricOf = new Map(nodes.filter((n) => n.kind === "garment.pattern").map((n) => [n.id, n.fabric]));
    for (const [p, g] of splitByPattern(t.triangles, t.vertexPatterns)) {
        const id = t.patterns[p];
        const colour = colours.get(fabricOf.get(id)) ?? "#cccccc";
        const buf = gather(t.positions, g.verts);
        const item = viewer.showMesh({ positions: buf, indices: g.indices, colour: selected("pattern", id) ? ACCENT : colour });
        sim.meshes.push({ item, id, verts: g.verts, buf, colour });
        items.set(item, { kind: "pattern", id });
    }
    sim.positions = t.positions; sim.pins = t.pins; sim.status = t.status; sim.phase = t.phase;
    sim.health = healthOf(t.status, t.phase);
    sim.stale = t.stale ?? null;
    sim.live = true; sim.building = false; sim.meshGen++;
    dragging = null;
    flatVisible(false);
    showPins();
    simPost();
}

function onFrame(f) {
    sim.positions = f.positions; sim.pins = f.pins; sim.status = f.status; sim.phase = f.phase;
    if (f.health) { sim.health = f.health; sim.rate.add(performance.now(), f.ms); }
    for (const m of sim.meshes) viewer.setMeshPositions(m.item, gather(f.positions, m.verts, m.buf), null);
    showPins();
    simPost();
}

function onCloth({ data: m }) {
    try {
        switch (m.kind) {
            case "hello": if (avatarCollider) clothPort.postMessage({ kind: "avatar", avatar: avatarCollider }); break;
            case "topology": onTopology(m); break;
            case "frame": onFrame(m); break;
            case "pinned": post({ kind: "status", text: m.on ? "pinned" : "unpinned" }); break;
            case "state":
                sim.running = m.running; sim.stale = m.stale ?? sim.stale;
                if (!m.running) sim.rate.clear();
                if (!m.live) { sim.live = false; sim.building = false; sim.stale = null; removeCloth(); }
                if (m.error) { sim.building = false; post({ kind: "error", text: `simulation: ${m.error}` }); }
                if (m.reason) post({ kind: "status", text: m.reason });
                simPost();
                break;
        }
    } catch (e) { post({ kind: "error", text: `simulation: ${e.message ?? e}` }); }
}

function simCommand(action) {
    if (!clothPort) throw new Error("the cloth worker is not connected");
    if (action === "reset") { clothPort.postMessage({ kind: "reset" }); return; }
    if (action !== "toggle") return;
    // running: pause (stale or not); stopped: rebuild a missing or stale cloth, else run on
    if (sim.live && sim.running) clothPort.postMessage({ kind: "pause" });
    else if (!sim.live || sim.stale) {
        if (sim.building) return;
        sim.building = true; sim.rate.clear();
        clothPort.postMessage({ kind: "build", ...garmentNow(), run: true });
        simPost();
    } else clothPort.postMessage({ kind: "run" });
}

// Pin and drag on the cloth: `phase` down / move / up, x y in device pixels. A press picks the
// cloth and takes the nearest sim vertex of the piece hit.
let pressId = 0;
async function tool3d(data) {
    if (data.phase === "down") {
        const press = ++pressId;
        dragging = null;
        if (!sim.live) { post({ kind: "status", text: "Simulate first: pins and drags act on the cloth" }); return; }
        const p = await viewer.pick(0, data.x - (rects?.[0]?.[0] ?? 0), data.y - (rects?.[0]?.[1] ?? 0));
        const hit = p && sim.meshes.find((m) => m.item === p.item);
        if (!hit || !p.point || !sim.positions) { post({ kind: "status", text: "not on the cloth" }); return; }
        const vertex = nearestVertex(sim.positions, p.point, hit.verts);
        if (data.tool === "pin") { clothPort.postMessage({ kind: "pin", vertex }); return; }
        if (press !== pressId) {                   // a drag let go before the pick came back: say so
            post({ kind: "status", text: "let go before the cloth answered: hold the press a moment, then drag" });
            return;
        }
        const start = Array.from(sim.positions.subarray(3 * vertex, 3 * vertex + 3));
        const basis = dragBasis(viewer.camera(0), start, rects?.[0]?.[3] ?? canvasRef?.height ?? 800);
        if (!basis) { post({ kind: "status", text: "dragging needs the orbit camera" }); return; }
        dragging = { vertex, start, x: data.x, y: data.y, basis };
        clothPort.postMessage({ kind: "drag", vertex, target: start });
        post({ kind: "status", text: sim.running ? "dragging the cloth" : "paused: the drag acts when the cloth runs" });
    } else if (data.phase === "move" && dragging) {
        const d = dragging;
        clothPort.postMessage({ kind: "drag", vertex: d.vertex, target: dragTarget(d.start, d.basis, data.x - d.x, data.y - d.y) });
    } else if (data.phase === "up") {
        pressId++;
        if (dragging) clothPort.postMessage({ kind: "drag", vertex: dragging.vertex, target: null });
        dragging = null;
    }
}

// `seq` echoes the request's own `seq`, so the page knows which change a `doc` answers.
// A live cloth hears every change: it re-meshes what an outline edit touched, or goes stale.
function changed(seq) {
    post({ kind: "doc", seq: seq ?? null, ...doc() });
    refresh3d();
    refresh2d();
    if (!atelier.previewing) lastSaved = null;
    if (sim.live && clothPort) clothPort.postMessage({ kind: "update", ...garmentNow() });
}

async function loadAvatar(bytes, name) {
    const v = viewer;
    // read and show first: a bad file keeps the avatar already there, and frees what it made
    const scene = open(new Uint8Array(bytes), "step", undefined, "native");
    let b, id;
    try {
        b = sceneBox(scene.vertices(), scene.origin());
        id = v.showScene(scene);
    } catch (e) { scene.free(); throw e; }
    if (avatar) { v.remove(avatar.id); avatar.scene.free(); }
    avatar = { scene, id, bounds: b, name };
    try {
        avatarCollider = avatarMesh(scene.vertices(), scene.origin(), scene.indices());
        clothPort?.postMessage({ kind: "avatar", avatar: avatarCollider });
        if (sim.live) { sim.stale = "the avatar changed"; simPost(); }
    } catch (e) { post({ kind: "error", text: `avatar collider: ${e.message ?? e}` }); }
    if (rects) frame3d();
    post({ kind: "avatar", name, bounds: b });
    if (atelier) refresh3d();
}

// A transform/mirror request answers with the new outline path; the document is not changed.
function answer(data, make) {
    try { post({ kind: "path", reqId: data.reqId, path: make() }); }
    catch (e) { post({ kind: "error", reqId: data.reqId, text: String(e && e.message ? e.message : e) }); }
}

// The messages that change the document; each answers with `doc` (see changed()).
const CHANGES = new Set(["ops", "preview", "endPreview", "undo", "redo", "open", "new", "importDxf", "cut", "trace", "fillet"]);

self.onmessage = async ({ data }) => {
    try {
        if (data.cadaclysm) return;      // forwarded input: receiveControls hears it
        if (data.kind === "clothPort") { clothPort = data.port; clothPort.onmessage = onCloth; return; }
        if (data.kind === "canvas") {
            canvasRef = data.canvas;
            try {
                viewer = await createViewer(data.canvas);
                atelier = new Atelier(await ready);
                startedResolve();
            } catch (e) { startedReject(e); throw e; }
            try {
                const r = await fetch(new URL("./assets/f-M.stp", import.meta.url));
                if (r.ok) await loadAvatar(await r.arrayBuffer(), "f-M");
            } catch (e) { post({ kind: "error", text: `avatar: ${e.message ?? e}` }); }
            post({ kind: "ready", backend: viewer.backend, version: version(), license: licenseInfo() });
            changed();
            return;
        }
        await started;
        switch (data.kind) {
            // a hole added too small for its allowance is kept, with a word on the status line
            case "ops": {
                const cutless = atelier.cutlessHoles();
                atelier.apply(data.ops, data.message);
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
                const r = atelier.cutOps(data.id, data.cutter, { sew: data.sew, consume: data.consume });
                atelier.apply(r.ops, data.sew ? "cut & sew" : "cut");
                changed(data.seq);
                const notes = [];
                if (r.dropped.length) notes.push(`dropped seam${r.dropped.length === 1 ? "" : "s"} ${r.dropped.join(", ")}: the cut split its range`);
                if (r.collapsed) notes.push("the per-side allowance is now one width");
                post({ kind: "status", text: [data.sew ? "cut and sewn" : "cut", ...notes].join("; ") });
                break;
            }
            // a trace: one batch; a refusal changes nothing and says why (the error)
            case "trace": atelier.apply(atelier.traceOps(data.id, data.index), "trace"); changed(data.seq); break;
            // a fillet: one batch with its seams re-anchored; a refusal changes nothing and says why
            case "fillet": atelier.commit(atelier.filletOps(data.id, data.corner, data.radius), "fillet", data.id); changed(data.seq); break;
            case "undo": { const did = atelier.undo(); changed(data.seq); if (!did) post({ kind: "status", text: "nothing to undo" }); break; }
            case "redo": atelier.redo(); changed(data.seq); break;
            case "transform": answer(data, () => atelier.transformed(data.id, data.matrix)); break;
            case "mirror": answer(data, () => atelier.mirrored(data.id, data.axis)); break;
            case "ellipse": answer(data, () => atelier.ellipsePath(data.cx, data.cy, data.rx, data.ry)); break;
            case "transformAll": answer(data, () => Object.fromEntries(data.ids.map((id) => [id, atelier.transformed(id, data.matrix)]))); break;
            case "pickRect": answer(data, () => (rects && items2d ? boxSelect(data) : { indices: [], ids: [] })); break;
            case "save": post({ kind: "saved", text: atelier.save() }); break;
            // an opened garment is framed with the avatar: its pieces may stand beyond the form
            case "open": atelier.load(data.text); changed(data.seq); if (rects) frame3d(); break;
            case "new": atelier.reset(data.ops); changed(data.seq); break;
            case "importDxf": atelier.apply(atelier.fromDxf(data.text, data.fabric), "import"); changed(data.seq); break;
            case "exportDxf": post({ kind: "dxf", text: atelier.toDxf() }); break;
            case "avatar": await loadAvatar(data.bytes, data.name); break;
            case "select": selection = data.selection ?? null; pointSel = []; paintSelection(); refresh2d(); break;
            case "pick3d": {
                const p = await viewer.pick(0, data.x - (rects?.[0]?.[0] ?? 0), data.y - (rects?.[0]?.[1] ?? 0));
                post({ kind: "picked", seq: data.seq ?? null, selection: p ? items.resolve(p.item) : null });
                break;
            }
            case "resize": viewer.resize?.(data.width, data.height, data.dpr); break;
            case "sim": simCommand(data.action); break;
            case "tool3d": await tool3d(data); break;
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
                overlay2d?.set({ lines: data.lines ?? [], points: data.points ?? [], curves, text: data.text ?? null });
                break;
            }
            case "pointSel": pointSel = data.indices ?? []; refresh2d(); break;
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
