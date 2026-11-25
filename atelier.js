// The Atelier page: one canvas, the worker's View drawing both windows (viewport 0 the 3D
// window, viewport 1 the 2D pattern window), the tool strips over them, the object browser and
// the one selection they share. Every edit goes to the worker as ops; the worker answers each
// change with `doc`, which replaces the page's copy of the garment. No geometry and no drawing
// here: the pointer router below sends 2D events to the worker, which answers each with the
// pattern point and the View's pick (`at2d`).
import { listen } from "./pkg/view.js";
import { viewportRects, viewportAt } from "./layout.js";
import * as model from "./model.js";
import { PRESETS, presetParams, presetNote } from "./fabrics.js";
import { makeTool, SNAPPING, typedPoint, typedValues, readout } from "./tools.js";
import { seamColour } from "./sewing.js";
import { toolOfKey } from "./shortcuts.js";
import { KeyHold } from "./keyhold.js";
import { arrangeSlots, fabricColours, isSelected, survivingSelection } from "./arrange.js";
import { fieldsFor, opsFor, validate, fieldText } from "./props.js";
import { giaState } from "./gpu-drape.js";
import { createFilm } from "./film.js";
import { issuesLabel, isEaseNote } from "./kernel.js";
import { FitMap, MAPS, Latest, renderLegend, valueText } from "./fitmap.js";
import { TapeTool, cmText } from "./tape3d.js";
import { CUSTOM, draftFrom, bodyCommit, isBodyKey } from "./bodypanel.js";

const $ = (id) => document.getElementById(id);
const CLICK_PX = 4;          // less pointer travel than this is a click, not a drag
const SPLIT_KEY = "atelier.split";
const DEFAULT_FABRIC = "cotton_jersey";

// ---- state --------------------------------------------------------------------------------
let nodes = [], drawingList = [], drawings = new Map(), seams = [], issues = [];
let selection = null;         // {kind: "pattern"|"seam"|"fabric"|"avatar", id, ids?}: ids a box selection
let pointSel = [];            // the selected piece's box-selected point indices (the Edit tool)
let avatar = null;            // {name, bounds, landmarks, forms}: landmarks the forms.json entry, or null
let forms = [];               // the dress forms in assets/forms.json, as the worker read them
let formLoading = null;       // the form the Form select asked for, until it lands or fails
let bodyDraft = null;         // the Body panel's draft (bodypanel.js) while "Custom form…" is open
let formAskedAt = null;       // when Build or Apply was hit: the browser test reads the time to the form shown
let pickedFabric = null;      // the fabric new pieces get, when the user chose one
let overlay = null;
let toolName = "edit", tool = null, toolStale = false;
let previewing = false, previewPattern = null;
let selSeq = 0;               // bumped by every selection change; a `picked` older than it is dropped
let seq = 0;                  // the `seq` of the last doc-changing message sent
let fitNext = false;

const worker = new Worker(new URL("./atelier-worker.js", import.meta.url), { type: "module" });
// The solver's own worker, on the CPU path (no WebGPU, or ?cloth=cpu; `ready` says which): it
// steps the cloth and streams frames to the View's worker over a channel of their own; the page
// only starts and stops it (through the View's worker). On the GPU path the View's worker steps it.
const cpuCloth = new URLSearchParams(location.search).get("cloth") === "cpu";
// ?film=1: hooks for the tutorial video's driver (film.js): Simulate builds the cloth paused and
// the driver steps it one frame at a time, capturing each.
const filmMode = new URLSearchParams(location.search).has("film");
const film = filmMode ? createFilm({
    post: (m) => post(m),
    request: (kind) => request(kind),
    nextPaint: () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
}) : null;
if (film) window.atelierFilm = film.film;
function startClothWorker() {
    const clothWorker = new Worker(new URL("./cloth-worker.js", import.meta.url), { type: "module" });
    const ch = new MessageChannel();
    clothWorker.postMessage({ kind: "port", port: ch.port1 }, [ch.port1]);
    worker.postMessage({ kind: "clothPort", port: ch.port2 }, [ch.port2]);
    clothWorker.onerror = (e) => { e.preventDefault?.(); status(`cloth worker: ${e.message || "failed"}`, true); };
}
const post = (msg, transfer) => worker.postMessage(msg, transfer ?? []);
// A message that changes the document: it carries a `seq` the worker's `doc` echoes.
const change = (kind, payload = {}) => { const s = ++seq; post({ kind, ...payload, seq: s }); return s; };

