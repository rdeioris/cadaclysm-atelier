// The Atelier worker: it owns the cadaclysm wasm module, one Atelier (the garment document)
// and the View on the page's 3D canvas. The main thread sends edits; every change answers with
// `doc` and redraws the 3D window. No geometry is checked here: the kernel does that.
import { load, open, version, licenseInfo, View } from "./pkg/index.js";
import { receiveControls } from "./pkg/view.js";
import * as k from "./pkg/index.js";
import { Atelier } from "./kernel.js";
import { drawFrame, frame12, showSeams, isSelected, ItemMap, fabricColours, ACCENT } from "./arrange.js";

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

async function createViewer(canvas) {
    await ready;
    // the dress forms are in CLO's frame: millimetres, y up, facing +z
    const v = await View.create(canvas, { upAxis: "y", background: "#1e2024", grid: { step: 100 } });
    receiveControls(v);
    v.start();
    return v;
}

const post = (msg) => self.postMessage(msg);
const doc = () => ({ nodes: atelier.nodes(), drawings: atelier.drawings(), seams: atelier.seams(), issues: atelier.issues() });

const selected = (kind, id) => isSelected(selection, kind, id);

// Redraw the garment: a 1 mm slab per pattern at its frame, each seam as its own lines item.
function refresh3d() {
    if (!viewer || !atelier) return;
    for (const id of drawn) viewer.remove(id);
    drawn = []; items.clear();
    if (avatar) items.set(avatar.id, { kind: "avatar", id: "avatar" });
    const nodes = atelier.nodes();
    const colours = fabricColours(nodes);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const bounds = avatar?.bounds ?? [-200, 0, -150, 200, 1700, 150];
    const frames = new Map();
    let first = null;
    slabs.clear(); seamLines.clear();
    for (const d of atelier.drawings()) {
        const node = byId.get(d.id);
        const frame = drawFrame(node, bounds);
        frames.set(d.id, frame);
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
    first ??= error;
    if (first) post({ kind: "error", text: String(first.message ?? first) });
}

// The selection's accent on the slabs already drawn.
function paintSelection() {
    for (const [id, s] of slabs) viewer.setColour(s.item, selected("pattern", id) ? ACCENT : s.colour);
    for (const [id, s] of seamLines) viewer.setColour(s.item, selected("seam", id) ? ACCENT : s.colour);
}

// `seq` echoes the request's own `seq`, so the page knows which change a `doc` answers.
function changed(seq) {
    post({ kind: "doc", seq: seq ?? null, ...doc() });
    refresh3d();
}

// The scene's axis-aligned box (min xyz, max xyz) in the file's coordinates: its vertices are
// relative to origin(), which is added back.
function boxOf(vertices, origin) {
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = 0; i + 2 < vertices.length; i += 3)
        for (let a = 0; a < 3; a++) { const v = vertices[i + a] + origin[a]; if (v < b[a]) b[a] = v; if (v > b[a + 3]) b[a + 3] = v; }
    return b;
}

async function loadAvatar(bytes, name) {
    const v = viewer;
    // read and show first: a bad file keeps the avatar already there, and frees what it made
    const scene = open(new Uint8Array(bytes), "step", undefined, "native");
    let b, id;
    try {
        b = boxOf(scene.vertices(), scene.origin());
        id = v.showScene(scene);
    } catch (e) { scene.free(); throw e; }
    if (avatar) { v.remove(avatar.id); avatar.scene.free(); }
    avatar = { scene, id, bounds: b, name };
    v.frame();
    post({ kind: "avatar", name, bounds: b });
    if (atelier) refresh3d();
}

// A transform/mirror request answers with the new outline path; the document is not changed.
function answer(data, make) {
    try { post({ kind: "path", reqId: data.reqId, path: make() }); }
    catch (e) { post({ kind: "error", reqId: data.reqId, text: String(e && e.message ? e.message : e) }); }
}

// The messages that change the document; each answers with `doc` (see changed()).
const CHANGES = new Set(["ops", "preview", "endPreview", "undo", "redo", "open", "new", "importDxf"]);

self.onmessage = async ({ data }) => {
    try {
        if (data.cadaclysm) return;      // forwarded input: receiveControls hears it
        if (data.kind === "canvas") {
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
            case "ops": atelier.apply(data.ops, data.message); changed(data.seq); break;
            case "preview": atelier.preview(data.ops); changed(data.seq); break;
            // a committed edit re-anchors the seams of the pattern it changed, in the same commit
            case "endPreview": {
                const r = atelier.endPreview(data.commit, data.reanchor ?? null);
                changed(data.seq);
                if (r.removed.length) post({ kind: "status", text: `removed seam${r.removed.length === 1 ? "" : "s"} ${r.removed.join(", ")}: the side is gone` });
                break;
            }
            case "undo": { const did = atelier.undo(); changed(data.seq); if (!did) post({ kind: "status", text: "nothing to undo" }); break; }
            case "redo": atelier.redo(); changed(data.seq); break;
            case "transform": answer(data, () => atelier.transformed(data.id, data.matrix)); break;
            case "mirror": answer(data, () => atelier.mirrored(data.id, data.axis)); break;
            case "save": post({ kind: "saved", text: atelier.save() }); break;
            // an opened garment is framed with the avatar: its pieces may stand beyond the form
            case "open": atelier.load(data.text); changed(data.seq); viewer.frame(); break;
            case "new": atelier.reset(data.ops); changed(data.seq); break;
            case "importDxf": atelier.apply(atelier.fromDxf(data.text, data.fabric), "import"); changed(data.seq); break;
            case "exportDxf": post({ kind: "dxf", text: atelier.toDxf() }); break;
            case "avatar": await loadAvatar(data.bytes, data.name); break;
            case "select": selection = data.selection ?? null; paintSelection(); break;
            case "pick3d": {
                const p = await viewer.pick(0, data.x, data.y);
                post({ kind: "picked", seq: data.seq ?? null, selection: p ? items.resolve(p.item) : null });
                break;
            }
            case "resize": viewer.resize?.(data.width, data.height, data.dpr); break;
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
