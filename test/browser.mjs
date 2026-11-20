// The page end to end in headless Chrome or Edge, over the DevTools protocol (Node's own
// WebSocket: no dependency). It serves the repo with scripts/serve.mjs, opens the page, waits
// for the worker's `ready`, then with real pointer and key events: draws a rectangle, drags a
// corner, maximises, arranges, edits the properties (typing + Tab keeps the focus), adds a
// library fabric, draws a second rectangle and sews the two with "Sew sides", picks the seam in
// 2D, deletes it and a piece (each undone), moves a piece with the Move tool, types an
// allowance and saves with Ctrl+S (the download is read back), New and Open, refuses an STL
// avatar, loads the T-shirt sample, exports it as DXF (4 BLOCKs) and imports that back. Then
// the live drape on the sample: Simulate, frames arrive, a pin, a drag on the cloth, a 2D move
// of a piece while it runs (re-meshed), Pause, Reset. Each step prints ok. Any console error or
// uncaught exception, in the page or its workers, fails.
//
//     node test/browser.mjs                              # npm run test:browser
//     ATELIER_SHOT=out.png node test/browser.mjs         # also a screenshot of the drape
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

            // 2. a rectangle: the tool's button, then a drag on the 2D window
            await evaluate(`document.querySelector('#tools2d [data-tool=rectangle]').click()`);
            const [x, y, w, h] = await evaluate(`(() => { const r = document.getElementById("view2d").getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()`);
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
            if (process.env.ATELIER_SHOT_SAMPLE) {
                await frames(); // the View's first frames of the sample: a picture, not an assertion
                const { data } = await send("Page.captureScreenshot", { format: "png" });
                writeFileSync(process.env.ATELIER_SHOT_SAMPLE, Buffer.from(data, "base64"));
                ok(`screenshot ${process.env.ATELIER_SHOT_SAMPLE}`);
            }

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
            const [cx, cy, cw, ch] = await evaluate(`(() => { const r = document.getElementById("view3d").getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()`);
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
            const [x2, y2, w2, h2] = await evaluate(`(() => { const r = document.getElementById("view2d").getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()`);
            const gen = () => evaluate(`Number(document.body.dataset.meshGen)`);
            const g0 = await gen();
            const size = () => evaluate(`/size [^<]*/.exec(document.getElementById("props").textContent)?.[0]`);
            const s0 = await size();
            await drag([x2 + w2 * 0.3, y2 + h2 * 0.5], [x2 + w2 * 0.3 + 30, y2 + h2 * 0.5], 6);
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