// transform / transformAll / mirror / pickRect: the worker answers `path {reqId}` or `error {reqId}`.
// A payload's own `kind` (pickRect's points or pieces) travels as `what`: `kind` is the message's.
let nextReq = 0;
const waiting = new Map();
function request(kind, payload) {
    const reqId = ++nextReq;
    const { kind: what, ...rest } = payload ?? {};
    return new Promise((resolve, reject) => { waiting.set(reqId, { resolve, reject }); post({ ...rest, ...(what !== undefined ? { what } : {}), kind, reqId }); });
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
// The size a click-placed shape asks for: [width, height] in mm, or null when cancelled.
function askSize(shape) {
    const d = $("size-dialog");
    $("size-title").textContent = `${shape === "ellipse" ? "Ellipse" : "Rectangle"}: width and height`;
    d.returnValue = "";
    d.showModal();
    $("size-w").focus(); $("size-w").select();
    return new Promise((resolve) => d.addEventListener("close", () => {
        const w = Number($("size-w").value), h = Number($("size-h").value);
        resolve(d.returnValue === "ok" && w > 0 && h > 0 ? [w, h] : null);
    }, { once: true }));
}
// Cancel is not a submit button: Enter in a field submits OK, the form's only one
$("size-cancel").addEventListener("click", () => $("size-dialog").close("cancel"));
function renderIssues() {
    const el = $("issues");
    el.replaceChildren();
    if (!issues.length) return;
    el.append(issuesLabel(issues));
    el.classList.toggle("notes", issues.every(isEaseNote));
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
    selection = sel ? { kind: sel.kind, id: sel.id, ...(sel.ids ? { ids: [...sel.ids] } : {}) } : null;
    pointSel = [];                // the worker drops its own on `select`
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
        li.classList.toggle("on", isSelected(selection, li.dataset.kind, li.dataset.id));
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
    if (f.type === "optnumber") return raw.trim() === "" ? null : Number(raw);
    if (f.type === "numbers") return raw.split(/[\s,;]+/).filter(Boolean).map(Number);
    return raw;
};
const TITLES = { pattern: "Pattern", seam: "Seam", fabric: "Fabric", avatar: "Avatar" };
function commitField(f, raw) {
    if (!selection) return;
    // a user's STEP called like a form has no landmarks: choosing that form loads the real one
    if (selection.kind === "avatar" && f.key === "form" && raw === CUSTOM) { openBody(); return; }
    if (selection.kind === "avatar" && f.key === "form") {      // a shipped pick: the Body panel closes, no rebuild over it
        bodyDraft = null; if (avatar) avatar.draft = null;
        if (avatar?.landmarks?.form) change("form", { spec: null });
    }
    if (selection.kind === "avatar" && f.key === "form") { if (raw !== avatar?.name || !avatar?.landmarks) { formLoading = raw; status(`loading ${raw}…`); post({ kind: "avatarAsset", name: raw }); } else renderProps(); return; }
    if (selection.kind === "avatar" && bodyDraft && isBodyKey(f.key)) { bodyEdit(f, raw); return; }
    const value = f.type === "text" || f.type === "colour" ? raw.trim() : parseField(f, raw);
    const err = validate(selection, nodes, f.key, value);
    if (err) { status(err, true); renderProps(); return; }
    try {
        const ops = opsFor(selection, nodes, f.key, value, { avatarBounds: avatar?.bounds, landmarks: avatar?.landmarks ?? null, drawings });
        if (ops.length) change("ops", { ops, message: f.type === "action" ? f.label.toLowerCase() : `set ${f.key}` });
        status(f.type === "action" ? f.label : `${f.label}: set`);
        // a duplicated fabric is the one selected next, for its label and colour
        if (f.key === "duplicate" && ops[0]?.op === "add") { pickedFabric = ops[0].node.id; setSelection({ kind: "fabric", id: ops[0].node.id }); }
    } catch (e) { status(e.message ?? String(e), true); renderProps(); }
}
// "Custom form…": the Body panel, its draft from the form shown (or chart f-M at Rest)
function openBody() {
    bodyDraft ??= draftFrom(avatar?.landmarks?.form ?? null);
    if (avatar) avatar.draft = bodyDraft;
    status("Custom form: set the measurements and the pose, then Build form");
    renderProps();
}
// A Body-panel edit: the draft changes; Build and Apply write the form into the document
function bodyEdit(f, raw) {
    const r = bodyCommit(bodyDraft, f.key, raw);
    bodyDraft = r.draft;
    if (avatar) avatar.draft = bodyDraft;
    if (r.error) { status(r.error, true); renderProps(); return; }
    if (r.build) { formAskedAt = performance.now(); change("form", { spec: r.build }); status("building the form…"); }
    renderProps();
}
function fieldRow(f) {
    const dt = document.createElement("dt");
    dt.textContent = f.unit ? `${f.label} (${f.unit})` : f.label;
    if (f.tip) dt.title = f.tip;
    const dd = document.createElement("dd");
    let input;
    if (f.type === "readonly") { dd.textContent = String(f.value); if (f.measured) dd.classList.add("measured"); }
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
        input.value = fieldText(f);
        if (f.placeholder) input.placeholder = f.placeholder;
        input.addEventListener("change", () => commitField(f, input.value));
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
    }
    if (f.type === "colour") dd.append(swatch(f.value));
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
        if (d) { const p = document.createElement("p"); p.className = "dim"; p.textContent = `${Math.max(d.sides.length - 1, 0)} sides${d.holes?.length ? `, ${d.holes.length} hole${d.holes.length === 1 ? "" : "s"}` : ""}, size ${(d.bounds[2] - d.bounds[0]).toFixed(0)} × ${(d.bounds[3] - d.bounds[1]).toFixed(0)} mm`; kids.push(p); }
    }
    el.replaceChildren(...kids);
    const inputs = [...el.querySelectorAll("[data-key]")];
    if (!focusKey && tab) { const i = inputs.findIndex((x) => x.dataset.key === tab.key); focusKey = inputs[i + tab.dir]?.dataset.key ?? null; }
    const target = focusKey && inputs.find((x) => x.dataset.key === focusKey);
    if (target) { target.focus(); target.select?.(); }
}

// The selected pieces (with their seams) or seam out of the document: one undo step.
function removeSelected() {
    if (!selection || (selection.kind !== "pattern" && selection.kind !== "seam") || !nodes.some((n) => n.id === selection.id)) return false;
    cancelPreview();
    const kind = selection.kind;
    const pieces = kind === "pattern" ? (selection.ids ?? [selection.id]).filter((id) => nodes.some((n) => n.id === id)) : [];
    const ops = pieces.length > 1 ? model.removePatterns(nodes, pieces) : opsFor(selection, nodes, "remove", null);
    change("ops", { ops, message: `remove ${kind === "pattern" ? (pieces.length > 1 ? "pieces" : "piece") : "seam"}` });
    status(kind === "pattern" ? (pieces.length > 1 ? `removed ${pieces.length} pieces` : "removed the piece") : "removed the seam");
    setSelection(null);
    return true;
}

