// The page end to end in headless Chrome or Edge, over the DevTools protocol (Node's own
// WebSocket: no dependency). It serves the repo with scripts/serve.mjs, opens the page, waits
// for the worker's `ready`, then with real pointer and key events: draws a rectangle, drags a
// corner, maximises, arranges, edits the properties (typing + Tab keeps the focus), adds a
// library fabric, draws a second rectangle and sews the two with "Sew sides", picks the seam in
// 2D, deletes it and a piece (each undone), sews an M:N group (deleted, ungrouped, undone),
// moves a piece with the Move tool, types an allowance and saves with Ctrl+S (the download is
// read back), New and Open, loads an STL avatar, loads the T-shirt sample, places its Front on
// the avatar and drags it with the 3D gizmo (each undone), exports it as DXF (4 BLOCKs) and
// imports that back, and imports a DXF with an internal line, a fold and a hole. Then
// the live drape on the sample: Simulate, frames arrive, a pin, a drag on the cloth, a 2D move
// of a piece while it runs (re-meshed), Pause, Reset, on the cloth engine the page picked (the GPU on
// WebGPU, else the CPU worker; #sim-engine checked). Then the 2D tools on a new garment, ending
// with holes: a rectangle and an ellipse hole by dialog, one over the edge refused, and an
// internal square by dialog converted to a hole, another traced out as a piece, and a corner
// filleted to a typed radius; then grading: sizes by the Sizes dialog, Proportional, a drag in L, the grade table,
// size switches, Show sizes and undo; then a sleeve sewn to an armhole cut as a hole (Sew sides on
// the hole's edge), undone and redone. Each step prints ok. Any console error or uncaught exception, in
// the page or its workers, fails.
//
//     node test/browser.mjs                              # npm run test:browser
//     ATELIER_SHOT=out.png node test/browser.mjs         # also a screenshot of the drape
//     ATELIER_SHOT_HOLES=holes.png ...                   # also one of the holed piece in 2D
//     ATELIER_SHOT_MAP=map.png ATELIER_SHOT_TAPE=tape.png  # the drape with the Strain map, a girth on the avatar
//     ATELIER_SHOT_MAP_OFF=off.png ...                  # also the drape with the map back off
//     ATELIER_SHOT_FORM_XS=xs.png ATELIER_SHOT_FORM_XL=xl.png  # V3: the custom forms built from XS and XL
//     ATELIER_SHOT_POSED=posed.png ATELIER_HOODIE=<hoodie.json>  # V3: a garment opened, the form at A-pose with
//                                                        # the left knee bent (ATELIER_KNEE, default 30), draped
//     ATELIER_V3_ONLY=1 ...                              # only the V3 block (custom forms), after the page is ready
//     ATELIER_A2_ONLY=1 ...                              # only the A2 block (place on avatar, the gizmo), on the sample
//     ATELIER_S2_ONLY=1 ...                              # only the S2 block (darts closed and rotated, a pleat set, simulated)
//     ATELIER_SHOT_S2=s2.png ...                         # S2: s2-rotate.png (the hover preview), s2-pleat.png, s2-sim.png
//     ATELIER_SHOT_GIZMO=gizmo.png ...                   # also the gizmo over the sample's Front, its X arrow hovered
//     ATELIER_SHOT_PLACE=place.png ...                   # also a sleeve placed on an arm by Place (wrapped round it)
//     ATELIER_SHOT_MN=mn.png ...                         # also the M:N group selected in 2D (its seams numbered)
//     ATELIER_SHOT_DXF=dxf.png ...                       # also the imported DXF piece with its internal lines and hole
//     ATELIER_SHOT_HOLE_SEAM=hs.png ...                  # also a sleeve sewn to an armhole cut as a hole, in 2D
//     ATELIER_SHOT_GRADE=grade.png ATELIER_SHOT_NEST=nest.png  # A3: the grade table of a graded corner, the graded nest (Show sizes)
//     ATELIER_DRAPE_FRAMES=150 ...                       # run the drape that long first (default 4)
//     ATELIER_CLOTH=cpu ...                              # the CPU cloth worker (?cloth=cpu); default the GPU
//                                                        # on a WebGPU page (ATELIER_CLOTH=gpu: required)
//     ATELIER_SOFTWARE=1 ...                             # no GPU: SwiftShader WebGL2, the CPU cloth
//     ATELIER_FPS=1 ...                                  # also the drape's rate over frames 60..180
//                                                        # (with ATELIER_SHOT: the picture at frame 180)
//     node test/browser.mjs --chrome <path>              # (or the CHROME variable)
//     node test/browser.mjs --headed                     # watch it
//
// Needs `npm run setup` first.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { loadKernel } from "./package.mjs";
import { stlOf } from "./stl.mjs";
import { Atelier } from "../kernel.js";
import * as mm from "../model.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const W = 1600, H = 900;

function findChrome() {
    const given = option("--chrome") ?? process.env.CHROME;
    if (given) return given;
    const candidates = process.platform === "win32"
        ? [process.env["PROGRAMFILES"], process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean).flatMap((d) => [
            join(d, "Google", "Chrome", "Application", "chrome.exe"), join(d, "Microsoft", "Edge", "Application", "msedge.exe")])
        : process.platform === "darwin"
            ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium",
                "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
            : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium",
                "/usr/bin/microsoft-edge"];
    const found = candidates.find((p) => existsSync(p));
    if (!found) throw new Error("no Chrome or Edge found: pass --chrome <path> or set CHROME");
    return found;
}

const freePort = () => new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => ok(port)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 60000) {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await sleep(100);
    }
}

class Cdp {
    constructor(url) {
        this.ws = new WebSocket(url);
        this.next = 0;
        this.waiting = new Map();
        this.handlers = [];
        this.ws.onmessage = ({ data }) => {
            const m = JSON.parse(data);
            if (m.id !== undefined) {
                const w = this.waiting.get(m.id);
                this.waiting.delete(m.id);
                if (m.error) w?.reject(new Error(`${w.method}: ${m.error.message}`)); else w?.resolve(m.result);
            } else for (const h of this.handlers) h(m);
        };
    }
    open() { return new Promise((ok, fail) => { this.ws.onopen = ok; this.ws.onerror = () => fail(new Error("DevTools connection failed")); }); }
    send(method, params = {}, sessionId) {
        const id = ++this.next;
        this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        return new Promise((resolve, reject) => this.waiting.set(id, { resolve, reject, method }));
    }
    on(fn) { this.handlers.push(fn); }
    close() { this.ws.close(); }
}

async function launch(chrome, profile) {
    const flags = [`--user-data-dir=${profile}`, "--remote-debugging-port=0", `--window-size=${W},${H}`, "--no-first-run",
        "--no-default-browser-check", "--disable-extensions", "--enable-unsafe-webgpu", "--hide-scrollbars", "about:blank"];
    if (!flag("--headed")) flags.unshift("--headless=new");
    // ATELIER_SOFTWARE=1: no GPU at all (SwiftShader's WebGL2, so the CPU cloth), for a machine whose GPU is busy
    if (process.env.ATELIER_SOFTWARE) flags.push("--disable-gpu", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-features=WebGPU");
    const child = spawn(chrome, flags, { stdio: ["ignore", "ignore", "pipe"] });
    // Chrome's stderr, kept to print if the launch fails
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-8000); });
    let exited = null;
    child.once("exit", (code) => { exited = code ?? "signal"; });
    child.once("error", (e) => { exited = e.message; });
    const portFile = join(profile, "DevToolsActivePort");
    try {
        const text = await until("Chrome's DevTools port", () => {
            if (exited !== null) throw new Error(`Chrome exited (${exited}) before its DevTools port`);
            return existsSync(portFile) && readFileSync(portFile, "utf8").includes("\n") && readFileSync(portFile, "utf8");
        }, 30000);
        const [port, path] = text.trim().split("\n");
        return { child, url: `ws://127.0.0.1:${port}${path}` };
    } catch (e) {
        child.kill();
        throw new Error(`${e.message}${stderr.trim() ? `\nChrome's stderr:\n${stderr.trim()}` : ""}`);
    }
}

// The static server: `up` resolves once it prints its address; rejects if it exits first or is silent for 30 s.
function startServer(port) {
    const server = spawn(process.execPath, [join(root, "scripts", "serve.mjs"), String(port)], { stdio: ["ignore", "pipe", "inherit"] });
    let listening = false, exited = null;
    server.stdout.once("data", () => { listening = true; });
    server.once("exit", (code) => { exited = code ?? "signal"; });
    server.once("error", (e) => { exited = e.message; });
    const up = until("the server", () => {
        if (exited !== null) throw new Error(`the server exited (${exited}) before listening`);
        return listening;
    }, 30000);
    return { server, up };
}

