// The page end to end in headless Chrome or Edge, over the DevTools protocol (Node's own
// WebSocket: no dependency). It serves the repo with scripts/serve.mjs, opens the page, waits
// for the worker's `ready`, then with real pointer and key events: draws a rectangle, drags a
// corner, maximises, arranges, edits the properties (typing + Tab keeps the focus), adds a
// library fabric, draws a second rectangle and sews the two with "Sew sides", picks the seam in
// 2D, deletes it and a piece (each undone), moves a piece with the Move tool, types an
// allowance and saves with Ctrl+S (the download is read back), New and Open, refuses an STL
// avatar, loads the T-shirt sample, exports it as DXF (4 BLOCKs) and imports that back. Then
// the live drape on the sample: Simulate, frames arrive, a pin, a drag on the cloth, a 2D move
// of a piece while it runs (re-meshed), Pause, Reset. Then the 2D tools on a new garment, ending
// with holes: a rectangle and an ellipse hole by dialog, one over the edge refused, and an
// internal square by dialog converted to a hole. Each step
// prints ok. Any console error or uncaught exception, in the page or its workers, fails.
//
//     node test/browser.mjs                              # npm run test:browser
//     ATELIER_SHOT=out.png node test/browser.mjs         # also a screenshot of the drape
//     ATELIER_SHOT_HOLES=holes.png ...                   # also one of the holed piece in 2D
//     ATELIER_DRAPE_FRAMES=150 ...                       # run the drape that long first (default 4)
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
    const drag = async (a, b, steps = 8) => {
        await mouse("mouseMoved", a[0], a[1], { buttons: 0 });
        await mouse("mousePressed", a[0], a[1]);
        for (let i = 1; i <= steps; i++) await mouse("mouseMoved", a[0] + ((b[0] - a[0]) * i) / steps, a[1] + ((b[1] - a[1]) * i) / steps);
        await mouse("mouseReleased", b[0], b[1]);
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
    const setField = (key, value) => evaluate(`(() => { const e = ${field(key)}; e.value = ${JSON.stringify(String(value))}; e.dispatchEvent(new Event("change", { bubbles: true })); })()`);
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
            // 1. ready: the new document has one fabric, no patterns, and the avatar
            await send("Page.navigate", { url: `${base}/` });
            await until("the worker's ready", () => evaluate(`document.body?.dataset.ready === "1"`), 90000);
            await until("the default fabric", async () => (await count("fabrics", "fabric")) === 1, 30000);
            await until("the avatar", async () => (await count("avatar", "avatar")) === 1, 60000);
            const robots = await evaluate(`document.querySelector('meta[name=robots]')?.content`);
            if (robots !== "noindex") throw new Error(`robots meta is ${robots}`);
            const fps = await evaluate(`document.getElementById("fps").textContent`);
            if (fps !== "—") throw new Error(`#fps shows ${fps}`);
            const sim = await evaluate(`(() => { const b = document.querySelector('#tools3d [data-command=simulate]'); return b && !b.disabled && document.getElementById("sim-reset").disabled; })()`);
            if (!sim) throw new Error("Simulate should be on and Reset off");
            failIfErrors();
            ok("ready: one fabric, the f-M avatar, Simulate on");

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
            await mouse("mouseMoved", b[0], b[1], { buttons: 0 });
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
            ok("F2/F3, arrange");

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

            // an STL avatar is refused with a message until the kernel reads STL
            const stlFile = join(downloads, "tetra.stl");
            writeFileSync(stlFile, "solid t\nendsolid t\n");
            await pickInto("menu-avatar", stlFile, ".stp");
            await until("the STL message", () => evaluate(`/STL avatars need/.test(document.getElementById("status-text").textContent)`), 30000);
            if ((await evaluate(`document.querySelector('#browser-avatar li[data-kind=avatar]')?.textContent`)) !== "f-M") throw new Error("the avatar changed");
            failIfErrors();
            ok("STL avatar refused, f-M kept");

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
                await evaluate(`document.body.dataset.hit = "__"`);
                await mouse("mouseMoved", sx + sw * fx, sy + sh * fy, { buttons: 0 });
                await until("a hover answered", async () => (await evaluate(`document.body.dataset.hit`)) !== "__", 10000);
                await sleep(200);
                hovered = await hover2d();
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

            // drag: the Drag tool, a press on the cloth moved 80 px right; the frames go on
            await evaluate(`document.querySelector('[data-tool3d=drag]').click()`);
            if (await evaluate(`document.querySelector('[data-tool3d=pin]').classList.contains("on")`)) throw new Error("Pin and Drag both on");
            const f0 = await frameNo();
            await tryOnCloth("drag", (p) => drag(p, [p[0] + 80, p[1]], 6), (t) => t === "dragging the cloth");
            await until("frames after the drag", async () => (await frameNo()) >= f0 + 2, 60000);
            await evaluate(`document.querySelector('[data-tool3d=drag]').click()`);
            failIfErrors();
            ok("dragged the cloth");

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
                await evaluate(`document.body.dataset.hit = "__"`);
                await mouse("mouseMoved", at[0], at[1], { buttons: 0 });
                await until("a hover answered", async () => (await evaluate(`document.body.dataset.hit`)) !== "__", 10000);
                if ((await evaluate(`document.body.dataset.hit`)) === "pattern" && (await evaluate(`document.body.dataset.hover2d ?? ""`)) === firstId) { on = at; break; }
            }
            if (!on) throw new Error(`no spot on ${firstId} found in the 2D window`);
            await drag(on, [on[0] + 30, on[1]], 6);
            const f1 = await frameNo();
            await until("frames after the move", async () => (await frameNo()) >= f1 + 2, 60000);
            if ((await gen()) !== g0) throw new Error("a 2D move re-meshed the cloth");
            if ((await size()) !== s0) throw new Error(`the move changed the piece: ${s0} -> ${await size()}`);
            await evaluate(`document.querySelector('#tools2d [data-tool=edit]').click()`);
            await setField("grain", "0.2, 1");
            await until("the cloth re-meshed", async () => (await gen()) > g0, 60000);
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
            if (process.env.ATELIER_SHOT) {
                await frames();
                const shot = await send("Page.captureScreenshot", { format: "png" });
                writeFileSync(process.env.ATELIER_SHOT, Buffer.from(shot.data, "base64"));
                ok(`screenshot ${process.env.ATELIER_SHOT}`);
            }
            ok(`the sample drapes: ${await health()}`);
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
            const hoverAt = async (p) => {
                await evaluate(`document.body.dataset.hit = "__"`);
                await mouse("mouseMoved", p[0], p[1], { buttons: 0 });
                await until("a hover answered", async () => (await evaluate(`document.body.dataset.hit`)) !== "__", 10000);
                return { world: (await evaluate(`document.body.dataset.world ?? ""`)).split(",").map(Number), snap: await evaluate(`document.body.dataset.snap ?? ""`) };
            };
            const gp0 = [rx0 + rw0 * 0.75, ry0 + rh0 * 0.15];
            const gw0 = await hoverAt(gp0), gwx = await hoverAt([gp0[0] + 40, gp0[1]]), gwy = await hoverAt([gp0[0], gp0[1] + 40]);
            if (gw0.snap || gwx.snap || gwy.snap) throw new Error(`a snap away from geometry with Grid off: ${gw0.snap}/${gwx.snap}/${gwy.snap}`);
            const kx = (gwx.world[0] - gw0.world[0]) / 40, ky = (gwy.world[1] - gw0.world[1]) / 40;      // world mm a CSS px, each axis
            const STEP = 100;                                                                          // the worker's grid step
            const cross = [Math.round(gw0.world[0] / STEP) * STEP, Math.round(gw0.world[1] / STEP) * STEP];
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
                await evaluate(`document.body.dataset.hit = "__"`);
                await mouse("mouseMoved", at[0], at[1], { buttons: 0 });
                await until("a hover answered", async () => (await evaluate(`document.body.dataset.hit`)) !== "__", 10000);
                if ((await evaluate(`document.body.dataset.hit`)) === "pattern") { onPiece = at; break; }
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
            await sleep(500);
            if ((await patternCount()) !== rectsBefore + 1) throw new Error("Cancel placed a piece");
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
            // pattern mm per CSS px from two hovers 50 px apart (the 2D window's own mapping); each waits for a fresh answer
            let lastSeen = await evaluate(`document.body.dataset.world ?? ""`);
            const worldOf = async (p) => {
                await mouse("mouseMoved", p[0], p[1], { buttons: 0 });
                await until("the hover answer", async () => { const w = await evaluate(`document.body.dataset.world ?? ""`); return w !== "" && w !== lastSeen; }, 10000);
                lastSeen = await evaluate(`document.body.dataset.world`);
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
                await evaluate(`document.body.dataset.hit = "__"`);
                await mouse("mouseMoved", edge[0], edge[1], { buttons: 0 });
                await until("the hover answer", async () => (await evaluate(`document.body.dataset.hit`)) !== "__", 30000);
                { const hit = await evaluate(`document.body.dataset.hit + " at " + document.body.dataset.world`); if (!hit.startsWith("internal ")) throw new Error(`the internal edge's hover answered ${hit}`); }
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
                };                await evaluate(`[...document.querySelectorAll('#browser-patterns li[data-kind=pattern]')].at(-1).click()`);
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
                // select the left half (Edit, a click on its fill), then Cut & Sew across its middle
                await evaluate(`document.querySelector('#tools2d [data-tool=edit]').click()`);
                await click(screenOf([c0[0] + 25, c0[1] + 25]));
                await until("the left half selected", async () => /size\s*50\s*×\s*50/.test(await evaluate(`document.getElementById("props").textContent`)), 30000);
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
            }
            if (process.env.ATELIER_SHOT_HOLES) {     // fitted: the camera moves, so this comes last (pxPerMm is stale after it)
                await evaluate(`document.querySelector('#tools2d [data-command=fit]').click()`);
                await sleep(1000);
                const { data } = await send("Page.captureScreenshot", { format: "png" });
                writeFileSync(process.env.ATELIER_SHOT_HOLES, Buffer.from(data, "base64"));
                ok(`screenshot ${process.env.ATELIER_SHOT_HOLES}`);
            }
        } finally { try { rmSync(downloads, { recursive: true, force: true }); } catch { /* left behind */ } }
        // 9. no console error anywhere, page or worker
        await sleep(300);
        failIfErrors();
        const backend = await evaluate(`document.getElementById("lic").textContent`);
        console.log(`ok - atelier page: ${backend}; no console errors`);
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