// ---- the fabric library: a preset added to the document ----------------------------------
{
    const sel = $("lib-select");
    for (const p of PRESETS) { const o = document.createElement("option"); o.value = p.slug; o.textContent = p.label; o.title = presetNote(p); sel.append(o); }
    // the select's tooltip names the chosen preset's source (an estimate says so first)
    const noteSel = () => { const p = PRESETS.find((x) => x.slug === sel.value); if (p) sel.title = presetNote(p); };
    noteSel(); sel.addEventListener("change", noteSel);
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
        get pointSel() { return pointSel; },
        get pxToWorld() { return mmPerPx * dprNow(); },
    };
    tool = makeTool(toolName, ctx);
    toolStale = false;
}
function setTool(name) {
    toolName = name;
    for (const b of document.querySelectorAll("[data-tool]")) b.classList.toggle("on", b.dataset.tool === name);
    $("well").classList.toggle("tool2d", name !== "edit");
    cancelPreview();
    overlay = null;
    if (!typed.box.hidden) closeTyped();      // no last point to type from any more
    freshTool();
    draw2d();
    clearSnapBase(); postSnapping();
}

// Snapping is on while a drawing tool is armed (plan ruling 16), the grid too when Grid is on.
// Shift held with a placed point locks the angle to 45 degree steps from it (the snap base).
let gridSnap = false, snapBaseOn = null;          // snapBaseOn: the base point sent, as "x,y"
const snapsNow = () => SNAPPING.has(toolName);
function postSnapping() { post({ kind: "snapping", on: snapsNow(), grid: gridSnap }); }
function clearSnapBase() { if (snapBaseOn) { snapBaseOn = null; post({ kind: "snapBase", point: null }); } }
// The base follows the tool's last point while Shift is held: each placed point re-bases the lock.
function syncSnapBase() {
    const base = shiftHeld && snapsNow() ? tool?.lastPoint?.() : null;
    if (!base) { clearSnapBase(); return; }
    const key = base.join(",");
    if (key !== snapBaseOn) { snapBaseOn = key; post({ kind: "snapBase", point: base }); }
}
$("tools2d").querySelector("[data-toggle=grid]").addEventListener("click", (e) => {
    gridSnap = !gridSnap;
    e.currentTarget.classList.toggle("on", gridSnap);
    postSnapping();
});

// Tool results are handled strictly in the order the tool gave them: each waits for the last.
// A failure is reported and the queue goes on: the next result (an endPreview, say) is never lost.
let queue = Promise.resolve();
const toolFailed = (e) => status(`tool: ${e?.message ?? e}`, true);
function apply(result) {
    queue = queue.then(() => result).then(handle).catch(toolFailed);
}
// End an open preview without committing it.
function cancelPreview() {
    if (previewing) change("endPreview", { commit: false });
    previewing = false; previewPattern = null;
}
function patternOfOps(ops) {
    const o = ops.find((x) => typeof x.id === "string" && x.id.endsWith("_outline"));
    return o ? o.id.slice(0, -"_outline".length) : null;
}
function handle(r) {
    if (!r) return;
    if (r.ops?.length) change("ops", { ops: r.ops });
    if (r.preview) { previewing = true; previewPattern = patternOfOps(r.preview) ?? previewPattern; change("preview", { ops: r.preview }); }
    // the commit re-anchors the edited pattern's seams in the same undo step (the worker does it)
    if (r.endPreview) {
        change("endPreview", { commit: true, reanchor: previewPattern });
        previewing = false;
        previewPattern = null;
    }
    if (r.cancel) cancelPreview();
    // a cut goes to the kernel whole: the worker builds its batch (one undo) or refuses it
    if (r.cut) change("cut", r.cut);
    // so does a trace
    if (r.trace) change("trace", r.trace);
    // and a fillet
    if (r.fillet) change("fillet", r.fillet);
    if (r.overlay) overlay = r.overlay.lines?.length || r.overlay.points?.length || r.overlay.ellipse ? r.overlay : null;
    // a tool's word: an error unless it says otherwise
    if (r.status) status(r.status, r.error !== false);
    // a click-placed shape asks for its size; the answer goes to the tool that asked, if still armed
    if (r.ask?.kind === "size") {
        const t = tool;
        askSize(r.ask.shape).then((wh) => {
            if (t !== tool) { if (wh) status("the document changed while the size was asked: click again", true); return; }
            // a cancel clears what the click's jitter drew
            apply(wh ? t.sized(...wh) : { overlay: { lines: [] } });
        });
    }
    if (r.select !== undefined) setSelection(r.select);
    if (r.pointSel) { pointSel = r.pointSel; post({ kind: "pointSel", indices: pointSel }); }
    if (r.done) setTool("edit");
    else if (toolStale && !previewing && !gesture2d()) freshTool();
    syncSnapBase();                       // done, or the overlay emptied: no last point, no lock
    draw2d();
}

for (const b of document.querySelectorAll("[data-tool]")) b.addEventListener("click", () => setTool(b.dataset.tool));
for (const b of document.querySelectorAll("[data-command]")) b.addEventListener("click", () => command(b.dataset.command));

// GIA (the cloth's global intersection analysis): a session choice, on by default (as the View's
// GPU cloth), for the GPU cloth (the CPU always runs it: the button reads on there, disabled).
// The choice is always sent to the worker explicitly. Not saved in the document.
let clothEngine = null;        // "gpu" / "cpu" once the worker is ready
let gia = true;
function showGia() {
    const s = giaState(clothEngine, gia), b = $("sim-gia");
    $("sim-engine").textContent = s.text;
    $("sim-engine").title = s.title;
    b.classList.toggle("on", s.on);
    b.disabled = s.disabled;
    b.title = s.button;
    document.body.dataset.gia = s.on ? "on" : "off";
}
function toggleGia() {
    if (clothEngine !== "gpu") return;
    gia = !gia;
    post({ kind: "gia", on: gia });
    showGia();
}

