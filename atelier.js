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
import { SLOTS, slotFields, fabricColours } from "./arrange.js";
import { fieldsFor, opsFor, validate } from "./props.js";

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
let heldOps = [];             // reanchor ops waiting for the open preview to end
let selSeq = 0;               // bumped by every selection change; a `picked` older than it is dropped
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
    selSeq++;
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

// ---- the property panel: fields from props.js, each edit one ops batch ----------------------
// Parsed from the text a field holds; NaN / blank is caught by validate().
const parseField = (f, raw) => {
    if (f.type === "number") return raw.trim() === "" ? NaN : Number(raw);
    if (f.type === "numbers") return raw.split(/[\s,;]+/).filter(Boolean).map(Number);
    return raw;
};
const showNumber = (v) => (typeof v === "number" && !Number.isInteger(v) ? String(Number(v.toPrecision(7))) : String(v));
const TITLES = { pattern: "Pattern", seam: "Seam", fabric: "Fabric", avatar: "Avatar" };
function commitField(f, raw) {
    if (!selection) return;
    const value = f.type === "text" ? raw.trim() : parseField(f, raw);
    const err = validate(selection, nodes, f.key, value);
    if (err) { status(err, true); renderProps(); return; }
    try {
        const ops = opsFor(selection, nodes, f.key, value, { avatarBounds: avatar?.bounds, drawings });
        if (ops.length) change("ops", { ops, message: `set ${f.key}` });
        status(`${f.label}: set`);
    } catch (e) { status(e.message ?? String(e), true); renderProps(); }
}
function fieldRow(f) {
    const dt = document.createElement("dt");
    dt.textContent = f.unit ? `${f.label} (${f.unit})` : f.label;
    const dd = document.createElement("dd");
    let input;
    if (f.type === "readonly") dd.textContent = String(f.value);
    else if (f.type === "action") {
        input = document.createElement("button");
        input.textContent = f.label;
        input.addEventListener("click", () => (f.key === "load" ? menu.avatar() : commitField(f, "")));
        dt.textContent = "";
    } else if (f.type === "select") {
        input = document.createElement("select");
        const opts = f.options.slice();
        if (!opts.some((o) => o.value === f.value)) opts.unshift({ value: f.value, label: f.value === "" ? "choose…" : `(${f.value})` });
        for (const o of opts) { const e = document.createElement("option"); e.value = o.value; e.textContent = o.label; input.append(e); }
        input.value = f.value;
        input.addEventListener("change", () => commitField(f, input.value));
    } else {
        input = document.createElement("input");
        input.type = "text";
        input.value = f.type === "numbers" ? f.value.map(showNumber).join(", ") : f.type === "number" ? showNumber(f.value) : String(f.value);
        input.addEventListener("change", () => commitField(f, input.value));
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
    }
    if (input) {
        input.dataset.key = f.key; dd.append(input);
        input.addEventListener("keydown", (e) => { if (e.key === "Tab") tabFrom = { key: f.key, dir: e.shiftKey ? -1 : 1, t: performance.now() }; });
    }
    return [dt, dd];
}
let tabFrom = null;       // the field a Tab key left: its commit may rebuild the panel before the focus lands
function renderProps() {
    const el = $("props");
    // keep the focus across the rebuild: the field that has it, or the one a Tab was heading to
    let focusKey = document.activeElement?.closest?.("#props") ? document.activeElement.dataset?.key ?? null : null;
    const tab = tabFrom && performance.now() - tabFrom.t < 500 ? tabFrom : null;
    tabFrom = null;
    const n = selection && selection.kind !== "avatar" ? nodes.find((x) => x.id === selection.id) : null;
    const fields = selection && (selection.kind === "avatar" || n) ? fieldsFor(selection, nodes, drawings, avatar) : [];
    if (!fields.length) { el.innerHTML = '<p class="dim">Nothing selected</p>'; return; }
    const h = document.createElement("h3");
    h.textContent = `${TITLES[selection.kind]} ${selection.kind === "avatar" ? "" : n.label ?? n.id}`.trim();
    const dl = document.createElement("dl");
    for (const f of fields) dl.append(...fieldRow(f));
    const kids = [h, dl];
    if (selection.kind === "pattern") {
        const d = drawings.get(selection.id);
        if (d) { const p = document.createElement("p"); p.className = "dim"; p.textContent = `${Math.max(d.sides.length - 1, 0)} sides, size ${(d.bounds[2] - d.bounds[0]).toFixed(0)} × ${(d.bounds[3] - d.bounds[1]).toFixed(0)} mm`; kids.push(p); }
    }
    el.replaceChildren(...kids);
    const inputs = [...el.querySelectorAll("[data-key]")];
    if (!focusKey && tab) { const i = inputs.findIndex((x) => x.dataset.key === tab.key); focusKey = inputs[i + tab.dir]?.dataset.key ?? null; }
    const target = focusKey && inputs.find((x) => x.dataset.key === focusKey);
    if (target) { target.focus(); target.select?.(); }
}

