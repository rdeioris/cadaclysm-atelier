// The Atelier page: the 3D window (a View in the worker), the 2D pattern window, the tool
// strips, the object browser and the one selection they share. Every edit goes to the worker
// as ops; the worker answers each change with `doc`, which replaces the page's copy of the
// garment. No geometry here: the 2D window draws what the kernel sampled.
import { forwardControls } from "./pkg/view.js";
import * as model from "./model.js";
import { PRESETS, presetParams } from "./fabrics.js";
import { Camera, hitTest, draw } from "./view2d.js";
import { makeTool } from "./tools.js";
import { reanchor, seamColour } from "./sewing.js";
import { toolOfKey } from "./shortcuts.js";
import { SLOTS, slotFrame, fabricColours } from "./arrange.js";

const $ = (id) => document.getElementById(id);
const HIT_PX = 6;            // screen pixels: how near a point/edge a click picks it
const CLICK_PX = 4;          // less pointer travel than this is a click, not a drag
const SPLIT_KEY = "atelier.split";
const DEFAULT_FABRIC = "cotton_jersey";

// ---- state --------------------------------------------------------------------------------
let nodes = [], drawingList = [], drawings = new Map(), seams = [], issues = [];
let selection = null;         // {kind: "pattern"|"seam"|"fabric"|"avatar", id}
let avatar = null;            // {name, bounds}
let pickedFabric = null;      // the fabric new pieces get, when the user chose one
let hover = null, overlay = null;
let toolName = "edit", tool = null, toolStale = false;
let previewing = false, previewPattern = null, pendingReanchor = null;
let seq = 0;                  // the `seq` of the last doc-changing message sent
let fitNext = false;

const worker = new Worker(new URL("./atelier-worker.js", import.meta.url), { type: "module" });
const post = (msg, transfer) => worker.postMessage(msg, transfer ?? []);
// A message that changes the document: it carries a `seq` the worker's `doc` echoes.
const change = (kind, payload = {}) => { const s = ++seq; post({ kind, ...payload, seq: s }); return s; };

// transform / mirror: the worker answers `path {reqId}` or `error {reqId}`
let nextReq = 0;
const waiting = new Map();
function request(kind, payload) {
    const reqId = ++nextReq;
    return new Promise((resolve, reject) => { waiting.set(reqId, { resolve, reject }); post({ kind, reqId, ...payload }); });
}

const fabricNodes = () => nodes.filter((n) => n.kind === "garment.fabric");
const currentFabric = () => (pickedFabric && fabricNodes().some((f) => f.id === pickedFabric) ? pickedFabric : fabricNodes()[0]?.id);
const newDocumentOps = () => {
    const p = PRESETS.find((x) => x.slug === DEFAULT_FABRIC);
    return model.newDocumentOps({ slug: p.slug, label: p.label, params: presetParams(p.slug) });
};

// ---- status -------------------------------------------------------------------------------
function status(text, error = false) {
    const el = $("status-text");
    el.textContent = text;
    el.classList.toggle("error", error);
}
function renderIssues() {
    const el = $("issues");
    el.replaceChildren();
    if (!issues.length) return;
    el.append(`${issues.length} issue${issues.length === 1 ? "" : "s"}`);
    const ul = document.createElement("ul");
    for (const i of issues) { const li = document.createElement("li"); li.textContent = i.message ?? `${i.kind}`; ul.append(li); }
    el.append(ul);
}

// ---- selection ----------------------------------------------------------------------------
function exists(sel) {
    if (!sel) return true;
    if (sel.kind === "avatar") return !!avatar;
    return nodes.some((n) => n.id === sel.id);
}
function setSelection(sel) {
    selection = sel ? { kind: sel.kind, id: sel.id } : null;
    if (selection?.kind === "fabric") pickedFabric = selection.id;
    post({ kind: "select", selection });
    markBrowser();
    renderProps();
    draw2d();
}