function command(name) {
    if (name === "fit") fit2d();
    else if (name === "gia") toggleGia();
    else if (name === "arrange") arrange();
    else if (name === "simulate") post({ kind: "sim", action: "toggle" });
    else if (name === "reset") post({ kind: "sim", action: "reset" });
    else if (name === "undo" || name === "redo") afterGesture(() => { cancelPreview(); change(name); });
    else if (name === "save") menu.save();
    else if (name === "open") menu.open();
    else if (name === "maximise2d") maximise("max2d");
    else if (name === "maximise3d") maximise("max3d");
}

// Arrange: each piece not yet placed goes to the next free named slot around the avatar
// (arrangeSlots); a piece goes on another piece only when the user picks that slot.
function arrange() {
    if (!avatar) { status("no avatar to arrange around"); return; }
    const patterns = model.byId(nodes).get("garment")?.patterns ?? [];
    const ops = arrangeSlots(nodes, drawings, avatar).flatMap(({ id, fields }) => model.setPattern(nodes, id, fields));
    if (ops.length) change("ops", { ops, message: "arrange" });
    else status(patterns.length ? "every piece is arranged" : "no pieces to arrange");
}


// ---- the windows: one canvas, the worker's View ---------------------------------------------
const cv = $("view");
let rects = [[0, 0, 0, 0], [0, 0, 0, 0]];
let mmPerPx = 1;            // pattern mm a device pixel spans in the 2D window (each at2d says)
let lastWorld = null;       // the pattern point under the pointer, last answered
const dprNow = () => devicePixelRatio || 1;
{
    cv.width = Math.max(1, Math.round(cv.clientWidth * dprNow()));
    cv.height = Math.max(1, Math.round(cv.clientHeight * dprNow()));
    const off = cv.transferControlToOffscreen();
    post({ kind: "canvas", canvas: off, cpuCloth, film: filmMode }, [off]);
}
// The two windows' rects from the strips over them (layout.js), sent to the worker's View.
function postRects() {
    const dpr = dprNow(), c = cv.getBoundingClientRect();
    const box = (id) => { const r = $(id).getBoundingClientRect(); return { left: r.left, width: $("split").classList.contains(id === "tools3d" ? "max2d" : "max3d") ? 0 : r.width }; };
    rects = viewportRects({ left: c.left, width: c.width, height: c.height }, [box("tools3d"), box("tools2d")], dpr);
    post({ kind: "rects", rects });
    cv.dataset.rect3d = rects[0].map((v) => v / dpr).join(",");
    cv.dataset.rect2d = rects[1].map((v) => v / dpr).join(",");
}
new ResizeObserver(() => {
    if (cv.clientWidth > 0 && cv.clientHeight > 0) post({ kind: "resize", width: cv.clientWidth, height: cv.clientHeight, dpr: dprNow() });
    postRects();
}).observe(cv);

// The tool's rubber band, points and read-out: drawn by the worker's View (no overlay canvas).
// The read-out is the length from the tool's last point to the pointer, at the pointer.
function draw2d() {
    const t = readout(tool?.lastPoint?.() ?? null, lastWorld);
    document.body.dataset.readout = t ?? "";
    post({ kind: "overlay2d", lines: overlay?.lines ?? [], points: overlay?.points ?? [], ellipse: overlay?.ellipse ?? null, text: t ? { at: lastWorld, text: t } : null });
}

// Typed lengths: while a tool has a last point, a digit opens the box at the pointer; Tab goes to
// the angle; Enter places the next point that far along the pointer's direction (or at the typed
// angle) through the same down + up as a click; Escape closes the box and the shape goes on.
// The box's keys stay in the box: none of them is an app shortcut, except Ctrl+S / Ctrl+O, which
// save and open as from any field. The box closes when the focus leaves it (a save blurs the
// field it is in), its length unplaced. Shift held in the box still locks the angle (shiftHeld).
// After a placed point the pointer has not moved: the next typed length goes from the new point
// toward it, the direction the rubber band shows.
let pointerCss = [0, 0];          // the pointer over the canvas, CSS px from the well's top left
cv.addEventListener("pointermove", (e) => { const r = $("well").getBoundingClientRect(); pointerCss = [e.clientX - r.left, e.clientY - r.top]; });
const typed = { box: $("typed"), len: $("typed-length"), ang: $("typed-angle") };
function openTyped(first) {
    typed.len.value = first; typed.ang.value = "";
    typed.box.hidden = false;
    // below right of the pointer, kept inside the well
    const well = $("well"), maxX = well.clientWidth - typed.box.offsetWidth, maxY = well.clientHeight - typed.box.offsetHeight;
    typed.box.style.left = `${Math.max(0, Math.min(pointerCss[0] + 14, maxX))}px`;
    typed.box.style.top = `${Math.max(0, Math.min(pointerCss[1] + 14, maxY))}px`;
    typed.len.focus();
    typed.len.setSelectionRange(first.length, first.length);
}
function closeTyped() { typed.box.hidden = true; cv.focus(); }
typed.box.addEventListener("focusout", (e) => { if (!typed.box.contains(e.relatedTarget)) typed.box.hidden = true; });
function commitTyped() {
    const last = tool?.lastPoint?.();
    if (!last) { closeTyped(); return; }
    const v = typedValues(typed.len.value, typed.ang.value);
    if (!v) { status("type a length above 0 (and an angle in degrees)", true); return; }
    const len = v.length, p = typedPoint(last, lastWorld, len, v.angle);
    closeTyped();
    if (tool.typed) apply(tool.typed(p, len));
    else { apply(tool.down(p, null, {})); apply(tool.up(p, null, {})); }
}
for (const input of [typed.len, typed.ang]) input.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey) return;             // the document's: Ctrl+S saves (its input guard stops the rest)
    e.stopPropagation();
    if (e.key === "Shift" && !e.repeat) { shiftHeld = true; syncSnapBase(); }
    if (e.key === "Enter") { e.preventDefault(); commitTyped(); }
    else if (e.key === "Escape") { e.preventDefault(); closeTyped(); }       // the shape goes on
    else if (e.key === "Tab") { e.preventDefault(); (input === typed.len ? typed.ang : typed.len).focus(); }
});
function fit2d() { post({ kind: "fit2d" }); }