// ---- the fabric library: a preset added to the document ----------------------------------
{
    const sel = $("lib-select");
    for (const p of PRESETS) { const o = document.createElement("option"); o.value = p.slug; o.textContent = p.label; sel.append(o); }
    $("lib-add").addEventListener("click", () => {
        const p = PRESETS.find((x) => x.slug === sel.value);
        const r = model.addFabric(nodes, p.slug, p.label, presetParams(p.slug));
        if (!r.ops.length || fabricNodes().some((f) => f.label === p.label)) { status(`"${p.label}" is already in the document`, true); return; }
        pickedFabric = r.id;
        change("ops", { ops: r.ops, message: "add fabric" });
        setSelection({ kind: "fabric", id: r.id });
    });
}

// ---- tools --------------------------------------------------------------------------------
function freshTool() {
    const ctx = {
        nodes, drawings, request,
        get fabric() { return currentFabric(); },
        get selection() { return selection; },
        get pxToWorld() { return 1 / cam.scale; },
    };
    tool = makeTool(toolName, ctx);
    toolStale = false;
}
function setTool(name) {
    toolName = name;
    for (const b of document.querySelectorAll("[data-tool]")) b.classList.toggle("on", b.dataset.tool === name);
    cancelPreview();
    overlay = null;
    freshTool();
    draw2d();
}