// ---- the object browser -------------------------------------------------------------------
function item(kind, id, text, extra) {
    const li = document.createElement("li");
    li.dataset.kind = kind; li.dataset.id = id;
    if (extra) li.append(extra);
    li.append(text);
    return li;
}
function swatch(colour) { const s = document.createElement("span"); s.className = "swatch"; s.style.background = colour; return s; }
function empty(text) { const li = document.createElement("li"); li.className = "empty"; li.textContent = text; return li; }
function renderBrowser() {
    const colours = fabricColours(nodes);
    const fabrics = fabricNodes();
    $("browser-fabrics").replaceChildren(...(fabrics.length ? fabrics.map((f) => item("fabric", f.id, f.label ?? f.id, swatch(colours.get(f.id)))) : [empty("none")]));
    const byId = model.byId(nodes);
    const patterns = byId.get("garment")?.patterns ?? [];
    $("browser-patterns").replaceChildren(...(patterns.length
        ? patterns.map((id) => item("pattern", id, byId.get(id)?.label ?? id, swatch(colours.get(byId.get(id)?.fabric) ?? "#cccccc")))
        : [empty("draw one in 2D")]));
    $("browser-seams").replaceChildren(...(seams.length
        ? seams.map((s, i) => item("seam", s.id, `${i + 1}: ${byId.get(s.a)?.label ?? s.a} – ${byId.get(s.b)?.label ?? s.b}`, swatch(seamColour(i))))
        : [empty("none")]));
    $("browser-avatar").replaceChildren(avatar ? item("avatar", "avatar", avatar.name) : empty("none"));
    markBrowser();
}
function markBrowser() {
    const cur = currentFabric();
    for (const li of $("browser").querySelectorAll("li[data-kind]")) {
        li.classList.toggle("on", !!selection && li.dataset.kind === selection.kind && li.dataset.id === selection.id);
        li.classList.toggle("current", li.dataset.kind === "fabric" && li.dataset.id === cur);
    }
}
$("browser").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-kind]");
    if (li) setSelection({ kind: li.dataset.kind, id: li.dataset.id });
});

// ---- the property panel: a read-only summary until the editor (Task 10) -------------------
const fmt = (v) => (typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : Array.isArray(v) ? v.map(fmt).join(", ") : String(v));
function renderProps() {
    const el = $("props");
    const rows = [];
    let title = "";
    if (!selection) { el.innerHTML = '<p class="dim">Nothing selected</p>'; return; }
    if (selection.kind === "avatar") {
        title = "Avatar";
        if (avatar) { rows.push(["name", avatar.name]); rows.push(["size", [0, 1, 2].map((i) => (avatar.bounds[i + 3] - avatar.bounds[i]).toFixed(0)).join(" × ") + " mm"]); }
    } else {
        const n = nodes.find((x) => x.id === selection.id);
        if (!n) { el.innerHTML = '<p class="dim">Nothing selected</p>'; return; }
        if (selection.kind === "pattern") {
            title = `Pattern ${n.label ?? n.id}`;
            const d = drawings.get(n.id);
            rows.push(["fabric", model.byId(nodes).get(n.fabric)?.label ?? n.fabric ?? "—"], ["layer", n.layer ?? 0], ["allowance", `${fmt(n.allowance ?? [0])} mm`]);
            if (d) rows.push(["sides", Math.max(d.sides.length - 1, 0)], ["size", `${(d.bounds[2] - d.bounds[0]).toFixed(0)} × ${(d.bounds[3] - d.bounds[1]).toFixed(0)} mm`]);
            rows.push(["slot", n.meta?.atelier?.slot ? SLOTS[n.meta.atelier.slot]?.label ?? n.meta.atelier.slot : "floor"]);
        } else if (selection.kind === "seam") {
            const byId = model.byId(nodes);
            title = `Seam ${n.id}`;
            rows.push(["a", `${byId.get(n.a)?.label ?? n.a}  ${fmt(n.a_from)} → ${fmt(n.a_to)} mm`], ["b", `${byId.get(n.b)?.label ?? n.b}  ${fmt(n.b_from)} → ${fmt(n.b_to)} mm`], ["reversed", n.reversed ? "yes" : "no"]);
        } else if (selection.kind === "fabric") {
            title = `Fabric ${n.label ?? n.id}`;
            if (n.density != null) rows.push(["weight", `${(n.density * 1e6).toFixed(0)} g/m²`]);
            if (n.thickness != null) rows.push(["thickness", `${fmt(n.thickness)} mm`]);
            if (n.friction != null) rows.push(["friction", fmt(n.friction)]);
        }
    }
    const h = document.createElement("h3"); h.textContent = title;
    const dl = document.createElement("dl");
    for (const [k, v] of rows) { const dt = document.createElement("dt"); dt.textContent = k; const dd = document.createElement("dd"); dd.textContent = String(v); dl.append(dt, dd); }
    el.replaceChildren(h, dl);
}