// The 3D tools (Pin, Drag): with one on, a left press in the 3D window is the tool's (the
// router below claims it), so the camera does not orbit; right and middle drag and the wheel
// still move it.
let tool3d = null;
function setTool3d(name) {
    tool3d = tool3d === name ? null : name;
    if (tool3d && tape.on) tapeDo(tape.toggle());
    for (const b of document.querySelectorAll("[data-tool3d]")) b.classList.toggle("on", b.dataset.tool3d === tool3d);
    $("well").classList.toggle("tool3d", !!tool3d);
}
for (const b of document.querySelectorAll("[data-tool3d]")) b.addEventListener("click", () => setTool3d(b.dataset.tool3d));

// The fit map (fitmap.js): the select, the legend over the 3D window's corner, the value under
// the pointer (one hover pick in flight). The Tape tool (tape3d.js): its clicks are 3D picks
// (pick3d with `tape`), its measures the worker's.
const fit = new FitMap(), tape = new TapeTool();
let hoverSeq = 0;
const mapHovers = new Latest((ev) => post({ kind: "mapHover", x: ev.x, y: ev.y, seq: ++hoverSeq }));
function showMap() {
    renderLegend($("map-legend"), fit.legend());
    $("map-select").value = fit.key;
    document.body.dataset.map = fit.key;
}
for (const m of MAPS) { const o = document.createElement("option"); o.value = m.key; o.textContent = m.key === "off" ? "Map: off" : `Map: ${m.label}`; $("map-select").append(o); }
$("map-select").addEventListener("change", (e) => { post(fit.set(e.target.value, nodes)); $("map-value").textContent = ""; showMap(); });
for (const input of [$("map-lo"), $("map-hi")]) {
    input.addEventListener("change", () => { const r = fit.setRange($("map-lo").value, $("map-hi").value); if (r.error) status(r.error, true); else post(r); showMap(); });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
}
function tapeDo(r) {
    for (const m of r?.post ?? []) post(m);
    if (r?.status) status(r.status, !!r.error);
    $("tape-toggle").classList.toggle("on", tape.on);
    for (const b of document.querySelectorAll("[data-tape-mode]")) b.classList.toggle("on", b.dataset.tapeMode === tape.mode);
    $("tape-hull").checked = tape.hullOn;
    document.body.dataset.tape = tape.on ? tape.mode : "";
}
$("tape-toggle").addEventListener("click", () => { if (tool3d) setTool3d(tool3d); tapeDo(tape.toggle()); });
for (const b of document.querySelectorAll("[data-tape-mode]")) b.addEventListener("click", () => tapeDo(tape.setMode(b.dataset.tapeMode)));
$("tape-hull").addEventListener("change", (e) => tapeDo(tape.setHull(e.target.checked)));
$("tape-clear").addEventListener("click", () => tapeDo(tape.clear()));
showMap(); tapeDo(null);