// Tool results are handled strictly in the order the tool gave them: each waits for the last.
// A failure is reported and the queue goes on: the next result (an endPreview, say) is never lost.
let queue = Promise.resolve();
const toolFailed = (e) => status(`tool: ${e?.message ?? e}`, true);
function apply(result) {
    queue = queue.then(() => result).then(handle).catch(toolFailed);
}
// Reanchor ops held while a preview was open go out once it has ended.
function flushHeld() {
    if (previewing || !heldOps.length) return;
    const ops = heldOps; heldOps = [];
    change("ops", { ops, message: "re-anchor seams" });
}
// End an open preview without committing it.
function cancelPreview() {
    if (previewing) change("endPreview", { commit: false });
    previewing = false; previewPattern = null;
    flushHeld();
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
        flushHeld();
    }
    if (r.cancel) cancelPreview();
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
    else if (name === "undo") { cancelPreview(); change("undo"); }
    else if (name === "redo") { cancelPreview(); change("redo"); }
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
        ops.push(...model.setPattern(nodes, id, slotFields(n, slot, avatar.bounds, d.bounds)));
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
// The pointer taken away mid-drag: the preview is dropped and the gesture starts over.
function dragLost() {
    pan = null; c2.classList.remove("panning");
    if (!drag2d) return;
    drag2d = false;
    queue = queue.then(() => { cancelPreview(); overlay = null; freshTool(); draw2d(); }).catch(toolFailed);
}
c2.addEventListener("pointercancel", dragLost);
c2.addEventListener("lostpointercapture", dragLost);
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
    if (moved < CLICK_PX) { const dpr = devicePixelRatio || 1; post({ kind: "pick3d", x: e.offsetX * dpr, y: e.offsetY * dpr, seq: selSeq }); }
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
    const sc = toolOfKey(e);
    if (sc && (sc.command === "save" || sc.command === "open")) { e.preventDefault(); command(sc.command); return; }
    if (e.target.closest?.("input, textarea, select, [contenteditable]")) return;
    if (sc?.command && (e.ctrlKey || e.metaKey || e.key === "F2" || e.key === "F3")) { e.preventDefault(); command(sc.command); return; }
    if (e.target === c3) return;     // the 3D window's keys are the View's
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === " ") { space = true; e.preventDefault(); return; }
    if (e.key === "Escape") {
        // the tool hears it first (a drag cancels), then back to edit
        if (tool) apply(tool.key("Escape"));
        queue = queue.then(() => { if (toolName !== "edit") setTool("edit"); overlay = null; draw2d(); }).catch(toolFailed);
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

// ---- the file menu ------------------------------------------------------------------------
// One hidden file input: the pending action says what the picked file is for.
let fileWants = null;
const fileIn = $("file-in");
function pickFile(accept, then) { fileWants = then; fileIn.accept = accept; fileIn.value = ""; fileIn.click(); }
fileIn.addEventListener("change", async () => {
    const f = fileIn.files?.[0], then = fileWants;
    fileWants = null;
    if (!f || !then) return;
    try { await then(f); } catch (e) { status(`${f.name}: ${e?.message ?? e}`, true); }
});
// A Blob, an object URL and a temporary link: the browser's download.
function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}
const menu = {
    new() { cancelPreview(); fitNext = true; setSelection(null); change("new", { ops: newDocumentOps() }); },
    // the sample garment beside the page: a T-shirt (tools/make-sample.mjs writes it)
    async sample() {
        const r = await fetch(new URL("./assets/tshirt.json", import.meta.url));
        if (!r.ok) throw new Error(`the sample: ${r.status} ${r.statusText}`);
        const text = await r.text();
        cancelPreview(); fitNext = true; setSelection(null);
        change("open", { text });
        status("opened the sample: a T-shirt");
    },
    open() { pickFile(".json,application/json", async (f) => { const text = await f.text(); cancelPreview(); fitNext = true; change("open", { text }); }); },
    save() { document.activeElement?.blur(); cancelPreview(); post({ kind: "save" }); },
    importDxf() { pickFile(".dxf", async (f) => { const text = await f.text(); cancelPreview(); fitNext = true; change("importDxf", { text }); }); },
    exportDxf() { document.activeElement?.blur(); post({ kind: "exportDxf" }); },
    avatar() {
        pickFile(".stp,.step", async (f) => {
            if (/\.stl$/i.test(f.name)) { status("STL avatars need the kernel's STL reader; use STEP for now", true); return; }
            const bytes = await f.arrayBuffer();
            post({ kind: "avatar", bytes, name: f.name.replace(/\.[^.]+$/, "") }, [bytes]);
        });
    },
};
$("menu-new").addEventListener("click", () => menu.new());
$("menu-sample").addEventListener("click", () => menu.sample().catch((e) => status(e?.message ?? String(e), true)));
$("menu-open").addEventListener("click", () => menu.open());
$("menu-save").addEventListener("click", () => menu.save());
$("menu-import-dxf").addEventListener("click", () => menu.importDxf());
$("menu-export-dxf").addEventListener("click", () => menu.exportDxf());
$("menu-avatar").addEventListener("click", () => menu.avatar());

// ---- the worker's answers -----------------------------------------------------------------
// The worker failed outright: nothing pending will be answered.
function workerFailed(text) {
    for (const w of waiting.values()) w.reject(new Error(text));
    waiting.clear();
    previewing = false; previewPattern = null; pendingReanchor = null; heldOps = [];
    status(text, true);
}
worker.onerror = (e) => { e.preventDefault?.(); workerFailed(`worker: ${e.message || "failed"}`); };
worker.onmessageerror = () => workerFailed("worker: a message could not be read");

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
        case "picked": if (m.seq === selSeq) setSelection(m.selection); break;   // else the selection moved on since
        case "path": waiting.get(m.reqId)?.resolve(m.path); waiting.delete(m.reqId); break;
        case "saved": download("garment.json", m.text, "application/json"); status(`saved garment.json: ${(m.text.length / 1024).toFixed(1)} KB`); break;
        case "dxf": download("garment.dxf", m.text, "application/dxf"); status(`saved garment.dxf: ${(m.text.length / 1024).toFixed(1)} KB`); break;
        case "error":
            if (m.reqId == null) fitNext = false;
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
        if (r.ops.length) { heldOps.push(...r.ops); flushHeld(); }
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