// ---- tools --------------------------------------------------------------------------------
function freshTool() {
    const ctx = {
        nodes, drawings, fabric: currentFabric(), request,
        get selection() { return selection; },
        get pxToWorld() { return 1 / cam.scale; },
    };
    tool = makeTool(toolName, ctx);
    toolStale = false;
}
function setTool(name) {
    toolName = name;
    for (const b of document.querySelectorAll("[data-tool]")) b.classList.toggle("on", b.dataset.tool === name);
    if (previewing) { change("endPreview", { commit: false }); previewing = false; }
    overlay = null;
    freshTool();
    draw2d();
}

// Tool results are handled strictly in the order the tool gave them: each waits for the last.
let queue = Promise.resolve();
function apply(result) {
    queue = queue.then(() => Promise.resolve(result)).then(handle, (e) => status(`tool: ${e.message ?? e}`, true));
}
function patternOfOps(ops) {
    const o = ops.find((x) => typeof x.id === "string" && x.id.endsWith("_outline"));
    return o ? o.id.slice(0, -"_outline".length) : null;
}
function handle(r) {
    if (!r) return;
    if (r.ops?.length) change("ops", { ops: r.ops });
    if (r.preview) { previewing = true; previewPattern = patternOfOps(r.preview) ?? previewPattern; change("preview", { ops: r.preview }); }
    if (r.endPreview) {
        const s = change("endPreview", { commit: true });
        previewing = false;
        if (previewPattern) pendingReanchor = { seq: s, id: previewPattern };
        previewPattern = null;
    }
    if (r.cancel) { if (previewing) change("endPreview", { commit: false }); previewing = false; previewPattern = null; }
    if (r.overlay) overlay = r.overlay.lines?.length || r.overlay.points?.length ? r.overlay : null;
    if (r.select !== undefined) setSelection(r.select);
    if (r.done) setTool("edit");
    else if (toolStale && !previewing && !drag2d) freshTool();
    draw2d();
}

for (const b of document.querySelectorAll("[data-tool]")) b.addEventListener("click", () => setTool(b.dataset.tool));
for (const b of document.querySelectorAll("[data-command]")) b.addEventListener("click", () => command(b.dataset.command));

function command(name) {
    if (name === "fit") fit2d();
    else if (name === "arrange") arrange();
    else if (name === "undo") change("undo");
    else if (name === "redo") change("redo");
    else if (name === "save") menu.save();
    else if (name === "open") menu.open();
    else if (name === "maximise2d") maximise("max2d");
    else if (name === "maximise3d") maximise("max3d");
}

// Arrange: each piece not yet placed goes to the next free slot around the avatar.
function arrange() {
    if (!avatar) { status("no avatar to arrange around"); return; }
    const byId = model.byId(nodes);
    const patterns = byId.get("garment")?.patterns ?? [];
    const taken = new Set(patterns.map((id) => byId.get(id)?.meta?.atelier?.slot).filter(Boolean));
    const free = Object.keys(SLOTS).filter((s) => !taken.has(s));
    const ops = [];
    for (const id of patterns) {
        const n = byId.get(id), d = drawings.get(id);
        if (n.meta?.atelier?.slot || !d || !free.length) continue;
        const slot = free.shift();
        const meta = { ...(n.meta ?? {}), atelier: { ...(n.meta?.atelier ?? {}), slot } };
        ops.push(...model.setPattern(nodes, id, { frame: slotFrame(slot, avatar.bounds, d.bounds), meta }));
    }
    if (ops.length) change("ops", { ops, message: "arrange" });
    else status(patterns.length ? "every piece is arranged" : "no pieces to arrange");
}