// ---- the pointer router (plan ruling 5) ---------------------------------------------------
// Every canvas event comes here first. A left press in the 2D window with a tool on (and Space
// up) is the tool's: its moves and release go to the worker as `pointer2d`, answered by `at2d`
// with the pattern point and the View's pick. A left press in the 3D window with Pin or Drag on
// is that tool's. Everything else is the View's camera input; a hover over the 2D window is
// also sent as `pointer2d` (the worker hovers the piece under it).
let space = false, shiftHeld = false, drag2d = false, lastUp = null;
let ups2d = 0;                            // 2D releases sent, not yet answered: the gesture is still the tool's
let pan2d = null;                         // the pointer panning the 2D window (the View's), while it does
let in2d = false;                         // a hover was sent since the pointer last left the 2D window
const gesture2d = () => drag2d || ups2d > 0;
// A key for the tool waits for the clicks made before it, each a round trip to the worker (not
// for later ones): Enter right after a click ends the line with that click's point in it.
const keyHold = new KeyHold((e) => toolFailed(e));
const afterUps = (fn) => keyHold.key(seq2d, fn);
const claims = new Map();                 // pointerId -> "2d" | "3d"
const pending2d = new Map();              // seq -> {mods, xy} of a 2D event in flight (xy: its canvas point)
let seq2d = 0, moveBusy = false, moveNext = null, down3d = null;
const at2dPx = (ev) => [ev.x - rects[1][0], ev.y - rects[1][1]];
const mods2d = (ev, extra = {}) => ({ shift: shiftHeld, ctrl: false, alt: false, px: at2dPx(ev), ...extra });
function send2d(phase, ev, mods) {
    const seq = ++seq2d;
    pending2d.set(seq, { mods, xy: [ev.x, ev.y] });
    post({ kind: "pointer2d", seq, phase, x: ev.x, y: ev.y, snap: snapsNow() });
}
// one move or hover in flight at a time: the newest waits, older ones are dropped
function move2d(ev) { moveNext = ev; in2d = true; if (!moveBusy) flushMove(); }
// The pointer is out of the 2D window: the worker drops its hover (after the events before it).
function leave2d() {
    if (!in2d || drag2d) return;
    in2d = false; moveNext = null;
    post({ kind: "leave2d" });
}
cv.addEventListener("pointerleave", leave2d);
// The cursor of the window under the pointer: a crosshair in 2D (grabbing while it pans), a
// crosshair in 3D while Pin or Drag is on.
function cursorAt(vp) { cv.style.cursor = vp === 1 ? (pan2d !== null ? "grabbing" : "crosshair") : vp === 0 && (tool3d || tape.on) ? "crosshair" : ""; }
// Tab leaves the canvas (listen would keep it there; the app binds no Tab on the canvas)
$("well").addEventListener("keydown", (e) => { if (e.key === "Tab" && !e.target.closest?.("#typed")) e.stopPropagation(); }, true);
function flushMove() {
    const ev = moveNext;
    moveNext = null;
    if (!ev) return;
    moveBusy = true;
    send2d(drag2d ? "move" : "hover", ev, mods2d(ev));
}
// The pointer taken away mid-drag: the preview is dropped and the gesture starts over.
function dragLost() {
    if (!drag2d) return;
    drag2d = false;
    queue = queue.then(() => { cancelPreview(); overlay = null; freshTool(); draw2d(); }).catch(toolFailed);
}
listen(cv, (ev) => {
    if (ev.kind === "key") return;                      // the app's keys are the app's
    if (ev.kind === "down") {
        const vp = viewportAt(rects, [ev.x, ev.y]);
        if (!typed.box.hidden) typed.box.hidden = true;        // a press leaves the typed length unplaced
        cv.focus();
        if (vp === 1 && ev.button === 0 && !space && tool) {
            claims.set(ev.pointerId, "2d"); drag2d = true; moveNext = null;
            send2d("down", ev, mods2d(ev));
            return;
        }
        if (vp === 0 && ev.button === 0 && tool3d) {
            claims.set(ev.pointerId, "3d");
            post({ kind: "tool3d", tool: tool3d, phase: "down", x: ev.x, y: ev.y });
            return;
        }
        if (vp === 1 && ev.button === 1) ev = { ...ev, button: 0 };          // middle-drag pans the 2D window
        if (vp === 0 && ev.button === 0) down3d = [ev.x, ev.y];
    }
    const claim = ev.pointerId !== undefined ? claims.get(ev.pointerId) : undefined;
    if (claim === "2d") {
        if (ev.kind === "move") { move2d(ev); return; }
        claims.delete(ev.pointerId);
        moveNext = null;
        if (ev.kind === "cancel") { dragLost(); return; }
        drag2d = false;
        // count the clicks here: a double click is two ups close in time and place
        const now = performance.now(), css = [ev.x / dprNow(), ev.y / dprNow()];
        const detail = lastUp && now - lastUp.t < 400 && Math.hypot(css[0] - lastUp.p[0], css[1] - lastUp.p[1]) < CLICK_PX ? lastUp.detail + 1 : 1;
        lastUp = { t: now, p: css, detail };
        ups2d++;
        send2d("up", ev, mods2d(ev, { detail, dblclick: detail === 2 }));
        keyHold.sent(seq2d);
        return;
    }
    if (claim === "3d") {
        if (ev.kind !== "move") claims.delete(ev.pointerId);
        post({ kind: "tool3d", tool: tool3d, phase: ev.kind === "cancel" ? "up" : ev.kind, x: ev.x, y: ev.y });
        return;
    }
    const vpNow = ev.x === undefined ? -1 : viewportAt(rects, [ev.x, ev.y]);
    if (ev.kind === "down" && vpNow === 1) { pan2d = ev.pointerId; cursorAt(1); }      // Space, middle or right: a pan
    if (ev.kind === "move") {
        if (vpNow === 1 && pan2d === null) move2d(ev);
        else if (vpNow !== 1) leave2d();
        if (pan2d === null) cursorAt(vpNow);
        if (fit.on && vpNow === 0 && !down3d) mapHovers.push(ev);
    }
    if (ev.kind === "up" && down3d) {                                    // a click without a drag picks in 3D
        const click = Math.hypot(ev.x - down3d[0], ev.y - down3d[1]) < CLICK_PX * dprNow();
        // the Tape's click: a point, or the second click of a double click ending the path
        if (click && tape.on) { if (tape.press(performance.now(), [ev.x / dprNow(), ev.y / dprNow()]) === "end") tapeDo(tape.end()); else post({ kind: "pick3d", x: ev.x, y: ev.y, tape: true }); }
        else if (click) post({ kind: "pick3d", x: ev.x, y: ev.y, seq: selSeq });
        down3d = null;
    }
    post({ cadaclysm: "input", event: ev });
    // the pan or the zoom has moved the pattern under the pointer: ask its hover again
    if ((ev.kind === "up" || ev.kind === "cancel") && pan2d === ev.pointerId) {
        pan2d = null;
        if (vpNow === 1) move2d(ev);
        cursorAt(vpNow);
    }
    if (ev.kind === "wheel" && vpNow === 1) move2d(ev);
}, () => post({ cadaclysm: "clearKeys" }));

// Resolves once every 2D event sent so far has been answered and its tool result queued: a
// save waits on it, so it holds the drag that was let go just before it (the events go to the
// worker and back now, where M4a's tool heard them at once). Later events do not hold it up.
const waits2d = [];
// `fn` once the 2D events sent so far are answered and the tool results they queued are handled.
function afterGesture(fn) { after2d().then(() => { queue = queue.then(fn).catch(toolFailed); }); }
function after2d() {
    const upto = seq2d;
    return new Promise((resolve) => { waits2d.push({ upto, resolve }); settle2d(); });
}
function settle2d() {
    for (let i = waits2d.length - 1; i >= 0; i--) {
        const w = waits2d[i];
        if (![...pending2d.keys()].some((s) => s <= w.upto)) { waits2d.splice(i, 1); w.resolve(); }
    }
}