async function check(cdp, base) {
    const errors = [];
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const sessions = new Set([sessionId]);
    const workerSessions = new Map();     // worker url -> its CDP session (the stall below)
    const label = (s) => (s === sessionId ? "page" : "worker");
    cdp.on((m) => {
        if (!sessions.has(m.sessionId)) return;
        if (m.method === "Runtime.exceptionThrown") {
            const d = m.params.exceptionDetails;
            errors.push(`${label(m.sessionId)}: ${d.exception?.description ?? d.text}`);
        } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
            errors.push(`${label(m.sessionId)} console.error: ${m.params.args.map((a) => a.value ?? a.description ?? "").join(" ")}`);
        } else if (m.method === "Log.entryAdded" && m.params.entry.level === "error") {
            errors.push(`${label(m.sessionId)} log: ${m.params.entry.text} ${m.params.entry.url ?? ""}`);
        } else if (m.method === "Target.attachedToTarget") {
            const s = m.params.sessionId;
            sessions.add(s);
            workerSessions.set(m.params.targetInfo?.url ?? "", s);
            cdp.send("Runtime.enable", {}, s).catch(() => {});
            cdp.send("Log.enable", {}, s).catch(() => {});
            cdp.send("Runtime.runIfWaitingForDebugger", {}, s).catch(() => {});
        }
    });
    const send = (method, params) => cdp.send(method, params, sessionId);
    async function evaluate(expression) {
        const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(`${expression.slice(0, 60)}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
        return r.result.value;
    }
    const failIfErrors = () => { if (errors.length) throw new Error(`errors logged:\n  ${errors.join("\n  ")}`); };
    const statusError = () => evaluate(`(() => { const s = document.getElementById("status-text"); return s.classList.contains("error") ? s.textContent : null; })()`);
    const noStatusError = async () => { const se = await statusError(); if (se) throw new Error(`the status line says: ${se}`); };
    const mouse = (type, x, y, extra = {}) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, ...extra });
    const click = async ([x, y]) => { await mouse("mouseMoved", x, y, { buttons: 0 }); await mouse("mousePressed", x, y); await mouse("mouseReleased", x, y); };
    const drag = async (a, b, steps = 8, holdMs = 0) => {
        await mouse("mouseMoved", a[0], a[1], { buttons: 0 });
        await mouse("mousePressed", a[0], a[1]);
        if (holdMs) await sleep(holdMs);
        for (let i = 1; i <= steps; i++) await mouse("mouseMoved", a[0] + ((b[0] - a[0]) * i) / steps, a[1] + ((b[1] - a[1]) * i) / steps);
        await mouse("mouseReleased", b[0], b[1]);
    };
    // A hover at p (CSS px) and its answer {hit, snap, world, hover2d}, read once dataset.worldAt names p
    // (device px): the answer to THIS hover, never one for an earlier point still in flight (d36fb2e). The
    // hovered piece is posted before the answer, so it is settled with it. Already answered at p: a hover
    // 1 px off first, so the answer read is a new one.
    const hoverAnswer = (p) => evaluate(`(() => { const r = document.getElementById("view").getBoundingClientRect(), d = document.body.dataset;
        const at = (d.worldAt ?? "").split(",").map(Number), p = ${JSON.stringify(p)};
        if (!d.worldAt || Math.abs(at[0] / devicePixelRatio + r.left - p[0]) > 0.51 || Math.abs(at[1] / devicePixelRatio + r.top - p[1]) > 0.51) return null;
        return { hit: d.hit ?? "", snap: d.snap ?? "", world: d.world.split(",").map(Number), hover2d: d.hover2d ?? "" }; })()`);
    const hoverInfo = async (p) => {
        const answer = async (q) => {
            await mouse("mouseMoved", q[0], q[1], { buttons: 0 });
            return until(`the hover answer at ${q}`, () => hoverAnswer(q), 10000);
        };
        if (await hoverAnswer(p)) await answer([p[0] + 1, p[1]]);
        return answer(p);
    };
    const key = async (k, code, vk, modifiers = 0) => {
        await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers });
    };
    const frames = () => evaluate("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
    const count = (list, kind) => evaluate(`document.querySelectorAll("#browser-${list} li[data-kind=${kind}]").length`);
    // a window's box in client CSS px: the canvas's box plus the viewport's rect the page publishes
    const windowBox = (which) => evaluate(`(() => { const c = document.getElementById("view"); const r = c.getBoundingClientRect();
        const [x, y, w, h] = c.dataset.${which}.split(",").map(Number); return [r.left + x, r.top + y, w, h]; })()`);
    const patternCount = () => count("patterns", "pattern");
    const seamCount = () => count("seams", "seam");
    const field = (key) => `document.querySelector('#props [data-key="${key}"]')`;
    const setField = (key, value) => evaluate(`(() => { const e = ${field(key)}; if (!e) throw new Error("no field ${key}: the panel has " + [...document.querySelectorAll("#props [data-key]")].map((x) => x.dataset.key).join(", ")); e.value = ${JSON.stringify(String(value))}; e.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    // real typing: focus the field, select its text, insert the new text as the keyboard would
    const typeInto = async (key, text) => {
        await evaluate(`(() => { const e = ${field(key)}; e.focus(); e.select(); })()`);
        await send("Input.insertText", { text });
    };
    const ok = (what) => console.log(`ok - ${what}`);
    try {
        await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
        await send("Runtime.enable");
        await send("Log.enable");
        await send("Page.enable");
        await send("Page.bringToFront");
        await send("Emulation.setFocusEmulationEnabled", { enabled: true });
        await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
        const downloads = mkdtempSync(join(tmpdir(), "atelier-dl-"));
        await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads, eventsEnabled: false });
        // a download lands in the folder; a later one of the same name replaces it (the old one is deleted first)
        const waitFile = (name) => until(`${name} downloaded`, () => { const f = join(downloads, name); return existsSync(f) && readFileSync(f, "utf8"); }, 30000);
        const takeFile = async (name) => { const t = await waitFile(name); rmSync(join(downloads, name), { force: true }); return t; };
        const pickInto = async (button, file, accept) => {
            await evaluate(`document.getElementById("${button}").click()`);
            const got = await evaluate(`document.getElementById("file-in").accept`);
            if (!got.includes(accept)) throw new Error(`${button}: the file input accepts ${got}`);
            const { result } = await send("Runtime.evaluate", { expression: `document.getElementById("file-in")` });
            await send("DOM.setFileInputFiles", { files: [file], objectId: result.objectId });
        };
        try {
            // V3: "Custom form…" -- the Body panel, Build from XS and XL, the measured girths, then a
            // garment draped on a posed form. Shots on ATELIER_SHOT_FORM_XS / _XL / ATELIER_SHOT_POSED.
            async function v3() {
                const shotTo = async (file) => { await evaluate(`document.querySelector("#props dd.measured")?.scrollIntoView({ block: "center" })`); await sleep(800); await frames(); const { data } = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(file, Buffer.from(data, "base64")); ok(`screenshot ${file}`); };
                const formKey = () => evaluate(`document.body.dataset.form ?? ""`);
                const action = (key) => evaluate(`${field(key)}.click()`);
                const build = async (what, key = "build") => {
                    const before = await formKey();
                    await action(key);
                    await until(`${what} built`, async () => { const k = await formKey(); return k && k !== before; }, 120000);
                    const ms = Number(await evaluate(`document.body.dataset.formMs ?? -1`)), inWorker = Number(await evaluate(`document.body.dataset.formWorkerMs ?? -1`));
                    await noStatusError();
                    failIfErrors();
                    return { ms, inWorker };
                };
                await evaluate(`document.querySelector('#browser-avatar li[data-kind=avatar]').click()`);
                await until("the Form select", () => evaluate(`!!${field("form")}`), 30000);
                const options = await evaluate(`[...${field("form")}.options].map((o) => o.value).join(",")`);
                if (!options.endsWith(",custom")) throw new Error(`the Form options: ${options}`);
                await setField("form", "custom");
                await until("the Body panel", () => evaluate(`!!${field("build")} && !!${field("left_leg.knee")}`), 30000);
                await setField("start", "XS");
                const bust = await evaluate(`${field("bust")}.value`);
                if (bust !== "80") throw new Error(`Start from XS: bust ${bust}`);
                const xs = await build("XS");
                // the read-outs: each girth measured on the form within 2 % of the asked-for
                const readouts = await evaluate(`[...document.querySelectorAll("#props dd.measured")].map((d) => d.textContent)`);
                const girths = readouts.map((t) => /^([\d.]+) cm \(asked ([\d.]+)\)$/.exec(t)).filter(Boolean);
                if (girths.length !== 3) throw new Error(`the girth read-outs: ${JSON.stringify(readouts)}`);
                for (const [t, measured, asked] of girths) if (Math.abs(measured - asked) / asked > 0.02) throw new Error(`a measured girth is off: ${t}`);
                if (await evaluate(`${field("form")}.value`) !== "custom") throw new Error("the Form select does not show the custom form");
                ok(`custom XS built: ${xs.ms} ms from Build to the form shown (${xs.inWorker} ms in the form worker); ${readouts.join("; ")}`);
                if (process.env.ATELIER_SHOT_FORM_XS) await shotTo(process.env.ATELIER_SHOT_FORM_XS);
                await setField("start", "XL");
                const xl = await build("XL");
                ok(`custom XL built: ${xl.ms} ms (${xl.inWorker} ms in the worker)`);
                if (process.env.ATELIER_SHOT_FORM_XL) await shotTo(process.env.ATELIER_SHOT_FORM_XL);
                // undo goes back to the XS form, redo to the XL
                const xlKey = await formKey();
                await evaluate(`document.activeElement?.blur()`);
                await key("z", "KeyZ", 90, 2);
                await until("undo: the XS form back", async () => { const k = await formKey(); return k && k !== xlKey && JSON.parse(k).measurements.bust === 80; }, 60000);
                await key("y", "KeyY", 89, 2);
                await until("redo: the XL form back", async () => (await formKey()) === xlKey, 60000);
                failIfErrors();
                ok("undo and redo rebuild the form the document names");
                // a garment on a posed form: open it (when given), Custom M with a head at A-pose, a knee bent, Apply, drape
                const hoodie = process.env.ATELIER_HOODIE;
                if (hoodie) {
                    await pickInto("menu-open", hoodie, ".json");
                    await until("the opened garment", async () => (await patternCount()) > 0, 30000);
                } else {
                    // earlier steps leave pieces: wait for the sample itself (its open clears the selection)
                    await evaluate(`document.getElementById("status-text").textContent = ""`);
                    await evaluate(`document.getElementById("menu-sample").click()`);
                    await until("the sample", () => evaluate(`document.getElementById("status-text").textContent === "opened the sample: a T-shirt"`), 30000);
                }
                await until("a garment", async () => (await patternCount()) > 0, 30000);
                await evaluate(`document.querySelector('#browser-avatar li[data-kind=avatar]').click()`);
                await until("the Body panel", () => evaluate(`!!${field("build")}`), 30000);
                await setField("start", "M");
                await setField("head", "true");
                await setField("preset", "A-pose");
                const knee = Number(process.env.ATELIER_KNEE ?? 30);
                await setField("left_leg.knee", String(knee));
                if (await evaluate(`${field("left_leg.knee")}.value`) !== String(knee)) throw new Error("the knee angle did not stay");
                await setField("left_leg.knee", "141");
                if (!/left knee must be from 0 to 140°/.test((await statusError()) ?? "")) throw new Error(`a knee of 141°: ${await evaluate(`document.getElementById("status-text").textContent`)}`);
                if (await evaluate(`${field("left_leg.knee")}.value`) !== String(knee)) throw new Error("a refused angle was kept");
                const posed = await build("the posed form", "apply");
                const lm = JSON.parse(await formKey());
                if (lm.pose.left_leg.knee !== knee || lm.pose.left_arm.abduction !== 45 || !lm.head) throw new Error(`the posed form: ${await formKey()}`);
                ok(`posed M (A-pose, left knee ${knee}°, head) built: ${posed.ms} ms (${posed.inWorker} ms in the worker)`);
                const health = () => evaluate(`document.getElementById("health").textContent`);
                const frameNo = async () => Number(/frame (\d+)/.exec(await health())?.[1] ?? -1);
                const simState = () => evaluate(`document.body.dataset.sim ?? "off"`);
                await evaluate(`document.getElementById("sim-toggle").click()`);
                await until("the cloth running", async () => (await simState()) === "running", 120000);
                const target = Number(process.env.ATELIER_DRAPE_FRAMES ?? 4);
                await until(`frame ${target}`, async () => (await frameNo()) >= target || (await simState()) !== "running", Math.max(120000, target * 3000));
                if ((await simState()) !== "running") throw new Error(`the drape stopped: ${await evaluate(`document.getElementById("status-text").textContent`)}`);
                if (process.env.ATELIER_SHOT_POSED) await shotTo(process.env.ATELIER_SHOT_POSED);
                ok(`a garment drapes on the posed form: ${await health()}`);
                await evaluate(`document.getElementById("sim-toggle").click()`);
                await until("paused", async () => (await simState()) !== "running", 60000);
                // a shipped form picked: the Body panel closes and the document forgets the form
                await setField("form", "f-M");
                await until("f-M back", () => evaluate(`document.querySelector('#browser-avatar li[data-kind=avatar]')?.textContent === "f-M" && !${field("build")}`), 60000);
                if (await formKey()) throw new Error("a shipped form still names a built one");
                failIfErrors();
                ok("a shipped form picked: the Body panel closes");
            }
            // 1. ready: the new document has one fabric, no patterns, and the avatar
            const clothWanted = (process.env.ATELIER_CLOTH ?? "").toLowerCase();
            await send("Page.navigate", { url: clothWanted === "cpu" ? `${base}/?cloth=cpu` : `${base}/` });
            await until("the worker's ready", () => evaluate(`document.body?.dataset.ready === "1"`), 90000);
            // the cloth engine: CPU when asked, else the GPU whenever the page has a WebGPU adapter
            const engine = await evaluate(`document.getElementById("sim-engine").textContent`);
            const adapter = await evaluate(`(async () => { try { return !!(navigator.gpu && await navigator.gpu.requestAdapter()); } catch { return false; } })()`);
            const engineWanted = clothWanted === "cpu" ? "CPU" : clothWanted === "gpu" || adapter ? "GPU · GIA on" : "CPU";
            if (engine !== engineWanted) throw new Error(`#sim-engine shows "${engine}", not "${engineWanted}" (ATELIER_CLOTH=${clothWanted || "-"}, WebGPU adapter ${adapter})`);
            // the GIA button: on and enabled on the GPU (on by default); on and disabled on the CPU (always on there)
            const giaButton = await evaluate(`(() => { const b = document.getElementById("sim-gia"); return b && { on: b.classList.contains("on"), disabled: b.disabled, title: b.title }; })()`);
            const giaWanted = engine === "CPU" ? { on: true, disabled: true } : { on: true, disabled: false };
            if (!giaButton || giaButton.on !== giaWanted.on || giaButton.disabled !== giaWanted.disabled) throw new Error(`the GIA button: ${JSON.stringify(giaButton)}, wanted ${JSON.stringify(giaWanted)}`);
            if (engine === "CPU" && !/always runs on the CPU/.test(giaButton.title)) throw new Error(`the GIA button's tooltip on the CPU: ${giaButton.title}`);
            if (!clothWanted && !adapter) console.log("note - no WebGPU adapter in this browser: the cloth runs on the CPU");
            await until("the default fabric", async () => (await count("fabrics", "fabric")) === 1, 30000);
            await until("the avatar", async () => (await count("avatar", "avatar")) === 1, 60000);
            // Place on avatar (spec §4) and the gizmo (spec §3) on the sample's Front (A2 lane;
            // ATELIER_A2_ONLY=1 runs it alone, on the sample, after the page is ready)
            const a2Block = async () => {
                const st = () => evaluate(`document.getElementById("status-text").textContent`);
                await evaluate(`[...document.querySelectorAll('#browser-patterns li[data-kind=pattern]')].find((li) => li.textContent === "Front").click()`);
                await until("the Front's panel", () => evaluate(`${field("slot")}?.value === "front"`), 30000);
                await evaluate(`document.querySelector('[data-tool3d=place]').click()`);
                if ((await evaluate(`getComputedStyle(document.querySelector(".place-opts")).display`)) === "none") throw new Error("the Wrap toggle is hidden with Place on");
                if (!(await evaluate(`document.getElementById("place-wrap").checked`))) throw new Error("Wrap is off by default");
                const [qx, qy, qw, qh] = await windowBox("rect3d");
                let placedAt = null;
                for (const [fx, fy] of [[0.5, 0.15], [0.5, 0.2], [0.5, 0.85], [0.45, 0.8], [0.55, 0.8], [0.5, 0.9], [0.5, 0.1], [0.4, 0.5], [0.6, 0.5]]) {
                    await evaluate(`document.getElementById("status-text").textContent = ""`);
                    await click([qx + qw * fx, qy + qh * fy]);
                    const t = await until("Place: an answer", async () => (await st()) || null, 30000);
                    if (t.startsWith("placed ")) { placedAt = [fx, fy]; break; }
                }
                if (!placedAt) throw new Error(`Place on avatar: never on the avatar (${await st()})`);
                await until("the at: slot", () => evaluate(`${field("slot")}?.value.startsWith("at:")`), 30000);
                const label = await evaluate(`${field("slot")}.selectedOptions[0].textContent`);
                if (label !== "On avatar") throw new Error(`the Slot select shows ${label}`);
                await evaluate(`document.querySelector('[data-tool3d=place]').click()`);
                await key("z", "KeyZ", 90, 2);
                await until("the front slot back", () => evaluate(`${field("slot")}?.value === "front"`), 30000);
                await noStatusError();
                failIfErrors();
                ok(`Place on avatar: a click at ${placedAt} put the Front on an at: slot ("On avatar"); one undo`);
                if (process.env.ATELIER_SHOT_PLACE) {
                    // the Left sleeve placed by a click on an arm, wrapped round it (a click elsewhere: flat)
                    const pick = (label) => evaluate(`[...document.querySelectorAll('#browser-patterns li[data-kind=pattern]')].find((li) => li.textContent === ${JSON.stringify(label)}).click()`);
                    await pick("Left sleeve");
                    await until("the sleeve's panel", () => evaluate(`${field("slot")}?.value === "left_arm"`), 30000);
                    await evaluate(`document.querySelector('[data-tool3d=place]').click()`);
                    let how = null;
                    const tries = [];
                    for (const fy of [0.3, 0.35, 0.4, 0.25, 0.45]) for (const fx of [0.62, 0.66, 0.7, 0.58, 0.74, 0.38, 0.34, 0.3, 0.42, 0.26]) tries.push([fx, fy]);
                    for (const [fx, fy] of tries) {
                        await evaluate(`document.getElementById("status-text").textContent = ""`);
                        await click([qx + qw * fx, qy + qh * fy]);
                        const t = await until("Place: an answer", async () => (await st()) || null, 30000);
                        if (t.includes("wrapped round the arm")) { how = `wrapped, a click at ${fx},${fy}`; break; }
                        if (t.startsWith("placed ")) { await key("z", "KeyZ", 90, 2); await until("the sleeve's slot back", () => evaluate(`${field("slot")}?.value === "left_arm"`), 30000); }
                    }
                    if (!how) {
                        await evaluate(`document.getElementById("status-text").textContent = ""`);
                        await click([qx + qw * placedAt[0], qy + qh * placedAt[1]]);
                        await until("Place: an answer", async () => (await st()) || null, 30000);
                        how = "flat (no arm click wrapped)";
                    }
                    await evaluate(`document.querySelector('[data-tool3d=place]').click()`);
                    await sleep(500); await frames();
                    const { data } = await send("Page.captureScreenshot", { format: "png" });
                    writeFileSync(process.env.ATELIER_SHOT_PLACE, Buffer.from(data, "base64"));
                    ok(`screenshot ${process.env.ATELIER_SHOT_PLACE}: the Left sleeve placed ${how}`);
                    await key("z", "KeyZ", 90, 2);
                    await until("the sleeve's slot back", () => evaluate(`${field("slot")}?.value === "left_arm"`), 30000);
                    await pick("Front");
                    await until("the Front's panel again", () => evaluate(`${field("slot")}?.value === "front"`), 30000);
                    await noStatusError();
                    failIfErrors();
                }

                // the gizmo (spec §3) over the selected Front: a drag of its X arrow moves it, the
                // slot becomes custom, one undo takes it back; Escape mid-drag puts it back
                const handles = async () => {
                    // settled: the same twice, 300 ms apart (an undo's redraw may still be on its way)
                    let h = null;
                    await until("the gizmo's handles", async () => { const was = h; await sleep(300); h = await evaluate(`document.body.dataset.gizmo || null`); return h && h === was; }, 30000);
                    const [vx, vy] = await evaluate(`(() => { const r = document.getElementById("view").getBoundingClientRect(); return [r.left, r.top]; })()`);
                    const dpr = await evaluate("devicePixelRatio");
                    return Object.fromEntries(Object.entries(JSON.parse(h)).filter(([, p]) => p).map(([k, p]) => [k, [vx + p[0] / dpr, vy + p[1] / dpr]]));
                };
                const grab = async (part) => {
                    const at = (await handles())[part];
                    if (!at) throw new Error(`the gizmo has no ${part} handle`);
                    const seen = [];
                    for (const [ox, oy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [2, 2], [-2, -2]]) {
                        await evaluate(`document.body.dataset.gizmoHover = "?"`);
                        await mouse("mouseMoved", at[0] + ox, at[1] + oy, { buttons: 0 });
                        const hv = await until("the gizmo hover", async () => { const v = await evaluate(`document.body.dataset.gizmoHover`); return v === "?" ? null : v || "none"; }, 10000);
                        seen.push(hv);
                        if (hv === part) return [at[0] + ox, at[1] + oy];
                    }
                    throw new Error(`the gizmo's ${part} is not under its handle at ${at} (hovers: ${seen.join(", ")}; handles ${await evaluate(`document.body.dataset.gizmo`)})`);
                };
                let g = await grab("tx");
                if (process.env.ATELIER_SHOT_GIZMO) {
                    await frames();
                    const { data } = await send("Page.captureScreenshot", { format: "png" });
                    writeFileSync(process.env.ATELIER_SHOT_GIZMO, Buffer.from(data, "base64"));
                    ok(`screenshot ${process.env.ATELIER_SHOT_GIZMO}`);
                }
                await mouse("mousePressed", g[0], g[1]);
                for (let i = 1; i <= 6; i++) { await mouse("mouseMoved", g[0] + 10 * i, g[1]); await sleep(40); }
                await until("the drag's read-out", async () => /^move along X \d/.test(await st()) || null, 30000);
                const readout = await st();
                await mouse("mouseReleased", g[0] + 60, g[1]);
                await until("the custom slot", () => evaluate(`${field("slot")}?.value === "custom"`), 30000);
                const glabel = await evaluate(`${field("slot")}.selectedOptions[0].textContent`);
                if (glabel !== "Custom (3D)") throw new Error(`the Slot select shows ${glabel} after a gizmo move`);
                await until("the gizmo move's status", async () => /^moved Front in 3D/.test(await st()) || null, 30000);
                await key("z", "KeyZ", 90, 2);
                await until("the front slot back after the gizmo's undo", () => evaluate(`${field("slot")}?.value === "front"`), 30000);
                // Escape mid-drag: nothing committed
                g = await grab("tx");
                await mouse("mousePressed", g[0], g[1]);
                for (let i = 1; i <= 4; i++) { await mouse("mouseMoved", g[0] + 10 * i, g[1]); await sleep(40); }
                await until("the second drag's read-out", async () => /^move along X \d/.test(await st()) || null, 30000);
                await key("Escape", "Escape", 27);
                await until("the cancel", async () => (await st()) === "gizmo move cancelled" || null, 30000);
                await mouse("mouseReleased", g[0] + 40, g[1]);
                await sleep(300);
                if ((await evaluate(`${field("slot")}?.value`)) !== "front") throw new Error("Escape did not cancel the gizmo move");
                await noStatusError();
                failIfErrors();
                ok(`gizmo: an X arrow drag (${readout}) made the slot custom; Ctrl+Z undid it; Escape cancels a drag`);
            };
            // S2 (darts and pleats): the T-shirt with three darts drawn on it, opened; a dart closed by
            // cutting, one by folding, one rotated (a hover previews it, a click moves it), a knife pleat
            // added with the Pleat tool; then the garment simulates. Alone: ATELIER_S2_ONLY=1.
            const s2Block = async () => {
                const dartAt = (x) => ({ kind: "dart", path: { start: [x - 30, 280], segments: [{ type: "line", to: [x, 430] }, { type: "line", to: [x + 30, 280] }] } });
                {
                    const src = new Atelier(await loadKernel());
                    src.load(readFileSync(join(root, "assets", "tshirt.json"), "utf8"));
                    const add = (id, lines) => src.apply(mm.setPattern(src.nodes(), id, { internal: [...(src.nodes().find((n) => n.id === id).internal ?? []), ...lines] }), "darts");
                    add("p1", [dartAt(-170), dartAt(170)]);
                    add("p2", [dartAt(580)]);
                    writeFileSync(join(downloads, "darts.json"), src.save());
                    src.free();
                }
                const saveDoc = async () => { await key("s", "KeyS", 83, 2); return JSON.parse(await takeFile("garment.json")); };
                const nodeIn = (doc, id) => doc.nodes.find((n) => n.id === id);
                const statusNow = () => evaluate(`document.getElementById("status-text").textContent`);
                const simNow = () => evaluate(`document.body.dataset.sim ?? "off"`);
                const healthNow = () => evaluate(`document.getElementById("health").textContent`);
                const shot = async (what) => {
                    if (!process.env.ATELIER_SHOT_S2) return;
                    const { data } = await send("Page.captureScreenshot", { format: "png" });
                    writeFileSync(process.env.ATELIER_SHOT_S2.replace(/(\.png)?$/i, `-${what}.png`), Buffer.from(data, "base64"));
                };
                await evaluate(`document.getElementById("menu-new").click()`);
                await until("an empty document for the darts", async () => (await patternCount()) === 0, 30000);
                await pickInto("menu-open", join(downloads, "darts.json"), ".json");
                await until("the T-shirt with darts", async () => (await patternCount()) === 4 && (await seamCount()) === 10, 30000);
                await evaluate(`document.querySelector('#tools2d [data-tool=edit]').click()`);
                await evaluate(`document.querySelector('#tools2d [data-command=fit]').click()`);
                await sleep(500);
                // the 2D window's mapping, from three hovers
                const [ux, uy, uw, uh] = await windowBox("rect2d");
                const P0 = [Math.round(ux + uw / 2), Math.round(uy + uh / 2)];
                const W0 = (await hoverInfo(P0)).world, W1 = (await hoverInfo([P0[0] + 60, P0[1]])).world, W2 = (await hoverInfo([P0[0], P0[1] + 60])).world;
                const sx = (W1[0] - W0[0]) / 60, sy = (W2[1] - W0[1]) / 60;
                const screenOf = ([x, y]) => [P0[0] + (x - W0[0]) / sx, P0[1] + (y - W0[1]) / sy];
                // a click on a dart's leg selects the line: its panel offers the action
                const pickDart = async (x, key) => {
                    for (const f of [0.5, 0.35, 0.65, 0.25, 0.75]) {
                        await evaluate(`document.querySelector('#tools2d [data-tool=edit]').click()`);
                        await click(screenOf([x - 30 + 30 * f, 280 + 150 * f]));
                        try { await until(`the dart at ${x} selected`, () => evaluate(`!!${field(key)}`), 3000); return; } catch { /* the next point along the leg */ }
                    }
                    throw new Error(`no ${key} on the dart at ${x}: the panel has ${await evaluate(`document.getElementById("props").textContent`)}`);
                };
                // Close (cut): the outline takes the legs, a seam sews them
                await pickDart(-170, "dart_cut");
                await evaluate(`${field("dart_cut")}.click()`);
                await until("the cut dart's seam", async () => (await seamCount()) === 11, 30000)
                    .catch(async (e) => { throw new Error(`${e.message}: status "${await statusNow()}"`); });
                let doc = await saveDoc();
                const front = () => nodeIn(doc, "p1"), back = () => nodeIn(doc, "p2");
                if (front().internal.filter((l) => l.kind === "dart").length !== 1) throw new Error(`the cut dart is still a mark: ${JSON.stringify(front().internal.map((l) => l.kind))}`);
                const outline = nodeIn(doc, "p1_outline").path;
                if (![outline.start, ...outline.segments.map((s) => s.to)].some((p) => p && Math.hypot(p[0] + 170, p[1] - 430) < 1e-6)) throw new Error("the cut dart's apex is not on the outline");
                await noStatusError();
                ok("dart: Close (cut) took the wedge out of the Front's outline and sewed its legs");
                // Close (fold): legs, a 360° centre fold, tacks
                await pickDart(170, "dart_fold");
                await evaluate(`${field("dart_fold")}.click()`);
                await until("the folded dart's tacks", async () => ((doc = await saveDoc()), (nodeIn(doc, "garment").tacks ?? []).length >= 2), 30000)
                    .catch(async (e) => { throw new Error(`${e.message}: status "${await statusNow()}"`); });
                if (!front().internal.some((l) => l.kind === "fold" && l.angle === 360)) throw new Error(`no centre fold: ${JSON.stringify(front().internal)}`);
                await noStatusError();
                ok(`dart: Close (fold) made legs, a centre fold and ${nodeIn(doc, "garment").tacks.length} tacks`);
                // Rotate…: a hover on the Back's hem previews the dart there, a click moves it
                await pickDart(580, "dart_rotate");
                await evaluate(`${field("dart_rotate")}.click()`);
                await until("Rotate armed", async () => /^rotate:/.test(await statusNow()), 30000);
                await hoverInfo(screenOf([700, 290]));
                await hoverInfo(screenOf([720, 280]));
                await sleep(800);
                await shot("rotate");
                await noStatusError();
                await click(screenOf([720, 280]));
                await until("the rotated dart", async () => {
                    doc = await saveDoc();
                    const d = back().internal?.find((l) => l.kind === "dart");
                    return d && Math.hypot(d.path.start[0] - 720, d.path.start[1] - 280) < 4;
                }, 30000).catch(async (e) => { throw new Error(`${e.message}: status "${await statusNow()}", ${JSON.stringify(back().internal)}`); });
                await noStatusError();
                ok("dart: Rotate… previewed on hover, a click moved the Back's dart to the hem point");
                // the Pleat tool: the placement line up from the Front's hem, a drag across, Enter
                const tacks0 = (nodeIn(doc, "garment").tacks ?? []).length;
                await evaluate(`document.querySelector('#tools2d [data-tool=pleat]').click()`);
                await drag(screenOf([-40, 280]), screenOf([-40, 980]));
                await drag(screenOf([-40, 350]), screenOf([80, 350]));
                await until("the pleat panel", () => evaluate(`/^Pleats on Front/.test(document.querySelector("#props h3")?.textContent ?? "")`), 30000)
                    .catch(async (e) => { throw new Error(`${e.message}: status "${await statusNow()}"`); });
                if ((await evaluate(`${field("kind")}.value`)) !== "knife") throw new Error("not a knife pleat by default");
                await sleep(500);
                await shot("pleat");
                await noStatusError();
                await evaluate(`document.getElementById("view").focus()`);
                await key("Enter", "Enter", 13);
                await until("the pleats", async () => ((doc = await saveDoc()), front().pleats?.length === 1), 30000)
                    .catch(async (e) => { throw new Error(`${e.message}: status "${await statusNow()}"`); });
                const group = front().pleats[0];
                if (group.spec.kind !== "knife" || !group.internal.every((i) => front().internal[i].prefold === true)) throw new Error(`the pleat group: ${JSON.stringify(group)}`);
                if ((nodeIn(doc, "garment").tacks ?? []).length !== tacks0 + group.tacks.length || !group.tacks.length) throw new Error(`the pleats' top tacks: ${JSON.stringify(group.tacks)}`);
                await noStatusError();
                ok(`Pleat: ${group.spec.count} knife pleat(s), ${group.internal.length} pre-folded lines, ${group.tacks.length} top tack(s)`);
                // the group selected by a click on one of its lines: its depth edited (one undo step), Delete, Ctrl+Z
                let picked = false;
                for (const y of [600, 500, 700, 450]) {
                    await evaluate(`document.querySelector('#tools2d [data-tool=edit]').click()`);
                    await click(screenOf([-40, y]));
                    try { await until("the pleat group selected", () => evaluate(`!!${field("pleat_depth")}`), 3000); picked = true; break; } catch { /* the next point along it */ }
                }
                if (!picked) throw new Error(`no pleat panel: ${await evaluate(`document.getElementById("props").textContent`)}`);
                await setField("pleat_depth", "15");
                await until("the pleats 15 deep", async () => ((doc = await saveDoc()), front().pleats?.[0]?.spec.depth === 15), 30000)
                    .catch(async (e) => { throw new Error(`${e.message}: status "${await statusNow()}"`); });
                if (front().internal.filter((l) => l.prefold).length !== 2) throw new Error("the edit left the old folds");
                await until("the edited group still selected", () => evaluate(`!!${field("pleat_remove")}`), 30000);
                await evaluate(`document.getElementById("view").focus()`);
                await key("Delete", "Delete", 46);
                await until("the pleats removed", async () => ((doc = await saveDoc()), !front().pleats && !front().internal.some((l) => l.prefold)), 30000)
                    .catch(async (e) => { throw new Error(`${e.message}: status "${await statusNow()}"`); });
                if ((nodeIn(doc, "garment").tacks ?? []).length !== tacks0) throw new Error("Delete left the pleats' tacks");
                await key("z", "KeyZ", 90, 2);
                await until("the pleats back", async () => ((doc = await saveDoc()), front().pleats?.[0]?.spec.depth === 15), 30000);
                await noStatusError();
                ok("Pleat group: selected by a click on a fold, its depth set to 15 (remove + add in one batch), Delete removed it, Ctrl+Z brought it back");
                // simulate: the cloth builds and runs
                await evaluate(`document.getElementById("sim-toggle").click()`);
                await until("the cloth running", async () => (await simNow()) === "running", 120000)
                    .catch(async (e) => { throw new Error(`${e.message}: status "${await statusNow()}", health "${await healthNow()}"`); });
                await until("three frames", async () => Number(/frame (\d+)/.exec(await healthNow())?.[1] ?? -1) >= 3, 180000);
                await shot("sim");
                failIfErrors();
                ok(`darts and pleats simulate: ${await healthNow()}`);
                await evaluate(`document.getElementById("sim-reset").click()`);
                await until("reset", async () => (await simNow()) === "off", 30000);
                // an empty document after: placed pieces would add a re-arrange step to what follows (V3's undo)
                await evaluate(`document.getElementById("menu-new").click()`);
                await until("an empty document after the darts", async () => (await patternCount()) === 0, 30000);
                failIfErrors();
            };
            if (process.env.ATELIER_S2_ONLY === "1") { await s2Block(); failIfErrors(); ok("S2 block alone"); return; }
            if (process.env.ATELIER_V3_ONLY === "1") { await v3(); failIfErrors(); ok("V3 block alone"); return; }
            if (process.env.ATELIER_A2_ONLY === "1") {
                await evaluate(`document.getElementById("menu-sample").click()`);
                await until("the T-shirt", async () => (await patternCount()) === 4, 30000);
                await until("the sample's Front in 3D", () => evaluate(`!!document.getElementById("view").dataset.rect3d`), 30000);
                await a2Block(); failIfErrors(); ok("A2 block alone"); return;
            }
            const robots = await evaluate(`document.querySelector('meta[name=robots]')?.content`);
            if (robots !== "noindex") throw new Error(`robots meta is ${robots}`);
            const fps = await evaluate(`document.getElementById("fps").textContent`);
            if (fps !== "—") throw new Error(`#fps shows ${fps}`);
            const sim = await evaluate(`(() => { const b = document.querySelector('#tools3d [data-command=simulate]'); return b && !b.disabled && document.getElementById("sim-reset").disabled; })()`);
            if (!sim) throw new Error("Simulate should be on and Reset off");
            failIfErrors();
            ok(`ready: one fabric, the f-M avatar, Simulate on; cloth engine ${engine}`);

            // 1b. the 2D window is the View's: items on it, and a hover over the empty window hits nothing
            await until("the 2D window ready", async () => (await evaluate(`document.getElementById("view").dataset.rect2d ?? ""`)).split(",").length === 4, 30000);
            const [ex0, ey0, ew0, eh0] = await windowBox("rect2d");
            await mouse("mouseMoved", ex0 + ew0 / 2, ey0 + eh0 / 2, { buttons: 0 });
            await until("a hover over the empty window answered", async () => (await evaluate(`document.body.dataset.world ?? ""`)).includes(","), 30000);
            if ((await evaluate(`document.body.dataset.hit ?? ""`)) !== "") throw new Error("a hover over the empty window hit something");
            failIfErrors();
            ok("one canvas: 3D and 2D viewports");

            // 2. a rectangle: the tool's button, then a drag on the 2D window
            await evaluate(`document.querySelector('#tools2d [data-tool=rectangle]').click()`);
            const [x, y, w, h] = await windowBox("rect2d");
            const at = (fx, fy) => [x + w * fx, y + h * fy];
            const a = at(0.15, 0.3), b = at(0.4, 0.7);
            await drag(a, b);
            await until("one pattern in the browser", async () => (await patternCount()) === 1, 30000);
            const back = await evaluate(`document.querySelector('#tools2d [data-tool].on')?.dataset.tool`);
            if (back !== "edit") throw new Error(`after the rectangle the tool is ${back}, not edit`);

            // select it from the browser: marked there and in the property panel
            await evaluate(`document.querySelector('#browser-patterns li[data-kind=pattern]').click()`);
            if (!(await evaluate(`document.querySelector('#browser-patterns li[data-kind=pattern]').classList.contains("on")`))) throw new Error("the browser item is not marked selected");
            const props = await evaluate(`document.getElementById("props").textContent`);
            if (!/Pattern/.test(props)) throw new Error(`#props shows: ${props}`);

            // the edit tool drags a corner: previews, then one commit; the piece grows
            const width = () => evaluate(`Number(/size\\s*(\\d+)/.exec(document.getElementById("props").textContent)?.[1])`);
            const w0 = await width();
            // the selected piece's edit points are drawn a frame after the selection: hover until the corner answers
            await until("the corner under the pointer", async () => { await mouse("mouseMoved", b[0], b[1], { buttons: 0 }); await sleep(100); return (await evaluate(`document.body.dataset.hit ?? ""`)) === "point"; }, 30000);
            await mouse("mousePressed", b[0], b[1]);
            for (let i = 1; i <= 6; i++) { await mouse("mouseMoved", b[0] + i * 10, b[1]); await sleep(30); }
            await mouse("mouseReleased", b[0] + 60, b[1]);
            await until("the corner moved", async () => (await width()) > w0 + 20, 30000);
            ok("rectangle drawn, listed, selected, corner dragged");

            // F3 / F2 maximise and restore
            for (const [k, code, vk, cls] of [["F3", "F3", 114, "max3d"], ["F2", "F2", 113, "max2d"]]) {
                await key(k, code, vk);
                await frames();
                if (!(await evaluate(`document.getElementById("split").classList.contains("${cls}")`))) throw new Error(`${k} did not maximise`);
                await sleep(300);
                // the maximised window takes the height: the toolbar row is the visible strip alone
                // (the hidden strip must not wrap down the screen), one line for the 3D strip (the 2D
                // strip's own ~40 buttons take two at 1340 px), and the window's rect is the visible strip's
                const [shown, hidden, rect, gone] = cls === "max3d" ? ["tools3d", "tools2d", "rect3d", "rect2d"] : ["tools2d", "tools3d", "rect2d", "rect3d"];
                const lay = await evaluate(`(() => { const s = document.getElementById("${shown}"), c = document.getElementById("view").getBoundingClientRect();
                    const tops = [...s.querySelectorAll("button")].filter((b) => b.offsetParent).map((b) => Math.round(b.getBoundingClientRect().top));
                    return { strip: s.getBoundingClientRect().toJSON(), hidden: document.getElementById("${hidden}").getBoundingClientRect().height,
                        lines: new Set(tops).size, row: c.top - document.getElementById("split").getBoundingClientRect().top, canvas: c.toJSON(), win: document.getElementById("view").dataset.${rect}, gone: document.getElementById("view").dataset.${gone} }; })()`);
                const [wx, , ww, wh] = lay.win.split(",").map(Number);
                if (!(wh > 0.7 * H)) throw new Error(`${k}: the window is ${wh} px tall of ${H} (${JSON.stringify(lay)})`);
                const most = cls === "max3d" ? 1 : 2;
                if (lay.lines > most || lay.strip.height > 36 * most) throw new Error(`${k}: the toolbar is ${lay.lines} lines, ${lay.strip.height} px (${JSON.stringify(lay)})`);
                if (Math.abs(lay.row - lay.strip.height) > 1) throw new Error(`${k}: the toolbar row is ${lay.row} px, the visible strip ${lay.strip.height} px`);
                if (lay.hidden > 40) throw new Error(`${k}: the hidden strip is ${lay.hidden} px tall`);
                if (Math.abs(lay.canvas.left + wx - lay.strip.left) > 1 || Math.abs(ww - lay.strip.width) > 1) throw new Error(`${k}: the window ${lay.win} is not under its strip (${JSON.stringify(lay)})`);
                if (Math.abs(wh - lay.canvas.height) > 1) throw new Error(`${k}: the window ${lay.win} is not the canvas's height ${lay.canvas.height}`);
                if (lay.gone.split(",").map(Number)[2] !== 0) throw new Error(`${k}: the hidden window still has a rect ${lay.gone}`);
                console.log(`# ${k}: window ${lay.win}, toolbar ${lay.lines} line(s), ${lay.row} px`);
                await key(k, code, vk);
                await frames();
                if (await evaluate(`document.getElementById("split").className`)) throw new Error(`${k} again did not restore`);
            }

            // arrange: the piece goes to a slot around the avatar
            await evaluate(`document.querySelector('#tools3d [data-command=arrange]').click()`);
            await until("the piece arranged", () => evaluate(`${field("slot")}?.value === "front"`), 30000);
            await sleep(500);
            await noStatusError();
            failIfErrors();
            ok("F2/F3 (the maximised window takes the height), arrange");

            // the property editor: a label, the slot, a fractional layer refused, a fabric's weight
            await setField("label", "Bodice");
            await until("the new label", () => evaluate(`document.querySelector('#browser-patterns li[data-kind=pattern]').textContent === "Bodice"`), 30000);
            await setField("slot", "back");
            await until("the back slot", () => evaluate(`${field("slot")}?.value === "back"`), 30000);
            await setField("slot", "front");
            await until("the front slot", () => evaluate(`${field("slot")}?.value === "front"`), 30000);
            await setField("layer", "1.5");
            if (!(await statusError())) throw new Error("a fractional layer was not refused");
            await evaluate(`document.querySelector('#browser-fabrics li[data-kind=fabric]').click()`);
            await setField("density", "150");
            await until("the weight", () => evaluate(`${field("density")}?.value === "150"`), 30000);
            ok("label, slot, fractional layer refused, fabric weight");

            // Tab out of a fabric field: the edit commits, the panel is rebuilt, and the focus lands in the next field
            const keys = await evaluate(`[...document.querySelectorAll("#props [data-key]")].map((e) => e.dataset.key)`);
            const next = keys[keys.indexOf("density") + 1];
            await typeInto("density", "160");
            await key("Tab", "Tab", 9);
            await until("the typed weight", () => evaluate(`${field("density")}?.value === "160"`), 30000);
            await sleep(300);
            const focused = await evaluate(`document.activeElement?.dataset?.key ?? document.activeElement?.tagName`);
            if (focused !== next) throw new Error(`after Tab from density the focus is on ${focused}, not ${next}`);
            await evaluate(`document.activeElement.blur()`);
            ok(`Tab from the weight field: committed 160, focus in ${next}`);

            // the fabric library: add a preset, it is listed
            await evaluate(`(() => { document.getElementById("lib-select").value = "denim"; document.getElementById("lib-add").click(); })()`);
            await until("the denim fabric", async () => (await count("fabrics", "fabric")) === 2, 30000);
            failIfErrors();
            ok("fabric library: denim added");

            // 3. a second rectangle, and the two sewn side to side with the Sew sides tool:
            // the first piece's left side to the second's right side
            await evaluate(`document.querySelector('#tools2d [data-tool=rectangle]').click()`);
            const c = at(0.6, 0.35), d = at(0.8, 0.65);
            await drag(c, d);
            await until("two patterns in the browser", async () => (await patternCount()) === 2, 30000);
            await evaluate(`document.querySelector('#tools2d [data-tool=segment]').click()`);
            await click([a[0], (a[1] + b[1]) / 2]);
            await click([d[0], (c[1] + d[1]) / 2]);
            await until("one seam in the browser", async () => (await seamCount()) === 1, 30000);
            await noStatusError();
            failIfErrors();
            ok("second rectangle, segment-sewn: one seam");

            // a click on the seam with the edit tool selects the seam (it lies on the outline);
            // Delete removes it and Ctrl+Z brings it back
            const seamOn = () => evaluate(`!!document.querySelector('#browser-seams li[data-kind=seam].on')`);
            await evaluate(`document.querySelectorAll('#browser-patterns li[data-kind=pattern]')[1].click()`);
            if (await seamOn()) throw new Error("the seam is still selected after picking a piece");
            await click([a[0], (a[1] + b[1]) / 2]);
            await until("the seam selected by a 2D click", seamOn, 30000);
            await key("Delete", "Delete", 46);
            await until("the seam deleted", async () => (await seamCount()) === 0, 30000);
            await key("z", "KeyZ", 90, 2);
            await until("the seam back after Ctrl+Z", async () => (await seamCount()) === 1, 30000);
            // the second piece's "Remove piece" takes it and its seam; Ctrl+Z restores both
            await evaluate(`document.querySelectorAll('#browser-patterns li[data-kind=pattern]')[1].click()`);
            await until("the Remove piece button", () => evaluate(`!!${field("remove")}`), 30000);
            await evaluate(`${field("remove")}.click()`);
            await until("the piece removed", async () => (await patternCount()) === 1 && (await seamCount()) === 0, 30000);
            await key("z", "KeyZ", 90, 2);
            await until("the piece back after Ctrl+Z", async () => (await patternCount()) === 2 && (await seamCount()) === 1, 30000);
            await noStatusError();
            failIfErrors();
            ok("seam picked in 2D, deleted, undone; piece removed with its seam, undone");

            // M:N sewing (A2 spec §1): the Sew M:N tool (B) takes the first piece's top and bottom
            // (side A), Enter, the second piece's top (side B), Enter: one group of two kernel seams,
            // listed once. Selecting it shows Ungroup; Delete removes both; Ctrl+Z brings both back.
            {
                const groupItem = () => evaluate(`[...document.querySelectorAll('#browser-seams li[data-kind=seam]')].map((li) => li.textContent).find((t) => /M:N/.test(t)) ?? ""`);
                await key("b", "KeyB", 66);
                await until("the Sew M:N tool", () => evaluate(`document.querySelector('#tools2d [data-tool].on')?.dataset.tool === "sewmn"`), 10000);
                await click([a[0] + 0.25 * (b[0] - a[0]), a[1]]);
                await click([a[0] + 0.25 * (b[0] - a[0]), b[1]]);
                await until("side A's two ranges drawn", () => evaluate(`document.body.dataset.labels2d === "A1|A2"`), 10000);
                await key("Enter", "Enter", 13);
                await click([c[0] + 0.25 * (d[0] - c[0]), c[1]]);
                await until("side B's range drawn", () => evaluate(`document.body.dataset.labels2d === "A1|A2|B1"`), 10000);
                await key("Enter", "Enter", 13);
                await until("the M:N group in the browser", async () => (await seamCount()) === 2 && /M:N, 2 seams/.test(await groupItem()), 30000);
                await noStatusError();
                const pickGroup = () => evaluate(`[...document.querySelectorAll('#browser-seams li[data-kind=seam]')].find((li) => /M:N/.test(li.textContent)).click()`);
                await pickGroup();
                await until("the group's panel", () => evaluate(`!!${field("ungroup")} && /Seam group/.test(document.getElementById("props").textContent)`), 30000);
                if (process.env.ATELIER_SHOT_MN) {
                    await sleep(500); await frames();
                    const { data } = await send("Page.captureScreenshot", { format: "png" });
                    writeFileSync(process.env.ATELIER_SHOT_MN, Buffer.from(data, "base64"));
                    ok(`screenshot ${process.env.ATELIER_SHOT_MN}`);
                }
                await key("Delete", "Delete", 46);
                await until("the group deleted", async () => (await seamCount()) === 1 && !(await groupItem()), 30000);
                await key("z", "KeyZ", 90, 2);
                await until("the group back after Ctrl+Z", async () => /M:N, 2 seams/.test(await groupItem()), 30000);
                // Ungroup: two plain seams; Ctrl+Z, then the group goes again (the steps below expect one seam)
                await pickGroup();
                await until("the Ungroup button", () => evaluate(`!!${field("ungroup")}`), 30000);
                await evaluate(`${field("ungroup")}.click()`);
                await until("ungrouped: three plain seams", async () => (await seamCount()) === 3 && !(await groupItem()), 30000);
                await key("z", "KeyZ", 90, 2);
                await until("the group back after Ctrl+Z", async () => /M:N, 2 seams/.test(await groupItem()), 30000);
                await pickGroup();
                await until("the group's panel", () => evaluate(`!!${field("ungroup")}`), 30000);
                await key("Delete", "Delete", 46);
                await until("the group deleted", async () => (await seamCount()) === 1 && !(await groupItem()), 30000);
                await noStatusError();
                failIfErrors();
                ok("Sew M:N: a 2 -> 1 group of two seams, listed once; deleted and undone; ungrouped and undone");
            }

            // the Move tool: a drag with pauses (several previews) moves the piece by exactly the drag
            const outlineOf = (json, label) => {
                const p = json.nodes.find((n) => n.kind === "garment.pattern" && n.label === label);
                return json.nodes.find((n) => n.id === p.outline).path;
            };
            const saveNow = async () => { await key("s", "KeyS", 83, 2); return JSON.parse(await takeFile("garment.json")); };
            const before = outlineOf(await saveNow(), "Piece 2");
            const xs = [before.start[0], ...before.segments.map((s) => s.to[0])];
            const worldPerPx = (Math.max(...xs) - Math.min(...xs)) / (d[0] - c[0]);
            await evaluate(`document.querySelector('#tools2d [data-tool=transform]').click()`);
            const from = [(c[0] + d[0]) / 2, (c[1] + d[1]) / 2], by = [80, 40];
            await mouse("mouseMoved", from[0], from[1], { buttons: 0 });
            await mouse("mousePressed", from[0], from[1]);
            for (let i = 1; i <= 8; i++) { await mouse("mouseMoved", from[0] + (by[0] * i) / 8, from[1] + (by[1] * i) / 8); await sleep(60); }
            await mouse("mouseReleased", from[0] + by[0], from[1] + by[1]);
            const after = outlineOf(await saveNow(), "Piece 2");     // the save waits for the drag's last step
            await evaluate(`document.querySelector('#tools2d [data-tool=edit]').click()`);
            const moved = [after.start[0] - before.start[0], after.start[1] - before.start[1]];
            const want = [by[0] * worldPerPx, -by[1] * worldPerPx];
            if (Math.hypot(moved[0] - want[0], moved[1] - want[1]) > 0.5) throw new Error(`the Move tool moved the piece by ${moved.map((v) => v.toFixed(2))}, not ${want.map((v) => v.toFixed(2))}`);
            await noStatusError();
            failIfErrors();
            ok(`Move: the piece moved by exactly the drag (${moved.map((v) => v.toFixed(1)).join(", ")} mm)`);

            // A3: the Move tool's rotate handle, above the selection's box: a Shift drag from straight
            // above the box centre round to (nearly) straight left of it turns Piece 2 an exact
            // quarter about its centre (88 degrees snapped to 90), its seam kept; Ctrl+Z undoes it
            {
                const boxOf = (path) => { const ps = [path.start, ...path.segments.map((s) => s.to)];
                    return [Math.min(...ps.map((q) => q[0])), Math.min(...ps.map((q) => q[1])), Math.max(...ps.map((q) => q[0])), Math.max(...ps.map((q) => q[1]))]; };
                const b0 = boxOf(after);
                await evaluate(`document.querySelectorAll('#browser-patterns li[data-kind=pattern]')[1].click()`);
                await evaluate(`document.querySelector('#tools2d [data-tool=transform]').click()`);
                const mid = [from[0] + by[0], from[1] + by[1]];      // the piece's centre on screen, after the move
                const halfH = (b0[3] - b0[1]) / 2 / worldPerPx;
                let rotAt = null;
                for (let up = 8; up <= 70 && !rotAt; up += 3) { const q = [mid[0], mid[1] - halfH - up]; if ((await hoverInfo(q)).hit === "xform") rotAt = q; }
                if (!rotAt) throw new Error("no rotate handle above the selection's box");
                const r = mid[1] - rotAt[1], end = (88 * Math.PI) / 180;
                const shift = (type) => send("Input.dispatchKeyEvent", { type, key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: type === "keyUp" ? 0 : 8 });
                await shift("rawKeyDown");
                await mouse("mouseMoved", rotAt[0], rotAt[1], { buttons: 0, modifiers: 8 });
                await mouse("mousePressed", rotAt[0], rotAt[1], { modifiers: 8 });
                // screen y runs down: a turn of `t` from straight up, counter-clockwise on the pattern
                const on = (t) => [mid[0] - r * Math.sin(t), mid[1] - r * Math.cos(t)];
                for (let i = 1; i <= 8; i++) { const q = on((end * i) / 8); await mouse("mouseMoved", q[0], q[1], { modifiers: 8 }); await sleep(60); }
                const q = on(end);
                await mouse("mouseReleased", q[0], q[1], { modifiers: 8 });
                await shift("keyUp");
                const turned = await saveNow();                      // the save waits for the drag's last step
                const b1 = boxOf(outlineOf(turned, "Piece 2"));
                const centre = (b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
                const sizes = (b) => [b[2] - b[0], b[3] - b[1]];
                const off = Math.hypot(centre(b1)[0] - centre(b0)[0], centre(b1)[1] - centre(b0)[1]);
                if (off > 1e-6 || Math.abs(sizes(b1)[0] - sizes(b0)[1]) > 1e-6 || Math.abs(sizes(b1)[1] - sizes(b0)[0]) > 1e-6)
                    throw new Error(`the rotate handle gave ${b1.map((v) => v.toFixed(3))} from ${b0.map((v) => v.toFixed(3))}: not a quarter turn about its centre`);
                if (turned.nodes.filter((n) => n.kind === "garment.seam").length !== 1) throw new Error("the turned piece lost its seam");
                await key("z", "KeyZ", 90, 2);
                const back = boxOf(outlineOf(await saveNow(), "Piece 2"));
                if (back.some((v, i) => Math.abs(v - b0[i]) > 1e-6)) throw new Error(`Ctrl+Z after the turn left ${back}, not ${b0}`);
                await evaluate(`document.querySelector('#tools2d [data-tool=edit]').click()`);
                await noStatusError();
                failIfErrors();
                ok("Move: the rotate handle turned the piece a Shift-snapped quarter about its centre, seam kept; one Ctrl+Z undid it");
            }

            // 4. type an allowance into the field and press Ctrl+S at once: the save holds the typed value
            await evaluate(`document.querySelector('#browser-patterns li[data-kind=pattern]').click()`);
            await until("the Bodice's fields", () => evaluate(`!!${field("allowance")}`), 30000);
            await typeInto("allowance", "14");
            await key("s", "KeyS", 83, 2);
            const json = JSON.parse(await takeFile("garment.json"));
            const patterns = json.nodes.filter((n) => n.kind === "garment.pattern");
            if (patterns.length !== 2) throw new Error(`the saved garment has ${patterns.length} garment.pattern nodes, not 2`);
            const bodice = patterns.find((p) => p.label === "Bodice");
            if (!bodice) throw new Error("the saved garment.json has no Bodice");
            if (JSON.stringify(bodice.allowance) !== "[14]") throw new Error(`the saved allowance is ${JSON.stringify(bodice.allowance)}, not the typed [14]`);
            if (json.nodes.filter((n) => n.kind === "garment.seam").length !== 1) throw new Error("the saved garment lost its seam");
            ok("typed allowance + Ctrl+S: saved, 2 garment.pattern nodes, allowance [14], one seam");
            const saved = join(downloads, "saved.json");
            writeFileSync(saved, JSON.stringify(json));

            // Save -> New -> Open: the garment comes back
            await evaluate(`document.getElementById("menu-new").click()`);
            await until("an empty document", async () => (await patternCount()) === 0, 30000);
            await pickInto("menu-open", saved, ".json");
            await until("the opened garment", async () => (await patternCount()) === 2 && (await seamCount()) === 1, 30000);
            if (!(await evaluate(`[...document.querySelectorAll('#browser-patterns li[data-kind=pattern]')].some((li) => li.textContent === "Bodice")`))) throw new Error("the opened garment has no Bodice");
            if ((await count("fabrics", "fabric")) !== 2) throw new Error("the opened garment lost a fabric");
            await noStatusError();
            failIfErrors();
            ok("New, then Open: two patterns, one seam, two fabrics back");

            // an STL avatar (spec §7): f-M written as an STL through the kernel's reader loads, with
            // no landmarks; the Form select below brings f-M back
            const stlFile = join(downloads, "f-M-stl.stl");
            {
                const k = await loadKernel();
                const sc = k.open(new Uint8Array(readFileSync(join(root, "assets", "f-M.stp"))), "step", undefined, "native");
                try { writeFileSync(stlFile, stlOf(sc)); } finally { sc.free(); }
            }
            await pickInto("menu-avatar", stlFile, ".stl");
            await until("the STL avatar", () => evaluate(`document.querySelector('#browser-avatar li[data-kind=avatar]')?.textContent === "f-M-stl"`), 60000);
            if ((await evaluate(`document.body.dataset.avatarHead`)) !== "0") throw new Error("the STL avatar has a head");
            await noStatusError();
            failIfErrors();
            ok("STL avatar: f-M as an STL loads");

            // the Form select: f-M with head loads, its landmarks carry a head; back to f-M
            await evaluate(`document.querySelector('#browser-avatar li[data-kind=avatar]').click()`);
            await until("the Form select", () => evaluate(`!!${field("form")}`), 30000);
            await setField("form", "f-M-head");
            await until("f-M-head loaded", () => evaluate(`document.querySelector('#browser-avatar li[data-kind=avatar]')?.textContent === "f-M-head"`), 60000);
            if ((await evaluate(`document.body.dataset.avatarHead`)) !== "1") throw new Error("f-M-head's landmarks carry no head");
            await setField("form", "f-M");
            await until("f-M back", () => evaluate(`document.querySelector('#browser-avatar li[data-kind=avatar]')?.textContent === "f-M"`), 60000);
            if ((await evaluate(`document.body.dataset.avatarHead`)) !== "0") throw new Error("f-M's landmarks carry a head");
            failIfErrors();
            ok("Form select: f-M with head, then f-M");

            // 5. the T-shirt sample: four pieces, ten seams, no issues
            const sample = async () => {
                await evaluate(`document.getElementById("menu-sample").click()`);
                await until("the T-shirt's four pieces", async () => (await patternCount()) === 4 && (await seamCount()) === 10, 30000);
                const names = await evaluate(`[...document.querySelectorAll('#browser-patterns li[data-kind=pattern]')].map((li) => li.textContent).join(", ")`);
                if (names !== "Front, Back, Left sleeve, Right sleeve") throw new Error(`the sample's pieces: ${names}`);
                const issues = await evaluate(`document.getElementById("issues").textContent`);
                if (issues) throw new Error(`the sample has issues: ${issues}`);
                await noStatusError();
            };
            await sample();
            ok("sample: 4 patterns, 10 seams, no issues");
            await until("the sample drawn in 2D", async () => Number(await evaluate(`document.body.dataset.items2d ?? 0`)) >= 4 * 6, 30000);
            const [sx, sy, sw, sh] = await windowBox("rect2d");
            const world0 = await evaluate(`document.body.dataset.world ?? ""`);
            await mouse("mouseMoved", sx + sw / 2 + 7, sy + sh / 2, { buttons: 0 });
            await until("a hover answered", async () => { const w = await evaluate(`document.body.dataset.world ?? ""`); return w.includes(",") && w !== world0; }, 30000);
            ok("sample on the View: pieces, seams, labels; hover answered");
            if (process.env.ATELIER_SHOT_SAMPLE) {
                await frames(); // the View's first frames of the sample: a picture, not an assertion
                const { data } = await send("Page.captureScreenshot", { format: "png" });
                writeFileSync(process.env.ATELIER_SHOT_SAMPLE, Buffer.from(data, "base64"));
                ok(`screenshot ${process.env.ATELIER_SHOT_SAMPLE}`);
            }

            // the hover follows the pointer: a piece hovered in 2D, then nothing once the pointer is in 3D
            const hover2d = () => evaluate(`document.body.dataset.hover2d ?? ""`);
            let hovered = "";
            for (const [fx, fy] of [[0.32, 0.43], [0.68, 0.43], [0.3, 0.5], [0.7, 0.5], [0.5, 0.75]]) {
                hovered = (await hoverInfo([sx + sw * fx, sy + sh * fy])).hover2d;
                if (hovered) break;
            }
            if (!hovered) throw new Error("no piece hovered in the 2D window");
            const [hx, hy, hw, hh] = await windowBox("rect3d");
            await mouse("mouseMoved", hx + hw / 2, hy + hh / 2, { buttons: 0 });
            await until("the hover dropped in 3D", async () => (await hover2d()) === "", 10000);
            // a middle drag and a Space drag pan the 2D window: the pattern point under one pixel moves
            const px0 = [sx + sw * 0.5, sy + sh * 0.2];
            // the pattern point under p, from a hover answered after the move (a sentinel, then
            // until it changes; never a fixed wait: a late answer read the pre-pan point)
            const answered = async (p) => {
                await evaluate(`document.body.dataset.world = "__"`);
                await mouse("mouseMoved", p[0], p[1], { buttons: 0 });
                await until("a hover answered", async () => (await evaluate(`document.body.dataset.world ?? "__"`)) !== "__", 10000);
            };
            const worldAt = async (p) => {
                await answered([p[0] + 1, p[1]]);
                await answered(p);
                return (await evaluate(`document.body.dataset.world`)).split(",").map(Number);
            };
            const panBy = async (press, release) => {
                const before = await worldAt(px0);
                await press();
                for (let i = 1; i <= 6; i++) await mouse("mouseMoved", px0[0] + 10 * i, px0[1], { ...release.held });
                await release.done();
                const after = await worldAt(px0);
                return after[0] - before[0];
            };
            const midDx = await panBy(() => mouse("mousePressed", px0[0], px0[1], { button: "middle", buttons: 4 }),
                { held: { button: "middle", buttons: 4 }, done: () => mouse("mouseReleased", px0[0] + 60, px0[1], { button: "middle", buttons: 0 }) });
            if (!(midDx < -1)) throw new Error(`a middle drag right did not pan the 2D window (world x moved by ${midDx})`);
            const spaceDx = await panBy(async () => {
                await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
                await mouse("mousePressed", px0[0], px0[1]);
            }, { held: {}, done: async () => { await mouse("mouseReleased", px0[0] + 60, px0[1]); await send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 }); } });
            if (!(spaceDx < -1)) throw new Error(`a Space drag right did not pan the 2D window (world x moved by ${spaceDx})`);
            if ((await patternCount()) !== 4) throw new Error("a pan changed the garment");
            await key("f", "KeyF", 70);
            failIfErrors();
            ok(`hover dropped in 3D; middle and Space drags pan 2D (${midDx.toFixed(1)}, ${spaceDx.toFixed(1)} mm)`);

            await a2Block();

            // 6. DXF export: one BLOCK per piece; imported into a new document, four pieces
            await evaluate(`document.getElementById("menu-export-dxf").click()`);
            const dxf = await waitFile("garment.dxf");
            const blocks = dxf.split(/\r?\n/).map((l) => l.trim()).filter((l, i, all) => l === "BLOCK" && all[i - 1] === "0").length;
            if (blocks !== 4) throw new Error(`the DXF has ${blocks} BLOCKs, not 4`);
            await evaluate(`document.getElementById("menu-new").click()`);
            await until("an empty document again", async () => (await patternCount()) === 0, 30000);
            await pickInto("menu-import-dxf", join(downloads, "garment.dxf"), ".dxf");
            await until("the imported pieces", async () => (await patternCount()) === 4, 30000);
            await noStatusError();
            failIfErrors();
            ok("DXF export: 4 BLOCKs; imported back: 4 pieces");

            // a DXF with an internal line, a fold and a hole (A2 spec §6), written by the kernel's
            // AAMA writer from a garment built in Node: imported, the piece keeps all three
            {
                const k = await loadKernel();
                const params = Object.fromEntries(mm.FABRIC_FIELDS.map((n) => [n, 1]));
                const src = new Atelier(k);
                src.reset(mm.newDocumentOps({ slug: "x", label: "X", params }));
                const outer = mm.rectPath(0, 0, 300, 200), hole = mm.rectPath(180, 60, 60, 80);
                src.apply(mm.addPattern(src.nodes(), { label: "Panel", path: { ...outer, holes: [{ start: hole.start, segments: hole.segments }] }, fabric: "f_x", allowance: 10 }).ops, "panel");
                src.apply(mm.addInternal(src.nodes(), "p1", mm.openPath([[30, 30], [120, 30], [120, 160]]), "line"), "line");
                src.apply(mm.addInternal(src.nodes(), "p1", mm.openPath([[270, 20], [270, 180]]), "fold"), "fold");
                writeFileSync(join(downloads, "inner.dxf"), src.toDxf());
                src.free();
            }
            await evaluate(`document.getElementById("menu-new").click()`);
            await until("an empty document for the DXF", async () => (await patternCount()) === 0, 30000);
            await pickInto("menu-import-dxf", join(downloads, "inner.dxf"), ".dxf");
            await until("the imported panel", async () => (await patternCount()) === 1, 30000);
            await noStatusError();
            {
                const got = await saveNow();
                const p = got.nodes.find((n) => n.kind === "garment.pattern");
                const path = got.nodes.find((n) => n.id === p.outline).path;
                const kinds = (p.internal ?? []).map((l) => l.kind).sort().join(",");
                if ((path.holes ?? []).length !== 1) throw new Error(`the imported panel has ${(path.holes ?? []).length} holes, not 1`);
                if (kinds !== "fold,line") throw new Error(`the imported panel's internal lines: ${kinds}`);
            }
            if (process.env.ATELIER_SHOT_DXF) {
                await evaluate(`document.querySelector('#browser-patterns li[data-kind=pattern]').click()`);
                await evaluate(`document.querySelector('#tools2d [data-command=fit]').click()`);
                await sleep(1000); await frames();
                const { data } = await send("Page.captureScreenshot", { format: "png" });
                writeFileSync(process.env.ATELIER_SHOT_DXF, Buffer.from(data, "base64"));
                ok(`screenshot ${process.env.ATELIER_SHOT_DXF}`);
            }
            failIfErrors();
            ok("DXF import: a piece with an internal line, a fold and a hole keeps all three");

            // 7. the live drape on the sample
            await sample();
            await noStatusError();
            const simState = () => evaluate(`document.body.dataset.sim ?? "off"`);
            const health = () => evaluate(`document.getElementById("health").textContent`);
            const frameNo = async () => Number(/frame (\d+)/.exec(await health())?.[1] ?? -1);
            const statusText = () => evaluate(`document.getElementById("status-text").textContent`);
            await evaluate(`document.getElementById("sim-toggle").click()`);
            await until("the cloth running", async () => (await simState()) === "running", 60000);
            await until("three frames", async () => (await frameNo()) >= 3, 120000);
            const fpsText = await evaluate(`document.getElementById("fps").textContent`);
            if (!/^\d+(\.\d)? fps · \d+ ms\/step$/.test(fpsText)) throw new Error(`#fps shows ${fpsText}`);
            if (!/sewing|draping/.test(await health())) throw new Error(`the health line: ${await health()}`);
            if (await evaluate(`document.getElementById("health").classList.contains("warn")`)) throw new Error(`health warns: ${await health()}`);
            failIfErrors();
            ok(`simulating: ${await health()}; ${fpsText}`);

            // pin: the Pin tool, a click on the cloth at the 3D window's centre
            const [cx, cy, cw, ch] = await windowBox("rect3d");
            const at3 = (fx, fy) => [cx + cw * fx, cy + ch * fy];
            const tryOnCloth = async (what, act, done) => {
                for (const [fx, fy] of [[0.5, 0.45], [0.5, 0.55], [0.48, 0.4], [0.52, 0.6], [0.5, 0.35]]) {
                    await evaluate(`document.getElementById("status-text").textContent = ""`);
                    await act(at3(fx, fy));
                    const t = await until(`${what}: an answer`, async () => (await statusText()) || null, 30000);
                    if (done(t)) return t;
                }
                throw new Error(`${what}: never on the cloth (${await statusText()})`);
            };
            await evaluate(`document.querySelector('[data-tool3d=pin]').click()`);
            await tryOnCloth("pin", click, (t) => t === "pinned");
            await until("the pin counted", async () => (await evaluate(`document.body.dataset.sim`)) === "running", 10000);
            ok("pinned a point of the cloth");

            // the pin is saved on its piece (pattern space); Freeze a piece and back, live: no re-mesh, no
            // rebuild, the frames go on; a Simulation panel change applied live and saved in sim_options
            {
                const pinnedPieces = (await saveNow()).nodes.filter((n) => n.kind === "garment.pattern" && n.pins?.length);
                if (pinnedPieces.length !== 1 || pinnedPieces[0].pins.length !== 1) throw new Error(`the saved pins: ${JSON.stringify(pinnedPieces.map((n) => [n.id, n.pins]))}`);
                const gen0 = Number(await evaluate(`document.body.dataset.meshGen`));
                const live = async (what) => {
                    const f = await frameNo();
                    await until(`frames after ${what}`, async () => (await frameNo()) >= f + 2, 60000);
                    if ((await simState()) !== "running") throw new Error(`${what}: the cloth stopped (${await statusText()})`);
                    if (/Simulate rebuilds/.test(await health())) throw new Error(`${what}: the cloth went stale: ${await health()}`);
                    if (Number(await evaluate(`document.body.dataset.meshGen`)) !== gen0) throw new Error(`${what}: re-meshed`);
                    await noStatusError();
                };
                await evaluate(`document.querySelector('#browser-patterns li[data-kind=pattern]').click()`);
                await until("the Freeze field", () => evaluate(`!!${field("frozen")}`), 30000);
                await setField("frozen", "true");
                await until("frozen saved", async () => (await saveNow()).nodes.find((n) => n.kind === "garment.pattern").frozen === true, 30000);
                await live("Freeze");
                await setField("frozen", "false");
                await until("unfrozen saved", async () => (await saveNow()).nodes.find((n) => n.kind === "garment.pattern").frozen === undefined, 30000);
                await live("unfreeze");
                await evaluate(`document.getElementById("simpanel-details").open = true`);
                const option = (name) => `document.querySelector('#simpanel [data-option="${name}"]')`;
                if ((await evaluate(`${option("gravity.y")}.value`)) !== "-9.8") throw new Error(`the panel's gravity: ${await evaluate(`${option("gravity.y")}.value`)}`);
                await evaluate(`(() => { const e = ${option("damping")}; e.value = "0.02"; e.dispatchEvent(new Event("change", { bubbles: true })); })()`);
                await until("damping saved", async () => (await saveNow()).nodes.find((n) => n.id === "garment").sim_options?.damping === 0.02, 30000);
                await live("the damping");
                // a bad value refused, the field put back
                await evaluate(`(() => { const e = ${option("substeps")}; e.value = "2.5"; e.dispatchEvent(new Event("change", { bubbles: true })); })()`);
                if (!/whole number/.test((await statusError()) ?? "")) throw new Error("a fractional substeps was not refused");
                if ((await evaluate(`${option("substeps")}.value`)) !== "30") throw new Error("the refused substeps stayed in the field");
                await evaluate(`document.getElementById("sim-defaults").click()`);
                await until("the defaults back", async () => (await saveNow()).nodes.find((n) => n.id === "garment").sim_options === undefined, 30000);
                await live("the defaults");
                failIfErrors();
                ok("pin saved on its piece; Freeze and unfreeze live; panel damping live and saved, a bad value refused, defaults back");
            }

            // drag: the Drag tool, a press on the cloth moved 80 px right; the frames go on
            await evaluate(`document.querySelector('[data-tool3d=drag]').click()`);
            if (await evaluate(`document.querySelector('[data-tool3d=pin]').classList.contains("on")`)) throw new Error("Pin and Drag both on");
            const f0 = await frameNo();
            // the press answered first, as a hand holds it: its pick takes a while with the cloth stepping, and on the
            // GPU the press waits for a positions readback; then the moves and the release
            const drag3d = async (p) => {
                await mouse("mouseMoved", p[0], p[1], { buttons: 0 });
                await mouse("mousePressed", p[0], p[1]);
                await until("drag: the press answered", async () => (await statusText()) || null, 30000);
                for (let i = 1; i <= 6; i++) await mouse("mouseMoved", p[0] + (80 * i) / 6, p[1]);
                await mouse("mouseReleased", p[0] + 80, p[1]);
            };
            await tryOnCloth("drag", drag3d, (t) => t === "dragging the cloth");
            await until("frames after the drag", async () => (await frameNo()) >= f0 + 2, 60000);
            await evaluate(`document.querySelector('[data-tool3d=drag]').click()`);
            failIfErrors();
            ok("dragged the cloth");

            // GIA: on by default on the GPU; the button turns it off while the cloth runs (re-shown
            // without it), the label says so and the frames go on; on again after (re-shown with it).
            // On the CPU it is disabled.
            if (engine !== "CPU") {
                const giaGen = Number(await evaluate(`document.body.dataset.meshGen`));
                await evaluate(`document.getElementById("sim-gia").click()`);
                const labelOff = await evaluate(`document.getElementById("sim-engine").textContent`);
                if (labelOff !== "GPU · GIA off") throw new Error(`#sim-engine after GIA off: "${labelOff}"`);
                if (await evaluate(`document.getElementById("sim-gia").classList.contains("on")`)) throw new Error("the GIA button is still on");
                await until("the cloth re-shown without GIA", async () => Number(await evaluate(`document.body.dataset.meshGen`)) > giaGen, 60000);
                const fo = await frameNo();
                await until("frames with GIA off", async () => (await frameNo()) >= fo + 2, 60000);
                if ((await simState()) !== "running") throw new Error(`the cloth stopped with GIA off: ${await statusText()}`);
                failIfErrors();
                ok(`GIA off: "${labelOff}", running`);
                const giaGen2 = Number(await evaluate(`document.body.dataset.meshGen`));
                await evaluate(`document.getElementById("sim-gia").click()`);
                const label = await evaluate(`document.getElementById("sim-engine").textContent`);
                if (label !== "GPU · GIA on") throw new Error(`#sim-engine after GIA on: "${label}"`);
                if (!(await evaluate(`document.getElementById("sim-gia").classList.contains("on")`))) throw new Error("the GIA button is not on");
                await until("the cloth re-shown with GIA", async () => Number(await evaluate(`document.body.dataset.meshGen`)) > giaGen2, 60000);
                const fg = await frameNo();
                await until("frames with GIA on again", async () => (await frameNo()) >= fg + 3, 60000);
                if ((await simState()) !== "running") throw new Error(`the cloth stopped with GIA on: ${await statusText()}`);
                if (await evaluate(`document.getElementById("health").classList.contains("warn")`)) throw new Error(`health warns with GIA on: ${await health()}`);
                const giaFps = await evaluate(`document.getElementById("fps").textContent`);
                failIfErrors();
                ok(`GIA on again: "${label}", running (${await health()}; ${giaFps})`);
            }

            // a 2D move of the front while it runs: no change in 3D (a 2D layout move is not a
            // shape change); a grain edit on it: re-meshed, still running, not stale
            await evaluate(`document.querySelector('#tools2d [data-tool=transform]').click()`);
            await evaluate(`document.querySelector('#browser-patterns li[data-kind=pattern]').click()`);
            const [x2, y2, w2, h2] = await windowBox("rect2d");
            const gen = () => evaluate(`Number(document.body.dataset.meshGen)`);
            const g0 = await gen();
            const size = () => evaluate(`/size [^<]*/.exec(document.getElementById("props").textContent)?.[0]`);
            const s0 = await size();
            // the Move tool moves a piece pressed on (a press on empty space is a box select):
            // start where the hover answers the selected piece
            const firstId = await evaluate(`document.querySelector('#browser-patterns li[data-kind=pattern]').dataset.id`);
            let on = null;
            for (const [fx, fy] of [[0.3, 0.5], [0.32, 0.43], [0.68, 0.43], [0.7, 0.5], [0.5, 0.75], [0.4, 0.5], [0.6, 0.5], [0.5, 0.4]]) {
                const at = [x2 + w2 * fx, y2 + h2 * fy];
                const h = await hoverInfo(at);
                if (h.hit === "pattern" && h.hover2d === firstId) { on = at; break; }
            }
            if (!on) throw new Error(`no spot on ${firstId} found in the 2D window`);
            await drag(on, [on[0] + 30, on[1]], 6);
            const f1 = await frameNo();
            await until("frames after the move", async () => (await frameNo()) >= f1 + 2, 60000);
            if ((await gen()) !== g0) throw new Error("a 2D move re-meshed the cloth");
            if ((await size()) !== s0) throw new Error(`the move changed the piece: ${s0} -> ${await size()}`);
            await evaluate(`document.querySelector('#tools2d [data-tool=edit]').click()`);
            await setField("grain", "0.2, 1");
            await until("the cloth re-meshed", async () => (await gen()) > g0, 60000)
                .catch(async (e) => { throw new Error(`${e.message}: status "${await evaluate(`document.getElementById("status-text").textContent`)}", sim ${await evaluate(`document.body.dataset.sim`)}, health "${await evaluate(`document.getElementById("health").textContent`)}", gen ${await gen()} vs ${g0}`); });
            const f2 = await frameNo();
            await until("frames after the edit", async () => (await frameNo()) >= f2 + 2, 60000);
            if (/Reset/.test(await health())) throw new Error(`the cloth went stale: ${await health()}`);
            await noStatusError();
            failIfErrors();
            ok("2D move: the cloth kept; grain edit: re-meshed, running");

            // a seam removed: the cloth is stale until Simulate rebuilds it
            await evaluate(`document.querySelector('#browser-seams li[data-kind=seam]').click()`);
            await key("Delete", "Delete", 46);
            await until("stale", async () => /Simulate rebuilds/.test(await health()), 30000);
            await evaluate(`document.getElementById("sim-toggle").click()`);   // pause
            await until("paused", async () => (await simState()) === "paused", 30000);
            const g1 = await gen();
            await evaluate(`document.getElementById("sim-toggle").click()`);   // rebuild
            await until("rebuilt", async () => (await gen()) > g1 && !/Reset/.test(await health()), 60000);
            await until("running again", async () => (await simState()) === "running", 30000);
            failIfErrors();
            ok(`seam removed: stale, rebuilt (${await health()})`);

            // Reset: the cloth is gone, the flat pieces back
            await evaluate(`document.getElementById("sim-reset").click()`);
            await until("reset", async () => (await simState()) === "off", 30000);
            if (await health()) throw new Error(`the health line after Reset: ${await health()}`);
            await noStatusError();
            failIfErrors();
            ok("reset: the flat pieces back");

            // the sample afresh: run on (ATELIER_DRAPE_FRAMES) for the picture, then pause and reset
            await sample();
            await evaluate(`document.getElementById("sim-toggle").click()`);
            await until("the cloth running", async () => (await simState()) === "running", 60000);
            const target = Number(process.env.ATELIER_DRAPE_FRAMES ?? 4);
            await until(`frame ${target}`, async () => (await frameNo()) >= target || (await simState()) !== "running", Math.max(60000, target * 2000));
            if ((await simState()) !== "running") throw new Error(`the sample stopped: ${await statusText()}`);
            if (process.env.ATELIER_SHOT && !process.env.ATELIER_FPS) {
                await frames();
                const shot = await send("Page.captureScreenshot", { format: "png" });
                writeFileSync(process.env.ATELIER_SHOT, Buffer.from(shot.data, "base64"));
                ok(`screenshot ${process.env.ATELIER_SHOT}`);
            }
            ok(`the sample drapes: ${await health()}`);

            // the fit map: Strain on the draping cloth, its legend in %, the value under the pointer
            await evaluate(`(() => { const s = document.getElementById("map-select"); s.value = "strain"; s.dispatchEvent(new Event("change")); })()`);
            const legend = await evaluate(`(() => { const l = document.getElementById("map-legend"); return { hidden: l.hidden, title: l.querySelector(".map-title").textContent, unit: l.querySelector(".map-unit").textContent, lo: document.getElementById("map-lo").value, hi: document.getElementById("map-hi").value }; })()`);
            if (legend.hidden || legend.title !== "Strain" || legend.unit !== "%" || legend.lo !== "0" || legend.hi !== "10") throw new Error(`the legend: ${JSON.stringify(legend)}`);
            {
                const [mx, my, mw, mh] = await windowBox("rect3d");
                let read = null;
                for (const [fx, fy] of [[0.5, 0.45], [0.5, 0.55], [0.47, 0.4], [0.53, 0.5], [0.5, 0.35]]) {
                    await evaluate(`document.body.dataset.mapValue = "__"`);
                    await mouse("mouseMoved", mx + mw * fx, my + mh * fy, { buttons: 0 });
                    const v = await until("the map's hover answered", async () => { const d = await evaluate(`document.body.dataset.mapValue ?? "__"`); return d === "__" ? null : { d }; }, 30000);
                    if (v.d !== "") { read = await evaluate(`document.getElementById("map-value").textContent`); break; }
                }
                if (!read || !/^Strain( -?\d+(\.\d+)? %|: no value here)$/.test(read)) throw new Error(`the hover read-out: ${read}`);
                await sleep(500);
                await frames();
                if (process.env.ATELIER_SHOT_MAP) {
                    const shot = await send("Page.captureScreenshot", { format: "png" });
                    writeFileSync(process.env.ATELIER_SHOT_MAP, Buffer.from(shot.data, "base64"));
                    ok(`screenshot ${process.env.ATELIER_SHOT_MAP}`);
                }
                failIfErrors();
                ok(`the strain map: legend ${legend.lo}-${legend.hi} ${legend.unit}, under the pointer "${read}"`);
                await evaluate(`(() => { const s = document.getElementById("map-select"); s.value = "off"; s.dispatchEvent(new Event("change")); })()`);
                if (!(await evaluate(`document.getElementById("map-legend").hidden`))) throw new Error("the legend stays with the map off");
                if (process.env.ATELIER_SHOT_MAP_OFF) {
                    await sleep(500);
                    await frames();
                    const shot = await send("Page.captureScreenshot", { format: "png" });
                    writeFileSync(process.env.ATELIER_SHOT_MAP_OFF, Buffer.from(shot.data, "base64"));
                    ok(`screenshot ${process.env.ATELIER_SHOT_MAP_OFF}`);
                }

                // the Tape: a girth on the avatar's hips, below the shirt
                await evaluate(`document.getElementById("tape-toggle").click()`);
                await evaluate(`document.querySelector('[data-tape-mode=girth]').click()`);
                if ((await evaluate(`document.body.dataset.tape`)) !== "girth") throw new Error("the Tape is not on in Girth");
                let girth = null;
                for (const [fx, fy] of [[0.48, 0.53], [0.52, 0.53], [0.47, 0.55], [0.53, 0.55], [0.5, 0.51], [0.5, 0.165]]) {
                    await evaluate(`document.body.dataset.tapeTarget = ""; document.getElementById("status-text").textContent = ""`);
                    await click([mx + mw * fx, my + mh * fy]);
                    await until("the tape's answer", async () => (await evaluate(`document.body.dataset.tapeTarget || document.getElementById("status-text").textContent`)) || null, 30000);
                    // on the avatar's body: not the stand's pole
                    if ((await evaluate(`document.body.dataset.tapeTarget`)) === "avatar" && Number(await evaluate(`document.body.dataset.tapeLength`)) > 300) { girth = Number(await evaluate(`document.body.dataset.tapeLength`)); break; }
                    await sleep(450);           // the next click is not a double click
                }
                if (!(girth > 300 && girth < 2000)) throw new Error(`no girth on the avatar (${await statusText()})`);
                if (!/^girth: \d+\.\d cm$/.test(await statusText())) throw new Error(`the girth's status: ${await statusText()}`);
                await sleep(300);
                await frames();
                if (process.env.ATELIER_SHOT_TAPE) {
                    const shot = await send("Page.captureScreenshot", { format: "png" });
                    writeFileSync(process.env.ATELIER_SHOT_TAPE, Buffer.from(shot.data, "base64"));
                    ok(`screenshot ${process.env.ATELIER_SHOT_TAPE}`);
                }
                failIfErrors();
                ok(`a girth on the avatar: ${await statusText()}`);
                await evaluate(`document.getElementById("tape-clear").click()`);
                await evaluate(`document.getElementById("tape-toggle").click()`);
            }
            await evaluate(`document.getElementById("sim-toggle").click()`);
            await until("paused", async () => (await simState()) === "paused", 30000);
            if ((await evaluate(`document.getElementById("fps").textContent`)) !== "paused") throw new Error("#fps does not say paused");
            const fp = await frameNo();
            await sleep(1500);
            if ((await frameNo()) !== fp) throw new Error("frames went on after Pause");
            ok(`paused at frame ${fp}`);
            await evaluate(`document.getElementById("sim-reset").click()`);
            await until("reset", async () => (await simState()) === "off", 30000);
            failIfErrors();

            // ATELIER_FPS: the app's real rate on the sample afresh, from the health line's frame
            // number against wall time: frames 0..60 (sewing) and 60..180 (draping)
            if (process.env.ATELIER_FPS) {
                await sample();
                await evaluate(`document.getElementById("sim-toggle").click()`);
                await until("the cloth running", async () => (await simState()) === "running", 60000);
                const marks = new Map();                       // frame mark -> [frame seen, wall ms]
                const t0 = performance.now();
                let f = 0;
                while (!marks.has(180)) {
                    f = await frameNo();
                    const now = performance.now();
                    for (const m of [0, 60, 180]) if (f >= m && !marks.has(m)) marks.set(m, [f, now]);
                    if ((await simState()) !== "running") throw new Error(`the drape stopped at frame ${f}: ${await statusText()}`);
                    if (now - t0 > 600000) throw new Error(`frame 180 not reached in 10 min (frame ${f})`);
                    await sleep(20);
                }
                const rate = (a, b) => { const [fa, ta] = marks.get(a), [fb, tb] = marks.get(b); return (fb - fa) / ((tb - ta) / 1000); };
                const fps = rate(60, 180), sew = rate(0, 60);
                const vertices = /(\d+) vertices/.exec(await health())?.[1];
                if (process.env.ATELIER_SHOT) {
                    const shot = await send("Page.captureScreenshot", { format: "png" });
                    writeFileSync(process.env.ATELIER_SHOT, Buffer.from(shot.data, "base64"));
                    ok(`screenshot ${process.env.ATELIER_SHOT}`);
                }
                const meter = await evaluate(`document.getElementById("fps").textContent`);
                console.log(`fps: ${fps.toFixed(1)} (${(1000 / fps).toFixed(1)} ms/frame), sew ${sew.toFixed(1)}, engine ${engine}, vertices ${vertices}`);
                console.log(`fps meter: ${meter}; ${await health()}`);
                await evaluate(`document.getElementById("sim-toggle").click()`);
                await until("paused", async () => (await simState()) === "paused", 30000);
                await evaluate(`document.getElementById("sim-reset").click()`);
                await until("reset", async () => (await simState()) === "off", 30000);
                failIfErrors();
                ok("fps measured, paused, reset");
            }
            // ?film=1: Simulate builds paused, step(3) steps exactly three frames, garment() reads the document
            await send("Page.navigate", { url: clothWanted === "cpu" ? `${base}/?film=1&cloth=cpu` : `${base}/?film=1` });
            await until("the worker's ready (film)", () => evaluate(`document.body?.dataset.ready === "1"`), 90000);
            await until("the avatar (film)", async () => (await count("avatar", "avatar")) === 1, 60000);
            await sample();
            const stopsBefore = await evaluate(`window.atelierFilm.stops`);
            await evaluate(`document.getElementById("sim-toggle").click()`);
            await until("the film cloth built", () => evaluate(`(document.getElementById("health").textContent || "").includes("frame 0") && window.atelierFilm.stops > ${stopsBefore}`), 60000);   // the build's own stop counted
            const stops0 = await evaluate(`window.atelierFilm.stops`);
            const reached = await evaluate(`window.atelierFilm.step(3)`);        // resolves once stepped and drawn
            if (reached !== 3 || (await frameNo()) !== 3) throw new Error(`the film step ended at frame ${reached} / ${await frameNo()}, not 3`);
            if (!((await evaluate(`window.atelierFilm.stops`)) > stops0)) throw new Error("the step resolved without a stop");
            // Simulate on the built film cloth does nothing (no free run); steps queue one after another
            await evaluate(`document.getElementById("sim-toggle").click()`);
            const queued = await evaluate(`Promise.all([window.atelierFilm.step(1), window.atelierFilm.step(2)])`);
            if (queued.join() !== "4,6" || (await frameNo()) !== 6) throw new Error(`queued steps reached ${queued} / frame ${await frameNo()}, not 4,6`);
            const view = await evaluate(`window.atelierFilm.viewStats()`);
            if (!(view.framesDrawn > 0)) throw new Error("viewStats() reports no frames drawn");
            const doc = await evaluate(`window.atelierFilm.garment()`);
            if (!doc.includes("garment.pattern")) throw new Error("garment() returned no document");
            if ((await evaluate(`window.atelierFilm.log.length`)) < 3) throw new Error("the film log is short");
            failIfErrors();
            ok("film hook: paused build, step(3) stops at frame 3, Simulate inert, queued steps, garment(), log, viewStats");
            await send("Page.navigate", { url: clothWanted === "cpu" ? `${base}/?cloth=cpu` : `${base}/` });
            await until("the worker's ready again", () => evaluate(`document.body?.dataset.ready === "1"`), 90000);
            await until("the avatar again", async () => (await count("avatar", "avatar")) === 1, 60000);
            // ---- the 2D tools, on a new garment ----
            await evaluate(`document.getElementById("menu-new").click()`);
            await until("an empty garment", async () => (await patternCount()) === 0, 30000);
            // helpers every later 2D step shares: the size dialog, a shape by dialog, a typed length
            const fillSize = async (w, h) => {
                await until("the size dialog", () => evaluate(`document.getElementById("size-dialog").open`), 30000);
                await evaluate(`(() => { document.getElementById("size-w").value = "${w}"; document.getElementById("size-h").value = "${h}"; document.getElementById("size-ok").click(); })()`);
            };
            const byDialog = async (tool, at, w, h) => {
                await evaluate(`document.querySelector('#tools2d [data-tool=${tool}]').click()`);
                await click(at);
                await fillSize(w, h);
            };
            const typeLen = async (len, angle) => {          // digits open the typed box; Tab goes to the angle; Enter places
                await key(len[0], `Digit${len[0]}`, 48 + Number(len[0]));
                await until("the typed box", () => evaluate(`!document.getElementById("typed").hidden`), 10000);
                if (len.length > 1) await send("Input.insertText", { text: len.slice(1) });
                if (angle !== undefined) { await key("Tab", "Tab", 9); await send("Input.insertText", { text: String(angle) }); }
                await key("Enter", "Enter", 13);
                await until("the typed box closed", () => evaluate(`document.getElementById("typed").hidden`), 10000);
            };
            const [rx0, ry0, rw0, rh0] = await windowBox("rect2d");
            const ra = [rx0 + rw0 * 0.2, ry0 + rh0 * 0.3], rb = [rx0 + rw0 * 0.45, ry0 + rh0 * 0.7];
            await evaluate(`document.querySelector('#tools2d [data-tool=rectangle]').click()`);
            await drag(ra, rb);
            await until("the rectangle", async () => (await patternCount()) === 1, 30000);
            // the unsnapped point under `ra` is the rectangle's first corner (Edit is armed again)
            let seen = await evaluate(`document.body.dataset.world ?? ""`);
            await mouse("mouseMoved", ra[0], ra[1], { buttons: 0 });
            await until("the corner's point", async () => { const w = await evaluate(`document.body.dataset.world ?? ""`); return w !== "" && w !== seen; }, 30000);
            const corner = await evaluate(`document.body.dataset.world`);
            // 2b. snapping: Polygon armed, the pointer 3 px off the corner lands on it
            await evaluate(`document.querySelector('#tools2d [data-tool=polygon]').click()`);
            await mouse("mouseMoved", ra[0] + 3, ra[1] - 2, { buttons: 0 });
            await until("a snap to the corner", async () => ["end", "vertex"].includes(await evaluate(`document.body.dataset.snap`)), 30000);
            const snappedTo = await evaluate(`document.body.dataset.world`);
            const apart = (p, q) => { const [a, b] = [p, q].map((s) => s.split(",").map(Number)); return Math.hypot(a[0] - b[0], a[1] - b[1]); };
            if (!(apart(snappedTo, corner) < 0.01)) throw new Error(`snapped to ${snappedTo}, not the corner ${corner}`);   // the View answers f32: compare numbers, not strings
            // Shift locks the angle to 45 degree steps from the last point (inside the rectangle, clear of its edges)
            const lockAt = [ra[0] + 40, ra[1] + 100];   // not `base`: that is check()'s url
            await click(lockAt);
            await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 8 });
            await mouse("mouseMoved", lockAt[0] + 60, lockAt[1] - 35, { buttons: 0, modifiers: 8 });   // about 30 degrees up
            await until("the angle lock", async () => (await evaluate(`document.body.dataset.snapAngle`)) === "45", 30000);
            await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 0 });
            // Shift released: the lock's base is gone, a hover answers no locked angle
            await mouse("mouseMoved", lockAt[0] + 61, lockAt[1] - 33, { buttons: 0 });
            await until("the angle lock released", async () => (await evaluate(`document.body.dataset.snapAngle`)) === "", 30000);
            await key("Escape", "Escape", 27);
            failIfErrors();
            ok("snap: the corner answers end/vertex at the corner; Shift locks 45 degrees, released unlocks");

            // the Grid button adds the grid snap and takes it away: a hover over a grid crossing,
            // clear of the rectangle, answers "grid" only while Grid is on
            await evaluate(`document.querySelector('#tools2d [data-tool=polygon]').click()`);
            const hoverAt = hoverInfo;
            const gp0 = [rx0 + rw0 * 0.75, ry0 + rh0 * 0.15];
            const gw0 = await hoverAt(gp0), gwx = await hoverAt([gp0[0] + 40, gp0[1]]), gwy = await hoverAt([gp0[0], gp0[1] + 40]);
            if (gw0.snap || gwx.snap || gwy.snap) throw new Error(`a snap away from geometry with Grid off: ${gw0.snap}/${gwx.snap}/${gwy.snap}`);
            const kx = (gwx.world[0] - gw0.world[0]) / 40, ky = (gwy.world[1] - gw0.world[1]) / 40;      // world mm a CSS px, each axis
            // a 10 mm crossing that is not a 100 mm one: the snap's step (the work plane's 10 mm, the README's
            // "10 mm grid"), not the drawn grid's 100 mm squares, which every 100 mm crossing would also pass
            const tenNotHundred = (v) => { const c = Math.round(v / 10) * 10; return Math.abs(c % 100) < 1e-9 ? c + 10 : c; };
            const cross = [tenNotHundred(gw0.world[0]), tenNotHundred(gw0.world[1])];
            const onGrid = [gp0[0] + (cross[0] - gw0.world[0]) / kx, gp0[1] + (cross[1] - gw0.world[1]) / ky];
            const gridOff = await hoverAt(onGrid);
            if (gridOff.snap === "grid") throw new Error("a grid snap with Grid off");
            await evaluate(`document.querySelector('#tools2d [data-toggle=grid]').click()`);
            await hoverAt([onGrid[0] + 1, onGrid[1]]);
            await until("a grid snap with Grid on", async () => (await hoverAt(onGrid)).snap === "grid", 30000);
            await evaluate(`document.querySelector('#tools2d [data-toggle=grid]').click()`);
            await hoverAt([onGrid[0] + 1, onGrid[1]]);
            await until("no grid snap with Grid off again", async () => (await hoverAt(onGrid)).snap !== "grid", 30000);
            await key("Escape", "Escape", 27);
            failIfErrors();
            ok("snap: the Grid button adds and removes the grid snap");

            // box select: a second rectangle beside the first, then the Move tool's window over
            // the whole 2D window selects both
            await evaluate(`document.querySelector('#tools2d [data-tool=rectangle]').click()`);
            await drag([rx0 + rw0 * 0.55, ry0 + rh0 * 0.3], [rx0 + rw0 * 0.8, ry0 + rh0 * 0.7]);
            await until("two rectangles", async () => (await patternCount()) === 2, 30000);
            await evaluate(`document.querySelector('#tools2d [data-tool=transform]').click()`);
            const onIds = () => evaluate(`[...document.querySelectorAll("#browser-patterns li.on")].map((li) => li.dataset.id).join(",")`);
            const secondId = await evaluate(`document.querySelectorAll('#browser-patterns li[data-kind=pattern]')[1].dataset.id`);
            // window vs crossing (plan ruling 18): the same box over part of the second piece, from
            // the gap between the pieces, selects nothing left to right (a window: not wholly
            // inside) and the piece right to left (a crossing box: touched)
            await until("the second piece selected", async () => (await onIds()) === secondId, 30000);
            await drag([rx0 + rw0 * 0.5, ry0 + rh0 * 0.4], [rx0 + rw0 * 0.7, ry0 + rh0 * 0.6]);
            await until("a window touching a piece selects nothing", async () => (await onIds()) === "", 30000);
            await drag([rx0 + rw0 * 0.9, ry0 + rh0 * 0.6], [rx0 + rw0 * 0.7, ry0 + rh0 * 0.4]);
            await until("a crossing box selects the piece it touches", async () => (await onIds()) === secondId, 30000);
            await evaluate(`document.querySelector('#tools2d [data-command=fit]').click()`);
            const [bx, bY, bw, bh] = await windowBox("rect2d");
            const boxAll = async () => {
                await drag([bx + 4, bY + 24], [bx + bw - 4, bY + bh - 4]);
                await until("a box selection", async () => (await evaluate(`document.querySelectorAll("#browser-patterns li.on").length`)) === 2, 30000);
            };
            await boxAll();
            failIfErrors();
            ok("box select: a window and a crossing box; the Move tool's window selects both pieces");

            // Delete takes every selected piece in one undo step
            await key("Delete", "Delete", 46);
            await until("both pieces removed", async () => (await patternCount()) === 0, 30000);
            await key("z", "KeyZ", 90, 2);
            await until("both pieces back after one Ctrl+Z", async () => (await patternCount()) === 2, 30000);
            // an undo that takes a selected piece away leaves the others selected, and they still move
            await boxAll();
            await key("z", "KeyZ", 90, 2);                  // the second rectangle's creation
            await until("the second piece undone", async () => (await patternCount()) === 1, 30000);
            const firstId2 = await evaluate(`document.querySelector('#browser-patterns li[data-kind=pattern]').dataset.id`);
            await until("the survivor still selected", async () => (await onIds()) === firstId2, 30000);
            const onlyOutline = (json) => json.nodes.find((n) => n.kind === "profile.path" && n.id === `${firstId2}_outline`).path;
            const saveJson = async () => { await key("s", "KeyS", 83, 2); return JSON.parse(await takeFile("garment.json")); };
            const before1 = onlyOutline(await saveJson());
            let onPiece = null;
            for (const [fx, fy] of [[0.5, 0.5], [0.3, 0.5], [0.4, 0.5], [0.2, 0.5], [0.6, 0.5], [0.35, 0.4], [0.35, 0.6]]) {
                const at = [bx + bw * fx, bY + bh * fy];
                if ((await hoverInfo(at)).hit === "pattern") { onPiece = at; break; }
            }
            if (!onPiece) throw new Error("no spot on the surviving piece found");
            await drag(onPiece, [onPiece[0] + 40, onPiece[1]], 6);
            const after1 = onlyOutline(await saveJson());      // the save waits for the drag's last step
            if (!(after1.start[0] - before1.start[0] > 1)) throw new Error(`the survivor did not move: ${before1.start} -> ${after1.start}`);
            await noStatusError();
            failIfErrors();
            ok("box select: Delete removes both in one undo; an undone member leaves the selection, the rest still moves");

            // an ellipse by dialog: E, a click, 120 x 60
            const patternsBefore = await patternCount();
            await key("e", "KeyE", 69);
            const [ex, ey, ew, eh] = await windowBox("rect2d");
            await click([ex + ew * 0.85, ey + eh * 0.15]);
            await fillSize(120, 60);
            await until("the ellipse added", async () => (await patternCount()) === patternsBefore + 1, 30000);
            await evaluate(`[...document.querySelectorAll('#browser-patterns li[data-kind=pattern]')].at(-1).click()`);
            await until("its size", () => evaluate(`/size\\s*120\\s*×\\s*60/.test(document.getElementById("props").textContent)`), 30000);
            await noStatusError();
            failIfErrors();
            ok("ellipse by dialog: 120 x 60");

            // a rectangle by dialog, confirmed with Enter in a field (OK is the form's only submit button)
            const rectsBefore = await patternCount();
            await evaluate(`document.querySelector('#tools2d [data-tool=rectangle]').click()`);
            await click([ex + ew * 0.85, ey + eh * 0.8]);
            await until("the size dialog", () => evaluate(`document.getElementById("size-dialog").open`), 30000);
            await evaluate(`(() => { document.getElementById("size-w").value = "80"; const h = document.getElementById("size-h"); h.value = "40"; h.focus(); })()`);
            await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
            await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
            await until("the rectangle added", async () => (await patternCount()) === rectsBefore + 1, 30000);
            await evaluate(`[...document.querySelectorAll('#browser-patterns li[data-kind=pattern]')].at(-1).click()`);
            await until("its size", () => evaluate(`/size\\s*80\\s*×\\s*40/.test(document.getElementById("props").textContent)`), 30000);
            // Cancel places nothing
            await evaluate(`document.querySelector('#tools2d [data-tool=ellipse]').click()`);
            await click([ex + ew * 0.15, ey + eh * 0.8]);
            await until("the size dialog", () => evaluate(`document.getElementById("size-dialog").open`), 30000);
            await evaluate(`document.getElementById("size-cancel").click()`);
            await until("the dialog closed", () => evaluate(`!document.getElementById("size-dialog").open`), 30000);
            const afterCancel = await saveJson();            // the round trip: everything before it handled
            if (afterCancel.nodes.filter((n) => n.kind === "garment.pattern").length !== rectsBefore + 1 || (await patternCount()) !== rectsBefore + 1) throw new Error("Cancel placed a piece");
            await key("Escape", "Escape", 27);
            await noStatusError();
            failIfErrors();
            ok("rectangle by dialog: Enter confirms 80 x 40; Cancel places nothing");

            // ---- holes (Task 14): a piece by dialog, a rectangle and an ellipse hole by dialog on it ----
            await evaluate(`document.getElementById("menu-new").click()`);
            await until("an empty garment", async () => (await patternCount()) === 0, 30000);
            // a 200 x 100 piece by dialog at hc, then a 20 x 20 hole by dialog inside it
            const [qx, qy, qw, qh] = await windowBox("rect2d");     // hx.. and c are taken above
            const hc = [qx + qw * 0.15, qy + qh * 0.85];
            // pattern mm per CSS px from two hovers 50 px apart (the 2D window's own mapping). Each waits for the
            // answer to THAT hover: dataset.worldAt names the canvas point (device px) dataset.world answers. A
            // world that merely differs from the last one read may be an earlier click's, still in flight.
            let lastSeen = await evaluate(`document.body.dataset.world ?? ""`);
            const answeredAt = async (p) => {
                const [at, world, left, top, dpr] = await evaluate(`(() => { const r = document.getElementById("view").getBoundingClientRect();
                    return [document.body.dataset.worldAt ?? "", document.body.dataset.world ?? "", r.left, r.top, devicePixelRatio]; })()`);
                const xy = at.split(",").map(Number);
                return at !== "" && Math.abs(xy[0] / dpr + left - p[0]) <= 0.51 && Math.abs(xy[1] / dpr + top - p[1]) <= 0.51 ? world : null;
            };
            const worldOf = async (p) => {
                await mouse("mouseMoved", p[0], p[1], { buttons: 0 });
                try { lastSeen = await until(`the hover answer at ${p}`, () => answeredAt(p), 10000); }
                catch (e) { throw new Error(`${e.message} (last answered at ${await evaluate(`document.body.dataset.worldAt`)}: ${await evaluate(`document.body.dataset.world`)})`); }
                return lastSeen.split(",").map(Number);
            };
            const wc1 = await worldOf([hc[0] + 1, hc[1]]), wc2 = await worldOf([hc[0] + 51, hc[1]]);
            const pxPerMm = 50 / (wc2[0] - wc1[0]);
            // the whole 200 x 100 piece must fit the window at this zoom (sizes are mm, offsets below go through pxPerMm)
            if (!(hc[0] + 200 * pxPerMm < qx + qw && hc[1] - 100 * pxPerMm > qy)) throw new Error("the 200 x 100 piece does not fit the 2D window");
            const n0 = await patternCount();
            await byDialog("rectangle", hc, 200, 100);
            await until("the piece", async () => (await patternCount()) === n0 + 1, 30000);
            await evaluate(`[...document.querySelectorAll('#browser-patterns li[data-kind=pattern]')].at(-1).click()`);
            // 40 x 30 mm in, clear of the corner: 10 mm in, a click snaps to the corner (a hole touching the outline is refused)
            await byDialog("hole-rectangle", [hc[0] + 40 * pxPerMm, hc[1] - 30 * pxPerMm], 20, 20);
            await until("one hole", () => evaluate(`/1 hole/.test(document.getElementById("props").textContent)`), 30000);
            await noStatusError();
            // 20 mm across, under twice the 10 mm allowance: no cut line, and a word on the status line (not an error)
            await until("the small-hole warning", () => evaluate(`/hole 1 is too small for a 10 mm allowance: it has no cut line/.test(document.getElementById("status-text").textContent)`), 30000);
            {   // where it went, from the saved document: 40 x 30 mm in from the piece's first corner (a CSS px is about half a mm)
                const outline = (await saveJson()).nodes.find((n) => n.kind === "profile.path").path;
                const off = [0, 1].map((i) => outline.holes?.[0]?.start[i] - outline.start[i]);
                if (!(Math.abs(off[0] - 40) < 1 && Math.abs(off[1] - 30) < 1)) throw new Error(`the hole is at ${off} mm from the corner, not 40, 30`);
            }
            ok("hole by dialog on a piece");

            // an ellipse hole by dialog: centred 150 x 50 mm into the piece, 60 x 40
            await byDialog("hole-ellipse", [hc[0] + 150 * pxPerMm, hc[1] - 50 * pxPerMm], 60, 40);
            await until("two holes", () => evaluate(`/2 holes/.test(document.getElementById("props").textContent)`), 30000);
            await noStatusError();
            failIfErrors();
            ok("ellipse hole by dialog: 2 holes");

            // a hole over the piece's edge: the kernel refuses it, the status says so, nothing changes
            await byDialog("hole-rectangle", [hc[0] + 190 * pxPerMm, hc[1] - 50 * pxPerMm], 20, 20);
            await until("the refusal on the status line", async () => /boundary|cross/.test((await statusError()) ?? ""), 30000);
            await evaluate(`[...document.querySelectorAll('#browser-patterns li[data-kind=pattern]')].at(-1).click()`);
            await until("still two holes", () => evaluate(`/2 holes/.test(document.getElementById("props").textContent)`), 30000);
            failIfErrors();
            ok("a hole over the edge refused with a status; still 2 holes");

            // ---- internal shapes and Convert to Hole (Task 15) ----
            {   // a 24 x 24 internal square by dialog, its lower-left corner 100 x 10 mm into the piece (clear of the
                // 20 x 20 hole at 40..60 x 30..50 and the ellipse hole at 120..180 x 30..70), then To hole on its right
                // edge (its left one lies on the grain line). The tool snaps, alignment too, so the click goes on a snap
                // point: 100 x 10 is the grain line's lower end
                // re-measured with Edit armed: a snapping tool would snap the hover by the piece's corner onto it
                await evaluate(`document.querySelector('#tools2d [data-tool=edit]').click()`);
                const w1 = await worldOf([hc[0] + 1, hc[1]]), w2 = await worldOf([hc[0] + 51, hc[1]]);
                const mm = 50 / (w2[0] - w1[0]);        // a step above may have moved the camera
                const inner = [hc[0] + 100 * mm, hc[1] - 10 * mm];
                await saveJson();                       // the save's word replaces the refusal on the status line
                await noStatusError();
                const items0 = Number(await evaluate(`document.body.dataset.items2d ?? 0`));
                await byDialog("internal-rectangle", inner, 24, 24);
                await until("the internal shape drawn", async () => Number(await evaluate(`document.body.dataset.items2d ?? 0`)) > items0, 30000);   // the scene grew by its item
                await noStatusError();
                await evaluate(`document.querySelector('#tools2d [data-tool=to-hole]').click()`);
                // one hover on the right edge, 124 mm in: the pick answers the internal shape over the piece's face
                const edge = [inner[0] + 24 * mm, inner[1] - 12 * mm];
                await worldOf(edge);                    // waits for the answer at the edge point itself
                {
                    const hit = await evaluate(`document.body.dataset.hit + " at " + document.body.dataset.world`);
                    if (!hit.startsWith("internal ")) throw new Error(`the internal edge's hover answered ${hit} (edge ${edge}, corner ${hc}, ${mm} px/mm from ${w1} and ${w2})`);
                }
                await click(edge);
                await until("three holes", () => evaluate(`/3 holes/.test(document.getElementById("props").textContent)`), 30000);
                await noStatusError();
                const doc = await saveJson();
                const outline = doc.nodes.find((n) => n.kind === "profile.path").path;
                const piece = doc.nodes.find((n) => n.kind === "garment.pattern");
                const off = [0, 1].map((i) => outline.holes?.[2]?.start[i] - outline.start[i]);
                if (!(Math.abs(off[0] - 100) < 1 && Math.abs(off[1] - 10) < 1)) throw new Error(`the converted hole is at ${off} mm from the corner, not 100, 10`);
                if ((piece.internal ?? []).length) throw new Error(`the square is still an internal line: ${JSON.stringify(piece.internal)}`);
                failIfErrors();
                ok("internal square by dialog, converted to a hole: 3 holes");
            }

            // ---- Trace (Task 18): an internal 30 x 30 square copied out as a piece beside the original ----
            {   // its lower-left corner 65 x 55 mm into the piece: clear of the holes (40..60 x 30..50, 100..124 x
                // 10..34, the ellipse 120..180 x 30..70) and the grain line (x 100). The hover goes where the kernel
                // put it (the saved document), not where the click aimed: the placing tool snaps
                await evaluate(`document.querySelector('#tools2d [data-tool=edit]').click()`);
                const w1 = await worldOf([hc[0] + 1, hc[1]]), w2 = await worldOf([hc[0] + 51, hc[1]]);
                const mm = 50 / (w2[0] - w1[0]);
                const screenOf = (p) => [hc[0] + 1 + (p[0] - w1[0]) * mm, hc[1] - (p[1] - w1[1]) * mm];
                const items0 = Number(await evaluate(`document.body.dataset.items2d ?? 0`));
                await byDialog("internal-rectangle", [hc[0] + 65 * mm, hc[1] - 55 * mm], 30, 30);
                await until("the internal square drawn", async () => Number(await evaluate(`document.body.dataset.items2d ?? 0`)) > items0, 30000);
                await noStatusError();
                const before = await saveJson();
                const src = before.nodes.find((n) => n.kind === "garment.pattern" && (n.internal ?? []).length);
                if (!src) throw new Error("no piece holds the internal square");
                const sq = src.internal.at(-1).path;
                const xs = [sq.start, ...sq.segments.map((s) => s.to)].map((p) => p[0]), ys = [sq.start, ...sq.segments.map((s) => s.to)].map((p) => p[1]);
                const [x0, y0, y1] = [Math.min(...xs), Math.min(...ys), Math.max(...ys)];
                await evaluate(`document.querySelector('#tools2d [data-tool=trace]').click()`);
                const edge = screenOf([x0, (y0 + y1) / 2]);       // the left edge's middle
                await worldOf(edge);
                {
                    const hit = await evaluate(`document.body.dataset.hit + " at " + document.body.dataset.world`);
                    if (!hit.startsWith("internal ")) throw new Error(`the internal edge's hover answered ${hit} (edge ${edge}, square ${x0}, ${y0}..${y1})`);
                }
                const nTr = await patternCount();
                await click(edge);
                await until("the traced piece", async () => (await patternCount()) === nTr + 1, 30000);
                await noStatusError();
                const after = await saveJson();
                const traced = after.nodes.find((n) => n.kind === "garment.pattern" && n.label === `${src.label} trace`);
                if (!traced) throw new Error(`no "${src.label} trace" piece: ${after.nodes.filter((n) => n.kind === "garment.pattern").map((n) => n.label)}`);
                if (traced.fabric !== src.fabric) throw new Error(`the trace is in ${traced.fabric}, not ${src.fabric}`);
                // beside the original: moved by the piece's width (200 mm) + 20 along x
                const tp = after.nodes.find((n) => n.id === traced.outline).path;
                const off = [0, 1].map((i) => tp.start[i] - sq.start[i]);
                if (!(Math.abs(off[0] - 220) < 1e-6 && Math.abs(off[1]) < 1e-6)) throw new Error(`the trace is ${off} mm from the square, not 220, 0`);
                const kept = after.nodes.find((n) => n.id === src.id);
                if ((kept.internal ?? []).length !== src.internal.length) throw new Error("the original lost its internal square");
                failIfErrors();
                ok("trace: an internal square became a piece beside the original");
            }

            // ---- Fillet (Task 19): the Task 14 piece's lower-right corner rounded to a typed 10 mm ----
            {   // the corner and the fill from the saved document, through a mapping re-measured with Edit armed
                await evaluate(`document.querySelector('#tools2d [data-tool=edit]').click()`);
                const w1 = await worldOf([hc[0] + 1, hc[1]]), w2 = await worldOf([hc[0] + 51, hc[1]]);
                const mm = 50 / (w2[0] - w1[0]);
                const screenOf = (p) => [hc[0] + 1 + (p[0] - w1[0]) * mm, hc[1] - (p[1] - w1[1]) * mm];
                const before = await saveJson();
                const src = before.nodes.find((n) => n.kind === "garment.pattern" && !/trace/.test(n.label));
                const path0 = before.nodes.find((n) => n.id === src.outline).path;
                if (path0.segments.length !== 4) throw new Error(`the piece has ${path0.segments.length} sides, not 4`);
                const pts = [path0.start, ...path0.segments.slice(0, -1).map((g) => g.to)];
                const x0 = Math.min(...pts.map((p) => p[0])), y0 = Math.min(...pts.map((p) => p[1]));
                const lr = pts.reduce((b, p) => (p[0] - p[1] > b[0] - b[1] ? p : b));
                // the fill 150 x 85 mm in: clear of the holes (to y 70), the internal square (to x 95) and the grain (x 100)
                await click(screenOf([x0 + 150, y0 + 85]));
                await until("the piece selected", () => evaluate(`!!document.querySelector('#browser li[data-kind=pattern][data-id="${src.id}"]')?.classList.contains("on")`), 30000);
                await evaluate(`document.querySelector('#tools2d [data-tool=fillet]').click()`);
                const cornerAt = screenOf(lr);
                await worldOf(cornerAt);                // waits for the answer at the corner itself
                {
                    const hit = await evaluate(`document.body.dataset.hit`);
                    if (hit !== "point") throw new Error(`the corner's hover answered ${hit}, not a point`);
                }
                await click(cornerAt);
                await typeLen("10");
                const after = await until("five sides", async () => {
                    const d = await saveJson();
                    return d.nodes.find((n) => n.id === src.outline).path.segments.length === 5 ? d : null;
                }, 30000);
                await noStatusError();
                const path1 = after.nodes.find((n) => n.id === src.outline).path;
                const arc = path1.segments.find((g) => g.type === "arc");
                const r = Math.hypot(arc.to[0] - arc.centre[0], arc.to[1] - arc.centre[1]);
                if (!(Math.abs(r - 10) < 1e-6)) throw new Error(`the arc's radius is ${r}, not 10`);
                if ((path1.holes ?? []).length !== (path0.holes ?? []).length) throw new Error("the fillet lost the piece's holes");
                failIfErrors();
                ok("fillet: a typed 10 mm radius on a corner");
            }

            // ---- typed lengths (Task 16): a 100 x 50 polygon typed point by point, on a new garment ----
            {
                await evaluate(`document.getElementById("menu-new").click()`);
                await until("an empty garment", async () => (await patternCount()) === 0, 30000);
                const [tx, ty, tw, th] = await windowBox("rect2d");
                const P = [tx + tw * 0.5, ty + th * 0.9];
                const fresh = async (p) => { lastSeen = await evaluate(`document.body.dataset.world ?? ""`); return worldOf(p); };   // other hovers moved it since
                // re-measured with Edit armed (the steps above pressed Fit): the 100 x 50 piece must fit up and right of P
                await evaluate(`document.querySelector('#tools2d [data-tool=edit]').click()`);
                const w1 = await fresh([P[0] + 1, P[1]]), w2 = await worldOf([P[0] + 51, P[1]]);
                const mm = 50 / (w2[0] - w1[0]);
                if (!(P[0] + 100 * mm < tx + tw && P[1] - 50 * mm > ty)) throw new Error("the 100 x 50 polygon does not fit the 2D window");
                // a digit with no last point is no typed length
                await key("5", "Digit5", 53);
                if (!(await evaluate(`document.getElementById("typed").hidden`))) throw new Error("a digit opened the typed box with no last point");
                const boxOpen = () => evaluate(`!document.getElementById("typed").hidden`);
                const readoutMm = async () => parseFloat(await evaluate(`document.body.dataset.readout ?? ""`));
                // a digit mid-drag is no typed length: a rectangle dragged in the top left, away from the polygon
                await evaluate(`document.querySelector('#tools2d [data-tool=rectangle]').click()`);
                const ra = [tx + tw * 0.05, ty + th * 0.1];
                await mouse("mouseMoved", ra[0], ra[1], { buttons: 0 });
                await mouse("mousePressed", ra[0], ra[1]);
                await mouse("mouseMoved", ra[0] + 30, ra[1] + 20);
                await until("the drag's read-out", async () => (await evaluate(`document.body.dataset.readout ?? ""`)) !== "", 10000);
                await key("5", "Digit5", 53);
                if (await boxOpen()) throw new Error("a digit mid-drag opened the typed box");
                await mouse("mouseReleased", ra[0] + 30, ra[1] + 20);
                await until("the dragged rectangle", async () => (await patternCount()) === 1, 30000);
                await evaluate(`document.querySelector('#tools2d [data-tool=polygon]').click()`);
                const nT = await patternCount();
                const wP = await fresh(P);
                await click(P);
                await until("the first point placed", async () => (await evaluate(`document.body.dataset.readout ?? ""`)) !== "", 10000);
                // Shift pressed in the box locks the angle once the box is closed
                await key("7", "Digit7", 55);
                await until("the typed box (for Shift)", boxOpen, 10000);
                await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 8 });
                await key("Escape", "Escape", 27, 8);
                await until("the typed box closed", async () => !(await boxOpen()), 10000);
                await mouse("mouseMoved", P[0] + 60, P[1] - 35, { buttons: 0, modifiers: 8 });   // about 30 degrees up
                await until("the angle lock from Shift in the box", async () => (await evaluate(`document.body.dataset.snapAngle`)) === "45", 30000);
                await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 0 });
                await mouse("mouseMoved", P[0] + 61, P[1] - 33, { buttons: 0 });
                await until("the angle lock released", async () => (await evaluate(`document.body.dataset.snapAngle`)) === "", 30000);
                const w80 = await fresh([P[0] + 40 * mm, P[1]]);    // the direction: +x, answered before the digit; 40 mm in
                await until("the read-out", async () => /^\d+\.\d mm$/.test(await evaluate(`document.body.dataset.readout ?? ""`)), 10000);
                await typeLen("100", 0);             // at 0 degrees: the pointer's hover may snap off the row
                // the next length, the pointer still (40 mm in, behind the new point): from the new point toward
                // the pointer, so 30 mm back; the read-out is then 30 mm shorter. Backspace drops the point
                const back = Math.hypot(wP[0] + 100 - w80[0], wP[1] - w80[1]);
                if (!(back > 40)) throw new Error(`the pointer is ${back} mm from the 100 mm point: not behind it`);
                await until(`the 100 mm point (read-out ${back.toFixed(1)} mm)`, async () => Math.abs((await readoutMm()) - back) < 0.15, 10000);
                await typeLen("30");
                try { await until(`the 30 mm point toward the pointer (read-out ${(back - 30).toFixed(1)} mm)`, async () => Math.abs((await readoutMm()) - (back - 30)) < 0.15, 10000); }
                catch (e) { throw new Error(`${e.message}: read-out ${await readoutMm()}, P at ${wP}, the pointer at ${w80}`); }
                await key("Backspace", "Backspace", 8);
                await until("the 30 mm point dropped", async () => Math.abs((await readoutMm()) - back) < 0.15, 10000);
                // a length that is no finite number above 0 places nothing: the box stays, the status says why
                await key("1", "Digit1", 49);
                await until("the typed box (for 1e999)", boxOpen, 10000);
                await send("Input.insertText", { text: "e999" });
                await key("Enter", "Enter", 13);
                await until("the refusal", async () => /length above 0/.test((await statusError()) ?? ""), 10000);
                if (!(await boxOpen())) throw new Error("a refused length closed the typed box");
                if (!(Math.abs((await readoutMm()) - back) < 0.15)) throw new Error("a refused length placed a point");
                await key("Escape", "Escape", 27);
                await until("the typed box closed", async () => !(await boxOpen()), 10000);
                // the box's keys are the box's: E (Ellipse), F3 and Delete do nothing, Ctrl+S saves as from any field;
                // by the well's bottom right corner the box stays inside the well; Escape closes it and the shape goes on
                await mouse("mouseMoved", tx + tw - 2, ty + th - 2, { buttons: 0 });
                await key("7", "Digit7", 55);
                await until("the typed box (by the corner)", boxOpen, 10000);
                {
                    const inside = await evaluate(`(() => { const b = document.getElementById("typed").getBoundingClientRect(), w = document.getElementById("well").getBoundingClientRect();
                        return b.left >= w.left && b.top >= w.top && b.right <= w.right + 0.5 && b.bottom <= w.bottom + 0.5; })()`);
                    if (!inside) throw new Error(`the typed box runs out of the well: ${await evaluate(`JSON.stringify([document.getElementById("typed").getBoundingClientRect(), document.getElementById("well").getBoundingClientRect(), document.getElementById("typed").style.cssText])`)}`);
                }
                await key("e", "KeyE", 69); await key("F3", "F3", 114); await key("Delete", "Delete", 46);
                const savedInBox = await saveJson();
                if (savedInBox.nodes.filter((n) => n.kind === "garment.pattern").length !== 1) throw new Error("Ctrl+S in the box did not save the garment");
                // the save takes the focus from any field (its edit is kept): the box closes, the shape goes on
                await until("the typed box closed", () => evaluate(`document.getElementById("typed").hidden`), 10000);
                const armed = await evaluate(`document.querySelector('#tools2d [data-tool].on')?.dataset.tool`);
                if (armed !== "polygon") throw new Error(`the box's keys reached the app: ${armed} armed`);
                if (await evaluate(`document.getElementById("split").classList.contains("max3d")`)) throw new Error("F3 in the box maximised the 3D window");
                await typeLen("50", 90);
                await typeLen("100", 180);
                await mouse("mouseMoved", P[0], P[1], { buttons: 0 });
                await click(P);
                await until("the typed polygon", async () => (await patternCount()) === nT + 1, 30000);
                await evaluate(`[...document.querySelectorAll('#browser-patterns li[data-kind=pattern]')].at(-1).click()`);
                await until("its size", () => evaluate(`/size\\s*100\\s*×\\s*50/.test(document.getElementById("props").textContent)`), 30000);
                // the box closed, the shortcuts are back: E arms the ellipse
                await key("e", "KeyE", 69);
                await until("E arms the ellipse", async () => (await evaluate(`document.querySelector('#tools2d [data-tool].on')?.dataset.tool`)) === "ellipse", 10000);
                await key("Escape", "Escape", 27);
                await noStatusError();
                failIfErrors();
                ok("typed lengths: 100, 50 at 90°, 100 at 180°, closed: 100 x 50; refusals, Shift, mid-drag, clamp, Ctrl+S in the box");

                // ---- Cut, and Cut & Sew (Task 17): the polygon cut along x + 50, then its left half sewn across ----
                // its corner from the saved document; the screen mapping re-measured with Edit armed (no snap on the hover)
                const saved = await saveJson();
                const polyId = saved.nodes.find((n) => n.id === "garment").patterns.at(-1);
                const c0 = saved.nodes.find((n) => n.id === `${polyId}_outline`).path.start;
                await evaluate(`document.querySelector('#tools2d [data-tool=edit]').click()`);
                const wA = await fresh([P[0] + 1, P[1]]), wB = await worldOf([P[0] + 51, P[1]]);
                const pxPerMm = 50 / (wB[0] - wA[0]);
                const wAt = [wA[0] - 1 / pxPerMm, wA[1]];            // the world under P
                const screenOf = ([x, y]) => [P[0] + (x - wAt[0]) * pxPerMm, P[1] - (y - wAt[1]) * pxPerMm];
                // the atelier worker held busy for `ms` (not awaited: it answers when the stall ends), so a click's
                // release is still on its way when the next key is pressed
                const stallWorker = async (ms) => {
                    const s = [...workerSessions].find(([url]) => url.includes("atelier-worker"))?.[1];
                    if (!s) throw new Error(`no atelier worker session among ${[...workerSessions.keys()]}`);
                    cdp.send("Runtime.evaluate", { expression: `{ const t = Date.now(); while (Date.now() - t < ${ms}); }` }, s).catch(() => {});
                    await sleep(300);                   // the stall under way before the click
                };
                await evaluate(`[...document.querySelectorAll('#browser-patterns li[data-kind=pattern]')].at(-1).click()`);
                await until("the polygon selected", () => evaluate(`/size\\s*100\\s*×\\s*50/.test(document.getElementById("props").textContent)`), 30000);
                const nC = await patternCount();
                await evaluate(`document.querySelector('#tools2d [data-tool=cut]').click()`);
                // the race: the second click's release held up in the worker, Enter pressed at once. Enter waits
                // for the release, so the cutter has both points (else "a cutter needs two points")
                await click(screenOf([c0[0] + 50, c0[1] - 15]));
                await stallWorker(2500);
                await click(screenOf([c0[0] + 50, c0[1] + 65]));
                await key("Enter", "Enter", 13);
                try { await until("two pieces from one", async () => (await patternCount()) === nC + 1, 30000); }
                catch (e) { throw new Error(`${e.message}: ${await patternCount()} pieces (${nC}); status "${await evaluate(`document.getElementById("status-text").textContent`)}"`); }
                await noStatusError();
                // the halves by their outlines (the saved document): at this zoom a half's fill lies under its
                // neighbour's label, so a click on the fill may answer the other piece; the list selects by id
                const halves = (await saveJson()).nodes.filter((n) => n.kind === "profile.path" && Math.abs(n.path.start[1] - c0[1]) < 60)
                    .map((n) => ({ id: n.id.replace(/_outline$/, ""), x: Math.min(n.path.start[0], ...n.path.segments.map((g) => g.to[0])) }));
                const leftHalf = halves.find((h) => Math.abs(h.x - c0[0]) < 1)?.id, rightHalf = halves.find((h) => Math.abs(h.x - c0[0] - 50) < 1)?.id;
                if (!leftHalf || !rightHalf) throw new Error(`the halves: ${JSON.stringify(halves)}`);
                const selectedPiece = () => evaluate(`document.querySelector("#browser-patterns li[data-kind=pattern].on")?.dataset.id ?? ""`);
                const selectPiece = async (id) => {
                    await evaluate(`document.querySelector('#browser-patterns li[data-kind=pattern][data-id="${id}"]').click()`);
                    await until(`${id} selected`, async () => (await selectedPiece()) === id, 30000);
                };
                // the order kept with two clicks in flight: click, Enter, click within one held-up round trip on the
                // right half. Enter goes to the tool between the clicks (one point: refused), not after both (a cut)
                await selectPiece(rightHalf);
                await evaluate(`document.querySelector('#tools2d [data-tool=cut]').click()`);
                await stallWorker(2500);
                await click(screenOf([c0[0] + 75, c0[1] - 15]));
                await key("Enter", "Enter", 13);
                await click(screenOf([c0[0] + 75, c0[1] + 65]));
                await until("Enter between the clicks", async () => /a cutter needs two points/.test((await statusError()) ?? ""), 30000);
                const afterRace = await saveJson();             // the round trip: the second click and anything it did handled
                if (afterRace.nodes.filter((n) => n.kind === "garment.pattern").length !== nC + 1 || (await patternCount()) !== nC + 1) throw new Error("Enter waited for the click after it: the piece was cut");
                await key("Escape", "Escape", 27);
                // the left half, then Cut & Sew across its middle
                await selectPiece(leftHalf);
                const sC = await seamCount();
                await evaluate(`document.querySelector('#tools2d [data-tool=cut-sew]').click()`);
                await click(screenOf([c0[0] - 15, c0[1] + 25]));
                await click(screenOf([c0[0] + 60, c0[1] + 25]));
                await key("Enter", "Enter", 13);
                try { await until("cut and sewn", async () => (await patternCount()) === nC + 2 && (await seamCount()) === sC + 1, 30000); }
                catch (e) { throw new Error(`${e.message}: ${await patternCount()} pieces (${nC} before the cut), ${await seamCount()} seams (${sC}); status "${await evaluate(`document.getElementById("status-text").textContent`)}"`); }
                await noStatusError();
                // a cutter that does not cross the piece: refused, the status says so, nothing changes
                await evaluate(`[...document.querySelectorAll('#browser-patterns li[data-kind=pattern]')].at(-1).click()`);
                await evaluate(`document.querySelector('#tools2d [data-tool=cut]').click()`);
                await click(screenOf([c0[0] + 75, c0[1] - 40]));
                await click(screenOf([c0[0] + 75, c0[1] - 25]));
                await key("Enter", "Enter", 13);
                try { await until("the refusal", async () => /cross/.test((await statusError()) ?? ""), 30000); }
                catch (e) { throw new Error(`${e.message}: status "${await evaluate(`document.getElementById("status-text").textContent`)}"`); }
                if ((await patternCount()) !== nC + 2 || (await seamCount()) !== sC + 1) throw new Error("a refused cut changed the garment");
                await key("Escape", "Escape", 27);
                failIfErrors();
                ok("cut: one piece became two; cut & sew: two more and one seam joining them; a miss refused");

                // ---- the simulation's 2D tools: a Fold line across the right half, its angle in the properties;
                // a Tack from the right half to a left piece, shown, selected, deleted ----
                await selectPiece(rightHalf);
                await evaluate(`document.querySelector('#tools2d [data-tool=fold]').click()`);
                await click(screenOf([c0[0] + 80, c0[1] + 8]));
                await click(screenOf([c0[0] + 80, c0[1] + 42]));
                await key("Enter", "Enter", 13);
                const foldOf = async () => (await saveJson()).nodes.find((n) => n.id === rightHalf).internal?.find((l) => l.kind === "fold");
                await until("the fold line", foldOf, 30000);
                await until("the fold line selected", () => evaluate(`/Internal line on/.test(document.querySelector("#props h3")?.textContent ?? "")`), 30000);
                await setField("angle", "90");
                await until("the fold angle", async () => (await foldOf())?.angle === 90, 30000);
                await noStatusError();
                ok("Fold line: drawn across a piece, selected, its angle set to 90");
                const tacks = async () => (await saveJson()).nodes.filter((n) => n.kind === "garment.tack");
                await evaluate(`document.querySelector('#tools2d [data-tool=tack]').click()`);
                // each click once the worker has answered a hover there (the tool switch has landed)
                for (const q of [[c0[0] + 62, c0[1] + 12], [c0[0] + 20, c0[1] + 12]]) {
                    await hoverInfo(screenOf(q));
                    await click(screenOf(q));
                }
                await until("the tack", async () => (await tacks()).length === 1, 30000)
                    .catch(async (e) => { throw new Error(`${e.message}: status "${await evaluate(`document.getElementById("status-text").textContent`)}", tool ${await evaluate(`document.querySelector('#tools2d [aria-pressed=true], #tools2d .active')?.dataset.tool ?? "?"`)}, hovers ${JSON.stringify([await hoverInfo(screenOf([c0[0] + 62, c0[1] + 12])), await hoverInfo(screenOf([c0[0] + 20, c0[1] + 12]))])}, right half ${rightHalf}`); });
                const [tk] = await tacks();
                if (tk.a !== rightHalf || tk.b === rightHalf || Math.abs(tk.a_at[0] - c0[0] - 62) > 3) throw new Error(`the tack: ${JSON.stringify(tk)}`);
                await until("the tack selected", () => evaluate(`/^Tack/.test(document.querySelector("#props h3")?.textContent ?? "")`), 30000);
                // drawn: its items leave the scene with it (the selected line's edit points went with the tack's selection)
                const itemsTack = Number(await evaluate(`document.body.dataset.items2d`));
                await key("Escape", "Escape", 27);
                await key("Delete", "Delete", 46);
                await until("the tack deleted", async () => (await tacks()).length === 0, 30000);
                await until("the tack's drawing gone", async () => Number(await evaluate(`document.body.dataset.items2d`)) <= itemsTack - 2, 30000);
                if ((await saveJson()).nodes.find((n) => n.id === "garment").tacks !== undefined) throw new Error("the garment kept an empty tacks list");
                await noStatusError();
                failIfErrors();
                ok("Tack: two clicks on two pieces, drawn and selected, Delete removes it");
            }
            // ---- curved internal line (A1 task A5): Internal with a drag places a curve point; Edit drags its handle ----
            {
                await evaluate(`document.getElementById("menu-new").click()`);
                await until("an empty garment", async () => (await patternCount()) === 0, 30000);
                const [ux, uy, uw, uh] = await windowBox("rect2d");
                const Q = [ux + uw * 0.25, uy + uh * 0.85];
                await evaluate(`document.querySelector('#tools2d [data-tool=edit]').click()`);
                lastSeen = await evaluate(`document.body.dataset.world ?? ""`);
                const w1 = await worldOf([Q[0] + 1, Q[1]]), w2 = await worldOf([Q[0] + 51, Q[1]]);
                const mm = 50 / (w2[0] - w1[0]);
                if (!(Q[0] + 200 * mm < ux + uw && Q[1] - 100 * mm > uy)) throw new Error("the 200 x 100 piece does not fit the 2D window");
                const wQ = [w1[0] - 1 / mm, w1[1]];
                const screenAt = ([x, y]) => [Q[0] + (x - wQ[0]) * mm, Q[1] - (y - wQ[1]) * mm];
                await byDialog("rectangle", Q, 200, 100);
                await until("the piece", async () => (await patternCount()) === 1, 30000);
                await evaluate(`[...document.querySelectorAll('#browser-patterns li[data-kind=pattern]')].at(-1).click()`);
                const d0 = await saveJson();
                const pid = d0.nodes.find((n) => n.kind === "garment.pattern").id;
                const o = d0.nodes.find((n) => n.id === `${pid}_outline`).path.start;
                await until("the piece selected", () => evaluate(`!!document.querySelector('#browser li[data-kind=pattern][data-id="${pid}"]')?.classList.contains("on")`), 30000);
                await evaluate(`document.querySelector('#tools2d [data-tool=internal]').click()`);
                await click(screenAt([o[0] + 30, o[1] + 30]));
                await drag(screenAt([o[0] + 90, o[1] + 65]), screenAt([o[0] + 125, o[1] + 65]), 8, 200);   // the press lands before the moves (a slow software frame)
                await click(screenAt([o[0] + 170, o[1] + 30]));
                await key("Enter", "Enter", 13);
                const d1 = await until("the internal line", async () => { const d = await saveJson(); return d.nodes.find((n) => n.id === pid)?.internal?.length ? d : null; }, 30000);
                await noStatusError();
                const line0 = d1.nodes.find((n) => n.id === pid).internal[0].path;
                if (line0.segments.length !== 2 || !line0.segments.every((g) => g.type === "bezier")) throw new Error(`the internal line is ${JSON.stringify(line0)}, not two cubics`);
                // Edit (armed by the line's end): the handle out of the curve point answers as an internal handle; a drag moves it
                const c1 = line0.segments[1].c1;
                await worldOf(screenAt(c1));
                {
                    const hit = await evaluate(`document.body.dataset.hit`);
                    if (hit !== "ihandle") throw new Error(`the internal handle's hover answered ${hit}, not ihandle`);
                }
                await drag(screenAt(c1), screenAt([c1[0], c1[1] + 20]), 8, 200);
                const d2 = await until("the handle moved", async () => {
                    const d = await saveJson();
                    const g = d.nodes.find((n) => n.id === pid).internal[0].path.segments[1];
                    return Math.abs(g.c1[1] - c1[1] - 20) < 2 ? d : null;
                }, 30000);
                const line1 = d2.nodes.find((n) => n.id === pid).internal[0].path;
                if (JSON.stringify(line1.segments[0]) !== JSON.stringify(line0.segments[0])) throw new Error("the handle's drag moved the other segment");
                await noStatusError();
                failIfErrors();
                ok("curved internal line: a drag places a curve point; Edit drags its handle");

                // ---- Ruler (A1 task A9): Edit's hover names a side's length; R arms the Ruler; two clicks, an edge click, Escape ----
                const statusText = () => evaluate(`document.getElementById("status-text").textContent`);
                await worldOf(screenAt([o[0] + 60, o[1]]));               // the bottom side, a third along (off its midpoint)
                await until("the hover read-out", async () => /side \d: 200\.0 mm/.test(await statusText()), 10000);
                await key("r", "KeyR", 82);
                await until("the Ruler armed", () => evaluate(`document.querySelector('#tools2d [data-tool=ruler]').classList.contains("on")`), 10000);
                const labels = () => evaluate(`document.body.dataset.labels2d ?? ""`);
                // each click's point as the worker answered it (snapped: the measure is between those)
                const clickAt = async (p) => { await click(p); return (await until(`the click at ${p}`, () => answeredAt(p), 10000)).split(",").map(Number); };
                const r1 = await clickAt(screenAt([o[0] + 20, o[1] + 85]));
                const r2 = await clickAt(screenAt([o[0] + 80, o[1] + 85]));
                const two = await until("a two-click measure", async () => { const l = await labels(); return l ? l : null; }, 10000);
                const want = Math.hypot(r2[0] - r1[0], r2[1] - r1[1]);
                if (!/^\d+\.\d mm$/.test(two) || Math.abs(parseFloat(two) - want) > 0.051 || want < 30) throw new Error(`the two-click measure reads "${two}", not ${want.toFixed(1)} mm (${r1} to ${r2})`);
                await click(screenAt([o[0] + 200, o[1] + 30]));         // the right side, off its midpoint
                const both = await until("the side measure", async () => { const l = (await labels()).split("|"); return l.length === 2 ? l : null; }, 10000)
                    .catch(async (e) => { throw new Error(`${e.message}: hit ${await evaluate(`document.body.dataset.hit`)}, snap ${await evaluate(`document.body.dataset.snap`)}, labels "${await labels()}", status "${await statusText()}"`); });
                if (both[1] !== "100.0 mm") throw new Error(`the right side measures "${both[1]}" (status "${await statusText()}"), not 100.0 mm`);
                if ((await saveJson()).nodes.some((n) => /ruler|measure/i.test(JSON.stringify(n)))) throw new Error("a measure was saved");
                if ((await labels()).split("|").length !== 2) throw new Error("a save dropped the measures");
                await key("Escape", "Escape", 27);
                await until("the measures cleared, Edit armed", async () => (await labels()) === "" && await evaluate(`document.querySelector('#tools2d [data-tool=edit]').classList.contains("on")`), 10000);
                failIfErrors();
                ok(`ruler: hover read-out 200.0 mm; two clicks ${two}; a side 100.0 mm; Escape clears`);

                // ---- point editing (A1 task A4): a double click on an edge adds a point; the right click's
                // menu makes it a curve point; C makes it a corner again; Delete removes it ----
                const outlineNow = async () => (await saveJson()).nodes.find((n) => n.id === `${pid}_outline`).path;
                const P = screenAt([o[0] + 60, o[1]]);
                await worldOf(P);
                await click(P);
                await mouse("mousePressed", P[0], P[1], { clickCount: 2 });
                await mouse("mouseReleased", P[0], P[1], { clickCount: 2 });
                const p5 = await until("a fifth point", async () => { const p = await outlineNow(); return p.segments.length === 5 ? p : null; }, 30000);
                await noStatusError();
                if (Math.abs(p5.segments[0].to[1] - o[1]) > 1e-6 || Math.abs(p5.segments[0].to[0] - o[0] - 60) > 2) throw new Error(`the new point is at ${p5.segments[0].to}`);
                const Pn = screenAt(p5.segments[0].to);
                // the new point's edit point is drawn a frame after the commit (a slow software frame): hover until it answers
                await until("the new point's hover", async () => (await hoverInfo(Pn)).hit === "point", 30000)
                    .catch(async (e) => { throw new Error(`${e.message}: the hover answers ${(await hoverInfo(Pn)).hit}, not a point`); });
                await mouse("mousePressed", Pn[0], Pn[1], { button: "right", buttons: 2 });
                await mouse("mouseReleased", Pn[0], Pn[1], { button: "right", buttons: 0 });
                await until("the point menu", () => evaluate(`document.body.dataset.pointMenu === "curve" && !document.getElementById("point-menu").hidden`), 10000);
                await evaluate(`document.getElementById("point-curve").click()`);
                const pc = await until("a curve point", async () => { const p = await outlineNow(); return p.segments[0].type === "bezier" && p.segments[1].type === "bezier" ? p : null; }, 30000);
                await noStatusError();
                await worldOf([Pn[0] + 1, Pn[1]]);
                await worldOf(Pn);
                if (await evaluate(`document.body.dataset.hit`) !== "point") throw new Error(`the curve point hovers as ${await evaluate(`document.body.dataset.hit`)}`);
                await click(Pn);                 // the click selects the point; C, typed at once, waits for it
                await key("c", "KeyC", 67);
                await until("a corner again", async () => { const p = await outlineNow(); return p.segments.length === 5 && p.segments.every((g) => g.type === "line") ? p : null; }, 30000)
                    .catch(async (e) => { throw new Error(`${e.message}: status "${await evaluate(`document.getElementById("status-text").textContent`)}", ${JSON.stringify(await outlineNow())}`); });
                await key("Delete", "Delete", 46);
                const p4 = await until("the point removed", async () => { const p = await outlineNow(); return p.segments.length === 4 ? p : null; }, 30000);
                if (!p4.segments.every((g) => g.type === "line")) throw new Error(`after the delete: ${JSON.stringify(p4)}`);
                if (!(await saveJson()).nodes.some((n) => n.id === pid)) throw new Error("Delete removed the piece, not the point");
                await noStatusError();
                failIfErrors();
                ok(`point editing: a double click added a point, the menu made it a curve point (${pc.segments[0].type}), C a corner, Delete removed it`);

                // ---- notches (A1 task A6): the Notch tool places a slit; Edit selects its mark; the panel
                // makes it a V; the next notch placed is a V ----
                const notchesNow = async () => (await saveJson()).nodes.find((n) => n.id === pid).notches ?? [];
                await evaluate(`document.querySelector('#tools2d [data-tool=notch]').click()`);
                await click(screenAt([o[0] + 100, o[1] + 100]));
                const n1 = await until("a notch", async () => { const n = await notchesNow(); return n.length === 1 ? n : null; }, 30000);
                if (n1[0].kind !== "slit" || n1[0].depth !== 6) throw new Error(`the first notch is ${JSON.stringify(n1[0])}`);
                await key("Escape", "Escape", 27);
                await until("Edit armed", () => evaluate(`document.querySelector('#tools2d [data-tool=edit]').classList.contains("on")`), 10000);
                const mark = screenAt([o[0] + 100, o[1] + 97]);
                await worldOf(mark);
                if (await evaluate(`document.body.dataset.hit`) !== "notch") throw new Error(`the notch's mark hovers as ${await evaluate(`document.body.dataset.hit`)}`);
                await click(mark);
                await until("the notch's panel", () => evaluate(`!!${field("kind")}`), 10000);
                await setField("kind", "v");
                await until("the notch a V", async () => (await notchesNow())[0]?.kind === "v", 30000);
                if (await evaluate(`document.body.dataset.notchNext`) !== "v,6") throw new Error(`the Notch tool's next is ${await evaluate(`document.body.dataset.notchNext`)}`);
                await evaluate(`document.querySelector('#tools2d [data-tool=notch]').click()`);
                await click(screenAt([o[0] + 150, o[1] + 100]));
                const n2 = await until("a second notch", async () => { const n = await notchesNow(); return n.length === 2 ? n : null; }, 30000);
                if (n2[1].kind !== "v" || n2[1].depth !== 6) throw new Error(`the second notch is ${JSON.stringify(n2[1])}`);
                await key("Escape", "Escape", 27);
                await noStatusError();
                failIfErrors();
                ok("notches: placed a slit, selected its mark, set it to V in the panel; the next notch is a V");
                // ---- linked pair (A1 task A7): Sym across the top side; an Edit drag on the partner
                // moves the source's mirrored corner; Ctrl+Z takes both back; Unlink ----
                const pathOf = async (id) => (await saveJson()).nodes.find((n) => n.id === `${id}_outline`).path;
                const hasPoint = (path, [x, y], e = 2) => [path.start, ...path.segments.map((g) => g.to)].some((q) => Math.abs(q[0] - x) < e && Math.abs(q[1] - y) < e);
                const inWindow = ([x, y]) => x > ux && x < ux + uw && y > uy && y < uy + uh;
                if (!inWindow(screenAt([o[0] + 220, o[1] + 210]))) throw new Error("the linked partner above the piece does not fit the 2D window");
                await evaluate(`document.querySelector('#browser li[data-kind=pattern][data-id="${pid}"]').click()`);
                await evaluate(`document.querySelector('#tools2d [data-tool=sym]').click()`);
                await click(screenAt([o[0] + 30, o[1] + 100]));
                await click(screenAt([o[0] + 170, o[1] + 100]));
                const dSym = await until("the linked partner", async () => { const d = await saveJson(); return d.nodes.filter((n) => n.kind === "garment.pattern").length === 2 ? d : null; }, 30000);
                await noStatusError();
                const partner = dSym.nodes.find((n) => n.kind === "garment.pattern" && n.id !== pid);
                if (partner.meta?.atelier?.link?.partner !== pid || dSym.nodes.find((n) => n.id === pid).meta?.atelier?.link?.partner !== partner.id) throw new Error(`the pair is not linked: ${JSON.stringify(partner.meta)}`);
                await until("Edit armed, the partner selected", () => evaluate(`document.querySelector('#tools2d [data-tool=edit]').classList.contains("on") && !!document.querySelector('#browser li[data-kind=pattern][data-id="${partner.id}"]')?.classList.contains("on")`), 10000);
                const corner = screenAt([o[0] + 200, o[1] + 200]);
                await worldOf(corner);
                if (await evaluate(`document.body.dataset.hit`) !== "point") throw new Error(`the partner's corner hovers as ${await evaluate(`document.body.dataset.hit`)}`);
                await drag(corner, screenAt([o[0] + 220, o[1] + 210]));
                await until("the source follows the partner", async () => hasPoint(await pathOf(pid), [o[0] + 220, o[1] - 10], 5), 30000)
                    .catch(async (e) => { throw new Error(`${e.message}: ${JSON.stringify(await pathOf(pid))}`); });
                if (!hasPoint(await pathOf(partner.id), [o[0] + 220, o[1] + 210], 5)) throw new Error("the partner's corner did not move");
                await key("z", "KeyZ", 90, 2);
                const before = (id) => JSON.stringify(dSym.nodes.find((n) => n.id === `${id}_outline`).path);
                await until("one undo takes both back", async () => JSON.stringify(await pathOf(pid)) === before(pid) && JSON.stringify(await pathOf(partner.id)) === before(partner.id), 30000)
                    .catch(async (e) => { throw new Error(`${e.message}: ${JSON.stringify(await pathOf(pid))} / ${JSON.stringify(await pathOf(partner.id))} (were ${before(pid)} / ${before(partner.id)})`); });
                await evaluate(`document.querySelector('#browser li[data-kind=pattern][data-id="${pid}"]').click()`);
                await until("the Unlink button", () => evaluate(`!!${field("unlink")}`), 10000);
                await evaluate(`${field("unlink")}.click()`);
                await until("unlinked", async () => !(await saveJson()).nodes.some((n) => n.meta?.atelier?.link), 30000);
                await noStatusError();
                failIfErrors();
                ok("linked pair: Sym added a linked partner; an Edit drag on it moved the source's corner; Ctrl+Z took both back; Unlink");

                // ---- unfold (A1 task A8): a click on the left side makes the piece whole; Fold back ----
                await evaluate(`document.querySelector('#tools2d [data-tool=unfold]').click()`);
                const left = screenAt([o[0], o[1] + 40]);
                await worldOf(left);
                await click(left);
                const whole = await until("the whole", async () => { const p = await pathOf(pid); return p.segments.length === 6 ? p : null; }, 30000)
                    .catch(async (e) => { throw new Error(`${e.message}: status "${await evaluate(`document.getElementById("status-text").textContent`)}"`); });
                await noStatusError();
                if (!hasPoint(whole, [o[0] - 200, o[1]], 1e-6) || !hasPoint(whole, [o[0] - 200, o[1] + 100], 1e-6)) throw new Error(`the whole is ${JSON.stringify(whole)}`);
                if (whole.segments.some((g, i) => Math.abs(g.to[0] - o[0]) < 1e-9 && Math.abs((i ? whole.segments[i - 1].to : whole.start)[0] - o[0]) < 1e-9)) throw new Error("the fold side is still a side");
                await until("the Fold back button", () => evaluate(`!!${field("foldBack")}`), 10000);
                await evaluate(`${field("foldBack")}.click()`);
                const back = await until("the half again", async () => { const p = await pathOf(pid); return p.segments.length === 4 ? p : null; }, 30000);
                if (!hasPoint(back, [o[0], o[1]], 1e-6) || !hasPoint(back, [o[0] + 200, o[1] + 100], 1e-6)) throw new Error(`folded back: ${JSON.stringify(back)}`);
                if ((await saveJson()).nodes.find((n) => n.id === pid).meta?.atelier?.unfold) throw new Error("Fold back kept the unfold");
                await noStatusError();
                failIfErrors();
                ok("unfold: a click on the left side made the piece whole (6 sides, twice as wide); Fold back gave the half");

                // ---- grading (A3): sizes by the dialog (typed, reordered), Proportional…, an Edit drag in L
                // sets the corner's rule, the grade table types one, switches, Show sizes, undo ----
                const docNow = async () => (await saveJson()).nodes;
                const tableNow = async () => (await docNow()).find((n) => n.id === "garment").meta?.atelier?.grading ?? null;
                const rulesNow = async () => (await docNow()).find((n) => n.id === pid).meta?.atelier?.grade?.rules ?? {};
                await evaluate(`document.getElementById("sizes-open").click()`);
                if (!(await evaluate(`document.getElementById("sizes-dialog").open`))) throw new Error("Sizes… did not open its dialog");
                for (const name of ["M", "L", "XL", "S"]) {
                    const n0 = await evaluate(`document.querySelectorAll("#sizes-list li").length`);
                    await evaluate(`document.getElementById("sizes-name").focus()`);
                    await send("Input.insertText", { text: name });
                    await key("Enter", "Enter", 13);
                    await until(`size ${name} in the dialog`, () => evaluate(`document.querySelectorAll("#sizes-list li").length === ${n0 + 1}`), 30000);
                }
                // S up three times: S M L XL; each move one batch
                for (let i = 0; i < 3; i++) {
                    const order = await evaluate(`[...document.querySelectorAll("#sizes-list input[type=text]")].map((e) => e.value).join(",")`);
                    await evaluate(`[...document.querySelectorAll("#sizes-list li")].at(${3 - i}).querySelector("button").click()`);
                    await until("the size moved up", () => evaluate(`[...document.querySelectorAll("#sizes-list input[type=text]")].map((e) => e.value).join(",") !== ${JSON.stringify(order)}`), 30000);
                }
                const t0 = await tableNow();
                if (JSON.stringify(t0) !== JSON.stringify({ sizes: ["S", "M", "L", "XL"], base: "M", current: "M" })) throw new Error(`the size table: ${JSON.stringify(t0)}`);
                await evaluate(`document.getElementById("sizes-close").click()`);
                const options = await evaluate(`[...document.getElementById("size-select").options].map((o) => o.textContent).join(",")`);
                if (options !== "S,M (base),L,XL") throw new Error(`the size select: ${options}`);
                // Proportional… on the selected piece: 20 mm wide, 10 high a size step
                await evaluate(`document.querySelector('#browser li[data-kind=pattern][data-id="${pid}"]').click()`);
                await until("the Proportional button", () => evaluate(`!!${field("grade-proportional")}`), 10000);
                await evaluate(`${field("grade-proportional")}.click()`);
                await until("the step dialog", () => evaluate(`document.getElementById("size-dialog").open && document.getElementById("size-w").value === "20"`), 10000);
                await evaluate(`document.getElementById("size-ok").click()`);
                const outM = await pathOf(pid), vM = [outM.start, ...outM.segments.slice(0, -1).map((g) => g.to)];
                const tr = vM.findIndex((q) => Math.abs(q[0] - o[0] - 200) < 1e-6 && Math.abs(q[1] - o[1] - 100) < 1e-6);
                if (tr < 0) throw new Error(`no top right corner in ${JSON.stringify(vM)}`);
                await until("the proportional rules", async () => JSON.stringify((await rulesNow())[tr]) === JSON.stringify({ S: [-10, -5], L: [10, 5], XL: [20, 10] }), 30000)
                    .catch(async (e) => { throw new Error(`${e.message}: ${JSON.stringify(await rulesNow())}`); });
                if (JSON.stringify(await pathOf(pid)) !== JSON.stringify(outM)) throw new Error("rules set in M moved the outline");
                // switch to L: the corner moves by its rule
                const pickSize = (s) => evaluate(`(() => { const e = document.getElementById("size-select"); e.value = ${JSON.stringify(s)}; e.dispatchEvent(new Event("change")); })()`);
                await pickSize("L");
                await until("size L", async () => hasPoint(await pathOf(pid), [o[0] + 210, o[1] + 105], 1e-6), 30000);
                if (await evaluate(`document.body.dataset.size`) !== "L") throw new Error("the select does not show L");
                // an Edit drag of the corner in L sets its L rule (+10 mm more in x)
                await evaluate(`document.querySelector('#tools2d [data-tool=edit]').click()`);
                const cL = screenAt([o[0] + 210, o[1] + 105]);
                await worldOf(cL);
                if (await evaluate(`document.body.dataset.hit`) !== "point") throw new Error(`the L corner hovers as ${await evaluate(`document.body.dataset.hit`)}`);
                await drag(cL, screenAt([o[0] + 220, o[1] + 105]));
                const dragged = await until("the drag's L rule", async () => { const r = (await rulesNow())[tr]; return r && Math.abs(r.L[0] - 20) < 2 && r.L[0] !== 10 ? r : null; }, 30000)
                    .catch(async (e) => { throw new Error(`${e.message}: ${JSON.stringify(await rulesNow())}; status "${await evaluate(`document.getElementById("status-text").textContent`)}"`); });
                if (JSON.stringify(dragged.XL) !== "[20,10]" || JSON.stringify(dragged.S) !== "[-10,-5]") throw new Error(`the drag changed other sizes: ${JSON.stringify(dragged)}`);
                await noStatusError();
                // the grade table: a click selects the corner; its rows; dx typed in L
                const cL2 = screenAt([o[0] + 200 + dragged.L[0], o[1] + 100 + dragged.L[1]]);
                await worldOf(cL2);
                await click(cL2);
                await until("the grade table", () => evaluate(`!!${field("grade-dx-L")}`), 10000);
                const rows = await evaluate(`[...document.querySelectorAll("#props table.grade tr")].slice(1).map((r) => [...r.querySelectorAll("td")].map((c) => c.querySelector("input")?.value ?? c.textContent).join(" "))`);
                if (rows[1] !== "M (base) 0 0" || !rows[3].startsWith("XL 20 10")) throw new Error(`the grade rows: ${JSON.stringify(rows)}`);
                if (!(await evaluate(`${field("grade-dx-M")}.disabled`))) throw new Error("the base row is editable");
                await typeInto("grade-dx-L", "25");
                await key("Enter", "Enter", 13);
                await until("the typed rule", async () => (await rulesNow())[tr]?.L?.[0] === 25, 30000);
                await until("L follows the typed rule", async () => hasPoint(await pathOf(pid), [o[0] + 225, o[1] + 100 + dragged.L[1]], 1e-6), 30000);
                await noStatusError();
                failIfErrors();
                ok(`grading: sizes added and reordered in the dialog (S M L XL), Proportional… 20 x 10, an Edit drag in L set the corner's rule (${dragged.L.map((v) => v.toFixed(1)).join(", ")}), the table typed 25`);
                if (process.env.ATELIER_SHOT_GRADE) {          // fitted: screenAt is stale after it (nothing below uses it)
                    await evaluate(`document.querySelector('#tools2d [data-command=fit]').click()`);
                    await sleep(1000); await frames();
                    const { data } = await send("Page.captureScreenshot", { format: "png" });
                    writeFileSync(process.env.ATELIER_SHOT_GRADE, Buffer.from(data, "base64"));
                    ok(`screenshot ${process.env.ATELIER_SHOT_GRADE}`);
                }
                // Show sizes: the other sizes' outlines of the selected piece, not saved; M back to the base
                await evaluate(`document.getElementById("show-sizes").click()`);
                await until("the graded nest", () => evaluate(`document.body.dataset.nest === "${pid}:S,${pid}:M,${pid}:XL"`), 30000)
                    .catch(async (e) => { throw new Error(`${e.message}: nest "${await evaluate(`document.body.dataset.nest`)}"`); });
                if (process.env.ATELIER_SHOT_NEST) {
                    await sleep(1000); await frames();
                    const { data } = await send("Page.captureScreenshot", { format: "png" });
                    writeFileSync(process.env.ATELIER_SHOT_NEST, Buffer.from(data, "base64"));
                    ok(`screenshot ${process.env.ATELIER_SHOT_NEST}`);
                }
                if ((await docNow()).some((n) => JSON.stringify(n.meta ?? {}).includes("showSizes"))) throw new Error("Show sizes was saved");
                await pickSize("M");
                await until("size M", async () => JSON.stringify(await pathOf(pid)) === JSON.stringify(outM), 30000);
                await until("the nest in M", () => evaluate(`document.body.dataset.nest === "${pid}:S,${pid}:L,${pid}:XL"`), 30000);
                // undo: back in L (the switch one step), then the typed rule undone
                await evaluate(`document.activeElement?.blur()`);
                await key("z", "KeyZ", 90, 2);
                await until("undo: size L again", async () => (await tableNow()).current === "L" && await evaluate(`document.body.dataset.size === "L"`), 30000);
                await key("z", "KeyZ", 90, 2);
                await until("undo: the typed rule gone", async () => Math.abs((await rulesNow())[tr].L[0] - dragged.L[0]) < 1e-9, 30000);
                await evaluate(`document.getElementById("show-sizes").click()`);
                await until("the nest off", () => evaluate(`document.body.dataset.nest === ""`), 30000);
                await noStatusError();
                failIfErrors();
                ok("grading: switched M (the base outline back), Show sizes drew S, M / L, XL; Ctrl+Z undid the switch, then the typed rule");
            }
            if (process.env.ATELIER_SHOT_HOLES) {     // fitted: the camera moves, so this comes last (pxPerMm is stale after it)
                await evaluate(`document.querySelector('#tools2d [data-command=fit]').click()`);
                await sleep(1000);
                const { data } = await send("Page.captureScreenshot", { format: "png" });
                writeFileSync(process.env.ATELIER_SHOT_HOLES, Buffer.from(data, "base64"));
                ok(`screenshot ${process.env.ATELIER_SHOT_HOLES}`);
            }
            // 8a. S2: darts closed and rotated, a pleat set, simulated
            await s2Block();
            // 8a'. sewing a hole's edge (A2 spec §2): a front with an armhole cut as an ellipse hole
            // and a sleeve, built in Node and opened; Sew sides takes a click on the armhole (the
            // hole's side) and one on the sleeve's cap: one seam, its front end on the hole (a_loop
            // 1), drawn on the hole's edge; Ctrl+Z takes it back in one step, Ctrl+Y redoes it
            {
                const k = await loadKernel();
                const src = new Atelier(k);
                src.reset(mm.newDocumentOps({ slug: "x", label: "X", params: Object.fromEntries(mm.FABRIC_FIELDS.map((n) => [n, 1])) }));
                src.apply(mm.addPattern(src.nodes(), { label: "Front", path: mm.rectPath(0, 0, 240, 300), fabric: "f_x" }).ops, "front");
                src.apply(mm.addPattern(src.nodes(), { label: "Sleeve", path: mm.rectPath(300, 120, 64, 120), fabric: "f_x" }).ops, "sleeve");
                src.apply(mm.addHole(src.nodes(), "p1", src.ellipsePath(170, 200, 30, 50)), "armhole");
                const file = join(downloads, "armhole.json");
                writeFileSync(file, src.save());
                src.free();
                await evaluate(`document.getElementById("menu-new").click()`);
                await until("an empty garment for the armhole", async () => (await patternCount()) === 0, 30000);
                await pickInto("menu-open", file, ".json");
                await until("the front and the sleeve", async () => (await patternCount()) === 2 && (await seamCount()) === 0, 30000);
                await evaluate(`document.querySelector('#tools2d [data-command=fit]').click()`);
                await sleep(1000); await frames();
                // the 2D window's mapping from three hovers (pattern mm per CSS px along x and y)
                const [gx, gy, gw, gh] = await windowBox("rect2d");
                const p0 = [gx + gw / 2, gy + gh / 2];
                await evaluate(`document.querySelector('#tools2d [data-tool=segment]').click()`);
                const w0 = await worldOf(p0), wx = await worldOf([p0[0] + 50, p0[1]]), wy = await worldOf([p0[0], p0[1] + 50]);
                const toPx = ([x, y]) => [p0[0] + (x - w0[0]) * 50 / (wx[0] - w0[0]), p0[1] + (y - w0[1]) * 50 / (wy[1] - w0[1])];
                // the armhole's upper-left quarter (hole side 1) at 135 degrees, the sleeve's top side (its cap) near its left end
                const onHole = toPx([170 - 30 * Math.SQRT1_2, 200 + 50 * Math.SQRT1_2]), onCap = toPx([310, 240]);
                await worldOf(onHole);
                {
                    const hit = await evaluate(`document.body.dataset.hit`);
                    if (hit !== "hole") throw new Error(`the armhole's hover answered ${hit}`);
                }
                await click(onHole);
                await click(onCap);
                await until("the sleeve sewn to the armhole", async () => (await seamCount()) === 1, 30000);
                await noStatusError();
                const seam = (await saveJson()).nodes.find((n) => n.kind === "garment.seam");
                if (seam.a_loop !== 1 || seam.b_loop || seam.meta?.atelier?.a?.length !== 5 || seam.meta.atelier.a[4] !== 1)
                    throw new Error(`the seam is not on the armhole: ${JSON.stringify(seam)}`);
                if (process.env.ATELIER_SHOT_HOLE_SEAM) {
                    // the fabric selected instead of the seam: the seam drawn in its own colour, no piece in the accent
                    await key("Escape", "Escape", 27);
                    await evaluate(`document.querySelector('#browser-fabrics li[data-kind=fabric]').click()`);
                    await until("the seam deselected", async () => !(await evaluate(`!!document.querySelector('#browser-seams li[data-kind=seam].on')`)), 10000);
                    await mouse("mouseMoved", gx + 5, gy + 5, { buttons: 0 });
                    await sleep(800); await frames();
                    const { data } = await send("Page.captureScreenshot", { format: "png" });
                    writeFileSync(process.env.ATELIER_SHOT_HOLE_SEAM, Buffer.from(data, "base64"));
                    ok(`screenshot ${process.env.ATELIER_SHOT_HOLE_SEAM}`);
                }
                await key("z", "KeyZ", 90, 2);
                await until("the hole seam undone", async () => (await seamCount()) === 0, 30000);
                await key("y", "KeyY", 89, 2);
                await until("the hole seam redone", async () => (await seamCount()) === 1, 30000);
                await noStatusError();
                failIfErrors();
                ok("hole edge sewn: a click on the armhole and one on the sleeve's cap gave one seam on loop 1; undone, redone");
            }
            // 8b. V3: custom forms and a posed drape
            await v3();
        } finally { try { rmSync(downloads, { recursive: true, force: true }); } catch { /* left behind */ } }
        // 9. no console error anywhere, page or worker
        await sleep(300);
        failIfErrors();
        const backend = await evaluate(`document.getElementById("lic").textContent`);
        const engineEnd = await evaluate(`document.getElementById("sim-engine").textContent`);
        console.log(`ok - atelier page: ${backend}; cloth ${engineEnd}; no console errors`);
    } catch (e) {
        if (process.env.ATELIER_SHOT) {
            const shot = await send("Page.captureScreenshot", { format: "png" }).catch(() => null);
            if (shot) writeFileSync(process.env.ATELIER_SHOT.replace(/(\.png)?$/i, "-failed.png"), Buffer.from(shot.data, "base64"));
        }
        throw e;
    } finally {
        await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
    }
}

async function main() {
    if (!existsSync(join(root, "pkg", "cadaclysm_bg.wasm"))) throw new Error("no pkg/: run `npm run setup` first");
    let server = null, child = null, cdp = null, profile = null;
    let failed = false;
    try {
        const port = await freePort();
        const s = startServer(port);
        server = s.server;
        await s.up;
        profile = mkdtempSync(join(tmpdir(), "atelier-chrome-"));
        const chrome = await launch(findChrome(), profile);
        child = chrome.child;
        cdp = new Cdp(chrome.url);
        await cdp.open();
        await check(cdp, `http://127.0.0.1:${port}`);
    } catch (e) {
        failed = true;
        console.error(`not ok - atelier page: ${e.message}`);
    } finally {
        cdp?.close();
        // stop Chrome and the server, whichever were started
        const waits = [];
        for (const c of [child, server]) {
            if (!c || c.exitCode !== null || c.signalCode !== null) continue;
            waits.push(new Promise((ok) => c.once("exit", ok)));
            c.kill();
        }
        await Promise.race([Promise.all(waits), sleep(5000)]);
        if (profile) try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* left behind */ }
    }
    if (failed) process.exit(1);
}

main().catch((e) => { console.error(`browser: ${e.message}`); process.exit(1); });