// ---- the 2D window ------------------------------------------------------------------------
const c2 = $("view2d"), g2 = c2.getContext("2d");
const cam = new Camera(c2.clientWidth || 1, c2.clientHeight || 1);
let fitted = false;
function draw2d() {
    const dpr = devicePixelRatio || 1;
    g2.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(g2, cam, { drawings: drawingList, seams, selection, hover, nodes, overlay });
}
function resize2d() {
    const w = c2.clientWidth, h = c2.clientHeight, dpr = devicePixelRatio || 1;
    if (!w || !h) return;
    c2.width = Math.round(w * dpr); c2.height = Math.round(h * dpr);
    cam.resize(w, h);
    if (!fitted) { fitted = true; fit2d(); } else draw2d();
}
function fit2d() {
    let b = null;
    for (const d of drawingList) {
        if (!d.bounds) continue;
        b = b ? [Math.min(b[0], d.bounds[0]), Math.min(b[1], d.bounds[1]), Math.max(b[2], d.bounds[2]), Math.max(b[3], d.bounds[3])] : [...d.bounds];
    }
    cam.fit(b ?? [-100, -100, 900, 900]);
    draw2d();
}
new ResizeObserver(resize2d).observe(c2);

const local = (e) => { const r = c2.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
const selectedPattern = () => (selection?.kind === "pattern" ? selection.id : null);
const hitAt = (world) => hitTest(drawingList, seams, world, HIT_PX, cam, nodes, selectedPattern());
const mods = (e, extra = {}) => ({ shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey, ...extra });
let space = false, pan = null, drag2d = false, lastUp = null;

c2.addEventListener("pointerdown", (e) => {
    c2.focus();
    const p = local(e);
    if (e.button === 1 || (e.button === 0 && space)) {
        e.preventDefault();
        pan = p; c2.setPointerCapture(e.pointerId); c2.classList.add("panning");
        return;
    }
    if (e.button !== 0 || !tool) return;
    c2.setPointerCapture(e.pointerId);
    drag2d = true;
    const w = cam.toWorld(p);
    apply(tool.down(w, hitAt(w), mods(e)));
});
c2.addEventListener("pointermove", (e) => {
    const p = local(e);
    if (pan) { cam.pan(p[0] - pan[0], p[1] - pan[1]); pan = p; draw2d(); return; }
    const w = cam.toWorld(p);
    const h = hitAt(w);
    if (!drag2d) {
        const was = hover;
        hover = h && h.id ? h : null;
        if ((was?.id ?? null) !== (hover?.id ?? null)) draw2d();
    }
    if (tool) apply(tool.move(w, h, mods(e)));
});
c2.addEventListener("pointerup", (e) => {
    const p = local(e);
    if (pan) { pan = null; c2.classList.remove("panning"); return; }
    if (e.button !== 0 || !drag2d) return;
    drag2d = false;
    // pointerup's own `detail` is 0 in Chrome: count the clicks here
    const now = performance.now();
    const detail = lastUp && now - lastUp.t < 400 && Math.hypot(p[0] - lastUp.p[0], p[1] - lastUp.p[1]) < CLICK_PX ? lastUp.detail + 1 : 1;
    lastUp = { t: now, p, detail };
    const w = cam.toWorld(p);
    if (tool) apply(tool.up(w, hitAt(w), mods(e, { detail, dblclick: detail === 2 })));
});
c2.addEventListener("pointercancel", () => { pan = null; drag2d = false; c2.classList.remove("panning"); });
c2.addEventListener("pointerleave", () => { if (hover && !drag2d) { hover = null; draw2d(); } });
c2.addEventListener("wheel", (e) => {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    cam.zoomAt(local(e), Math.exp(-e.deltaY * unit * 0.0015));
    draw2d();
}, { passive: false });
c2.addEventListener("auxclick", (e) => e.preventDefault());
c2.addEventListener("contextmenu", (e) => e.preventDefault());

// ---- the 3D window: the canvas is the worker's View --------------------------------------
const c3 = $("view3d");
{
    const dpr = devicePixelRatio || 1;
    c3.width = Math.max(1, Math.round(c3.clientWidth * dpr));
    c3.height = Math.max(1, Math.round(c3.clientHeight * dpr));
    const off = c3.transferControlToOffscreen();
    post({ kind: "canvas", canvas: off }, [off]);
    forwardControls(c3, worker);
}
// A click without a drag picks.
let down3d = null;
c3.addEventListener("pointerdown", (e) => { if (e.button === 0) down3d = [e.offsetX, e.offsetY]; });
c3.addEventListener("pointerup", (e) => {
    if (e.button !== 0 || !down3d) return;
    const moved = Math.hypot(e.offsetX - down3d[0], e.offsetY - down3d[1]);
    down3d = null;
    if (moved < CLICK_PX) { const dpr = devicePixelRatio || 1; post({ kind: "pick3d", x: e.offsetX * dpr, y: e.offsetY * dpr }); }
});

// ---- layout: the divider, F2 / F3 ---------------------------------------------------------
const split = $("split");
function setShare(pct) {
    const s = Math.min(85, Math.max(15, pct));
    split.style.setProperty("--share", String(s));
    return s;
}
try { const v = Number(localStorage.getItem(SPLIT_KEY)); if (v) setShare(v); } catch { /* no storage: the default split */ }
function maximise(cls) {
    const on = !split.classList.contains(cls);
    split.classList.remove("max2d", "max3d");
    if (on) split.classList.add(cls);
}
{
    const div = $("divider");
    let dragging = false;
    div.addEventListener("pointerdown", (e) => { dragging = true; div.setPointerCapture(e.pointerId); div.classList.add("drag"); e.preventDefault(); });
    div.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const r = split.getBoundingClientRect(), dock = $("dock").getBoundingClientRect().width;
        const s = setShare(((e.clientX - r.left) / Math.max(r.width - dock - div.offsetWidth, 1)) * 100);
        try { localStorage.setItem(SPLIT_KEY, String(s)); } catch { /* not kept */ }
    });
    const end = () => { dragging = false; div.classList.remove("drag"); };
    div.addEventListener("pointerup", end);
    div.addEventListener("pointercancel", end);
}
// The 3D canvas follows through forwardControls' own resize; the worker's `resize` is sent too
// so the View's drawing size changes in the same frame as the layout.
new ResizeObserver(() => {
    const w = c3.clientWidth, h = c3.clientHeight;
    if (w > 0 && h > 0) post({ kind: "resize", width: w, height: h, dpr: devicePixelRatio || 1 });
}).observe(c3);