// The worker's answer to a 2D event: the tool hears it with the pattern point and the hit.
function onAt2d(m) {
    try { at2dAnswer(m); } finally { settle2d(); }
}
function at2dAnswer(m) {
    const { mods = {}, xy = null } = pending2d.get(m.seq) ?? {};
    pending2d.delete(m.seq);
    // the keys typed after this release run once the tool has heard it (below), before the next answer
    if (m.phase === "up") { ups2d = Math.max(0, ups2d - 1); keyHold.answered(m.seq); queueMicrotask(() => keyHold.flush()); }
    if (m.mmPerPx > 0 && Number.isFinite(m.mmPerPx)) mmPerPx = m.mmPerPx;
    if (m.phase === "move" || m.phase === "hover") { moveBusy = false; queueMicrotask(flushMove); }
    document.body.dataset.hit = m.hit?.kind ?? "";
    document.body.dataset.snap = m.snap?.kind ?? "";
    document.body.dataset.snapAngle = m.snap?.lockedAngle == null ? "" : String(Math.round(m.snap.lockedAngle));
    // no point (the window hidden since, or the worker failed): a release still ends the
    // gesture, at the last point answered, so no preview is left open
    if (!m.world) { if (m.phase === "up" && tool && lastWorld) apply(tool.up(lastWorld, m.hit, mods)); return; }
    lastWorld = m.world;
    document.body.dataset.world = m.world.map((v) => v.toFixed(3)).join(",");
    document.body.dataset.worldAt = xy ? xy.join(",") : "";   // the canvas point (device px) that world answers: the tests wait on it
    if (!tool) return;
    if (m.phase === "down") apply(tool.down(m.world, m.hit, mods));
    else if (m.phase === "up") apply(tool.up(m.world, m.hit, mods));
    else apply(tool.move(m.world, m.hit, mods));
}

// The simulation's state from the View's worker: the buttons, the health line, the rate.
function onSim(m) {
    const toggle = $("sim-toggle");
    toggle.textContent = m.building ? "Building…" : m.running ? "Pause" : "Simulate";
    toggle.classList.toggle("on", !!m.running);
    toggle.title = m.running ? "Pause the cloth" : m.live && m.stale ? "Rebuild the cloth from the garment and run it" : "Run the cloth: sew, then drape on the avatar";
    $("sim-reset").disabled = !m.live;
    const h = $("health");
    h.classList.toggle("warn", !!m.health?.warn);
    h.replaceChildren(m.live ? (m.health?.text ?? "") : m.building ? "meshing the garment…" : "");
    if (m.live && m.stale) {
        const s = document.createElement("span");
        s.className = "stale";
        s.textContent = ` · ${m.stale}: Simulate rebuilds, Reset drops it`;
        h.append(s);
    }
    h.title = h.textContent;
    $("fps").textContent = m.running && m.fps > 0 ? `${m.fps.toFixed(1)} fps · ${Math.round(m.ms)} ms/step` : m.live ? "paused" : "—";
    document.body.dataset.sim = m.running ? "running" : m.live ? "paused" : "off";
    document.body.dataset.meshGen = String(m.meshGen);
    film?.onSim(m, (text) => { $("fps").textContent = text; });
}


// ---- layout: the divider, F2 / F3 ---------------------------------------------------------
const split = $("split");
function setShare(pct) {
    const s = Math.min(85, Math.max(15, pct));
    split.style.setProperty("--share", String(s));
    requestAnimationFrame(postRects);
    return s;
}
try { const v = Number(localStorage.getItem(SPLIT_KEY)); if (v) setShare(v); } catch { /* no storage: the default split */ }
function maximise(cls) {
    const on = !split.classList.contains(cls);
    split.classList.remove("max2d", "max3d");
    if (on) split.classList.add(cls);
    requestAnimationFrame(postRects);
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

// ---- keys ---------------------------------------------------------------------------------
document.addEventListener("keydown", (e) => {
    const sc = toolOfKey(e);
    if (sc && (sc.command === "save" || sc.command === "open")) { e.preventDefault(); command(sc.command); return; }
    if (e.target.closest?.("input, textarea, select, [contenteditable]")) return;
    if (sc?.command && (e.ctrlKey || e.metaKey || e.key === "F2" || e.key === "F3")) { e.preventDefault(); command(sc.command); return; }
    if (e.key === "Shift" && !e.repeat) { shiftHeld = true; syncSnapBase(); }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === " ") { space = true; e.preventDefault(); return; }
    // the Tape's path being drawn: Enter keeps it, Escape drops it
    if (tape.current && (e.key === "Enter" || e.key === "Escape")) { e.preventDefault(); tapeDo(e.key === "Enter" ? tape.end() : tape.escape()); return; }
    if (e.key === "Escape") {
        // the tool hears it first (a drag cancels), then back to edit
        afterUps(() => {
            if (tool) apply(tool.key("Escape"));
            queue = queue.then(() => { if (toolName !== "edit") setTool("edit"); overlay = null; draw2d(); }).catch(toolFailed);
        });
        return;
    }
    // Enter on a focused button presses it
    if (e.key === "Enter" && e.target.closest?.("button, a, [role=button]")) return;
    // a digit with a last point to measure from (once the clicks before it are in): the typed length
    if (/^[0-9.]$/.test(e.key) && typed.box.hidden && !drag2d) {
        e.preventDefault();
        const d = e.key;
        afterUps(() => {
            if (typed.box.hidden && !drag2d && tool?.lastPoint?.()) openTyped(d);
            else if (tool) { const r = tool.key(d); if (r && Object.keys(r).length) apply(r); }
        });
        return;
    }
    if (e.key === "f" || e.key === "F") { fit2d(); return; }
    // Delete (and Backspace in the edit tool) removes the selected piece, with its seams, or seam
    if ((e.key === "Delete" || (e.key === "Backspace" && toolName === "edit")) && removeSelected()) { e.preventDefault(); return; }
    if (e.key === "Backspace" || e.key === "Enter") e.preventDefault();
    const k = e.key;
    afterUps(() => {
        if (tool) { const r = tool.key(k); if (r && Object.keys(r).length) apply(r); }
        if (sc?.tool) setTool(sc.tool);
    });
});
document.addEventListener("keyup", (e) => {
    if (e.key === " ") space = false;
    if (e.key === "Shift") { shiftHeld = false; clearSnapBase(); }
});
window.addEventListener("blur", () => { space = false; shiftHeld = false; clearSnapBase(); });

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
    open() { pickFile(".json,application/json", async (f) => { const text = await f.text(); cancelPreview(); fitNext = true; setSelection(null); change("open", { text }); }); },
    // after the 2D events in flight and the tool results still queued (a drag's last step): they are saved too
    save() { afterGesture(() => { document.activeElement?.blur(); cancelPreview(); post({ kind: "save" }); }); },
    importDxf() { pickFile(".dxf", async (f) => { const text = await f.text(); cancelPreview(); fitNext = true; change("importDxf", { text, fabric: currentFabric() }); }); },
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
    previewing = false; previewPattern = null;
    // no 2D answer will come: nothing waits for one (Escape back to Edit still works)
    ups2d = 0; pending2d.clear(); keyHold.reset(); settle2d();
    status(text, true);
}
worker.onerror = (e) => { e.preventDefault?.(); workerFailed(`worker: ${e.message || "failed"}`); };
worker.onmessageerror = () => workerFailed("worker: a message could not be read");

worker.onmessage = ({ data: m }) => {
    switch (m.kind) {
        case "ready":
            if (m.clothEngine !== "gpu") startClothWorker();
            clothEngine = m.clothEngine === "gpu" ? "gpu" : "cpu";
            if (clothEngine === "gpu") post({ kind: "gia", on: gia });
            showGia();
            $("lic").textContent = `cadaclysm ${m.version} · ${m.backend}${m.license ? ` · ${m.license}` : ""}`;
            status("ready");
            fitNext = true;
            change("new", { ops: newDocumentOps() });
            document.body.dataset.ready = "1";
            break;
        case "doc": onDoc(m); break;
        case "forms": forms = m.forms ?? []; if (avatar) avatar.forms = forms; break;
        case "avatar":
            avatar = { name: m.name, bounds: m.bounds, landmarks: m.landmarks ?? null, forms };
            // a built form (meta atelier.form): the Body panel shows its spec; a shipped one closes it
            bodyDraft = avatar.landmarks?.form ? draftFrom(avatar.landmarks.form) : null;
            avatar.draft = bodyDraft;
            document.body.dataset.form = m.formKey ?? "";
            if (m.formKey && formAskedAt !== null) { document.body.dataset.formMs = String(Math.round(performance.now() - formAskedAt)); formAskedAt = null; }
            if (m.formKey) { document.body.dataset.formWorkerMs = String(Math.round(m.timings?.worker ?? 0)); status(`form built: ${m.triangles} triangles${m.separate?.length ? `; separate: ${m.separate.join("; ")}` : ""}`); }
            document.body.dataset.avatarHead = avatar.landmarks?.head ? "1" : "0";     // the browser test reads it
            if (formLoading === m.name) { formLoading = null; status(`${m.name} loaded`); }
            renderBrowser();
            if (selection?.kind === "avatar") renderProps();
            break;
        case "status": status(m.text); break;
        case "formBuilding": status("building the form…"); break;
        case "formFailed": formAskedAt = null; break;
        case "sim": onSim(m); break;
        case "at2d": onAt2d(m); break;
        case "scene2d": document.body.dataset.items2d = String(m.items); document.body.dataset.hover2d = m.hover ?? ""; break;
        case "picked": if (m.tape) tapeDo(tape.click(m.target, m.point)); else if (m.seq === selSeq) setSelection(m.selection); break;   // else the selection moved on since
        case "mapValue":
            mapHovers.done();
            $("map-value").textContent = m.value == null ? "" : valueText(fit.key, m.value);
            document.body.dataset.mapValue = m.value == null ? "" : String(m.value);
            break;
        case "taped": status(`${m.op === "girth" ? "girth" : "tape"}: ${cmText(m.length)}`); document.body.dataset.tapeLength = String(m.length); document.body.dataset.tapeTarget = m.target; break;
        case "path": waiting.get(m.reqId)?.resolve(m.path); waiting.delete(m.reqId); break;
        case "saved":
            if (film?.onSaved(m.text)) break;
            download("garment.json", m.text, "application/json"); status(`saved garment.json: ${(m.text.length / 1024).toFixed(1)} KB`); break;
        case "dxf": download("garment.dxf", m.text, "application/dxf"); status(`saved garment.dxf: ${(m.text.length / 1024).toFixed(1)} KB`); break;
        case "error":
            if (m.reqId == null) fitNext = false;
            if (m.reqId != null && waiting.has(m.reqId)) { waiting.get(m.reqId).reject(new Error(m.text)); waiting.delete(m.reqId); }
            else status(m.text, true);
            // a form that failed to load: the select goes back to the avatar there is
            if (m.reqId == null && formLoading) { formLoading = null; if (selection?.kind === "avatar") renderProps(); }
            break;
    }
};

// The selected outline's point count: box-selected point indices hold only while it stands.
const pointCount = () => (selection?.kind === "pattern" ? nodes.find((n) => n.id === `${selection.id}_outline`)?.path?.segments?.length ?? 0 : 0);
function onDoc(m) {
    const points0 = pointCount();
    nodes = m.nodes; drawingList = m.drawings; seams = m.seams; issues = m.issues ?? [];
    drawings = new Map(drawingList.map((d) => [d.id, d]));
    // a selection's pieces that went (an undo, a delete, an open) leave it; setSelection tells
    // the worker and drops the point selection
    const kept = survivingSelection(selection, (id) => exists({ kind: selection.kind, id }));
    if (kept !== selection) setSelection(kept);
    else if (pointSel.length && pointCount() !== points0) { pointSel = []; post({ kind: "pointSel", indices: [] }); }
    if (fitNext && m.seq === seq) { fitNext = false; if (drawingList.length) fit2d(); }
    // A fresh tool for the new nodes, unless a gesture (and its previews) is under way.
    if (previewing || gesture2d()) toolStale = true; else freshTool();
    renderBrowser();
    renderProps();
    renderIssues();
    draw2d();
}

setTool("edit");