// ---- keys ---------------------------------------------------------------------------------
document.addEventListener("keydown", (e) => {
    if (e.target.closest?.("input, textarea, select, [contenteditable]")) return;
    const sc = toolOfKey(e);
    if (sc?.command && (e.ctrlKey || e.metaKey || e.key === "F2" || e.key === "F3")) { e.preventDefault(); command(sc.command); return; }
    if (e.target === c3) return;     // the 3D window's keys are the View's
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === " ") { space = true; e.preventDefault(); return; }
    if (e.key === "Escape") {
        // the tool hears it first (a drag cancels), then back to edit
        if (tool) apply(tool.key("Escape"));
        queue = queue.then(() => { if (toolName !== "edit") setTool("edit"); overlay = null; draw2d(); });
        return;
    }
    if (e.key === "f" || e.key === "F") { fit2d(); return; }
    if (tool) {
        const r = tool.key(e.key);
        if (r && Object.keys(r).length) { if (e.key === "Backspace" || e.key === "Enter") e.preventDefault(); apply(r); }
    }
    if (sc?.tool) setTool(sc.tool);
});
document.addEventListener("keyup", (e) => { if (e.key === " ") space = false; });
window.addEventListener("blur", () => { space = false; });

// ---- the file menu (Task 10 finishes Save / Export downloads and the avatar formats) -----
let fileWants = null;
const fileIn = $("file-in");
function pickFile(accept, then) { fileWants = then; fileIn.accept = accept; fileIn.value = ""; fileIn.click(); }
fileIn.addEventListener("change", async () => {
    const f = fileIn.files?.[0], then = fileWants;
    fileWants = null;
    if (f && then) then(f);
});
const menu = {
    new() { fitNext = true; setSelection(null); change("new", { ops: newDocumentOps() }); },
    open() { pickFile(".json,application/json", async (f) => { fitNext = true; change("open", { text: await f.text() }); }); },
    save() { post({ kind: "save" }); },
    importDxf() { pickFile(".dxf", async (f) => { fitNext = true; change("importDxf", { text: await f.text() }); }); },
    exportDxf() { post({ kind: "exportDxf" }); },
    avatar() { pickFile(".stp,.step", async (f) => { const bytes = await f.arrayBuffer(); post({ kind: "avatar", bytes, name: f.name.replace(/\.[^.]+$/, "") }, [bytes]); }); },
};
$("menu-new").addEventListener("click", () => menu.new());
$("menu-open").addEventListener("click", () => menu.open());
$("menu-save").addEventListener("click", () => menu.save());
$("menu-import-dxf").addEventListener("click", () => menu.importDxf());
$("menu-export-dxf").addEventListener("click", () => menu.exportDxf());
$("menu-avatar").addEventListener("click", () => menu.avatar());

// ---- the worker's answers -----------------------------------------------------------------
worker.onmessage = ({ data: m }) => {
    switch (m.kind) {
        case "ready":
            $("lic").textContent = `cadaclysm ${m.version} · ${m.backend}${m.license ? ` · ${m.license}` : ""}`;
            status("ready");
            fitNext = true;
            change("new", { ops: newDocumentOps() });
            document.body.dataset.ready = "1";
            break;
        case "doc": onDoc(m); break;
        case "avatar":
            avatar = { name: m.name, bounds: m.bounds };
            renderBrowser();
            if (selection?.kind === "avatar") renderProps();
            break;
        case "picked": setSelection(m.selection); break;
        case "path": waiting.get(m.reqId)?.resolve(m.path); waiting.delete(m.reqId); break;
        case "saved": status(`saved: ${(m.text.length / 1024).toFixed(1)} KB`); break;
        case "dxf": status(`DXF written: ${(m.text.length / 1024).toFixed(1)} KB`); break;
        case "error":
            if (m.reqId != null && waiting.has(m.reqId)) { waiting.get(m.reqId).reject(new Error(m.text)); waiting.delete(m.reqId); }
            else status(m.text, true);
            break;
    }
};

function onDoc(m) {
    nodes = m.nodes; drawingList = m.drawings; seams = m.seams; issues = m.issues ?? [];
    drawings = new Map(drawingList.map((d) => [d.id, d]));
    if (!exists(selection)) { selection = null; post({ kind: "select", selection: null }); }
    if (pendingReanchor && m.seq === pendingReanchor.seq) {
        const { id } = pendingReanchor;
        pendingReanchor = null;
        const r = reanchor(nodes, drawings, id);
        if (r.ops.length) change("ops", { ops: r.ops, message: "re-anchor seams" });
        if (r.removed.length) status(`removed seam${r.removed.length === 1 ? "" : "s"} ${r.removed.join(", ")}: the side is gone`);
    }
    if (fitNext && m.seq === seq) { fitNext = false; if (drawingList.length) fit2d(); }
    // A fresh tool for the new nodes, unless a gesture (and its previews) is under way.
    if (previewing || drag2d) toolStale = true; else freshTool();
    renderBrowser();
    renderProps();
    renderIssues();
    draw2d();
}

setTool("edit");
