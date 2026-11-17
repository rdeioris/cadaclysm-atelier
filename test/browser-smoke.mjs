// The page's smoke check in headless Chrome or Edge, over the DevTools protocol (Node's own
// WebSocket: no dependency). It serves the repo with scripts/serve.mjs, opens the page, waits
// for the worker's `ready`, draws a rectangle in the 2D window with the rectangle tool (real
// pointer events), checks the browser lists one pattern, selects it there, toggles F3 and F2, drags a corner and
// arranges the piece. Any console error or uncaught exception, in the page or its worker, fails.
//
//     node test/browser-smoke.mjs
//     ATELIER_SHOT=out.png node test/browser-smoke.mjs     # also a screenshot
//     node test/browser-smoke.mjs --chrome <path>          # (or the CHROME variable)
//     node test/browser-smoke.mjs --headed                 # watch it
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
    const child = spawn(chrome, flags, { stdio: "ignore" });
    const portFile = join(profile, "DevToolsActivePort");
    const text = await until("Chrome's DevTools port", () => existsSync(portFile) && readFileSync(portFile, "utf8").includes("\n") && readFileSync(portFile, "utf8"), 30000);
    const [port, path] = text.trim().split("\n");
    return { child, url: `ws://127.0.0.1:${port}${path}` };
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
    const mouse = (type, x, y, extra = {}) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, ...extra });
    const key = async (k, code, vk, modifiers = 0) => {
        await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers });
    };
    const frames = () => evaluate("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
    try {
        await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
        await send("Runtime.enable");
        await send("Log.enable");
        await send("Page.enable");
        await send("Page.bringToFront");
        await send("Emulation.setFocusEmulationEnabled", { enabled: true });
        await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
        await send("Page.navigate", { url: `${base}/` });
        await until("the worker's ready", () => evaluate(`document.body?.dataset.ready === "1"`), 90000);
        // the new document: one fabric, no patterns
        await until("the default fabric", () => evaluate(`document.querySelectorAll("#browser-fabrics li[data-kind=fabric]").length === 1`), 30000);
        await until("the avatar", () => evaluate(`document.querySelectorAll("#browser-avatar li[data-kind=avatar]").length === 1`), 60000);
        const robots = await evaluate(`document.querySelector('meta[name=robots]')?.content`);
        if (robots !== "noindex") throw new Error(`robots meta is ${robots}`);
        const fps = await evaluate(`document.getElementById("fps").textContent`);
        if (fps !== "—") throw new Error(`#fps shows ${fps}`);
        const sim = await evaluate(`(() => { const b = document.querySelector('#tools3d [data-command=simulate]'); return b && b.disabled && b.title; })()`);
        if (sim !== "arrives with the solver") throw new Error(`the Simulate button: ${sim}`);
        failIfErrors();

        // a rectangle: the tool's button, then a drag on the 2D window
        await evaluate(`document.querySelector('#tools2d [data-tool=rectangle]').click()`);
        const [x, y, w, h] = await evaluate(`(() => { const r = document.getElementById("view2d").getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()`);
        const a = [x + w * 0.3, y + h * 0.3], b = [x + w * 0.6, y + h * 0.7];
        await mouse("mouseMoved", a[0], a[1], { buttons: 0 });
        await mouse("mousePressed", a[0], a[1]);
        for (let i = 1; i <= 8; i++) await mouse("mouseMoved", a[0] + ((b[0] - a[0]) * i) / 8, a[1] + ((b[1] - a[1]) * i) / 8);
        await mouse("mouseReleased", b[0], b[1]);
        await until("one pattern in the browser", () => evaluate(`document.querySelectorAll("#browser-patterns li[data-kind=pattern]").length === 1`), 30000);
        const back = await evaluate(`document.querySelector('#tools2d [data-tool].on')?.dataset.tool`);
        if (back !== "edit") throw new Error(`after the rectangle the tool is ${back}, not edit`);

        // select it from the browser: marked there and in the property panel
        await evaluate(`document.querySelector('#browser-patterns li[data-kind=pattern]').click()`);
        const marked = await evaluate(`document.querySelector('#browser-patterns li[data-kind=pattern]').classList.contains("on")`);
        if (!marked) throw new Error("the browser item is not marked selected");
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

        // F3 maximises 3D and restores
        await key("F3", "F3", 114);
        await frames();
        if (!(await evaluate(`document.getElementById("split").classList.contains("max3d")`))) throw new Error("F3 did not maximise 3D");
        await sleep(300);
        await key("F3", "F3", 114);
        await frames();
        if (await evaluate(`document.getElementById("split").className`)) throw new Error("F3 again did not restore");
        await key("F2", "F2", 113);
        await frames();
        if (!(await evaluate(`document.getElementById("split").classList.contains("max2d")`))) throw new Error("F2 did not maximise 2D");
        await sleep(300);
        await key("F2", "F2", 113);
        await frames();
        if (await evaluate(`document.getElementById("split").className`)) throw new Error("F2 again did not restore");

        // arrange: the piece goes to a slot around the avatar
        await evaluate(`document.querySelector('#tools3d [data-command=arrange]').click()`);
        const field = (key) => `document.querySelector('#props [data-key="${key}"]')`;
        const setField = (key, value) => evaluate(`(() => { const e = ${field(key)}; e.value = ${JSON.stringify(String(value))}; e.dispatchEvent(new Event("change", { bubbles: true })); })()`);
        await until("the piece arranged", () => evaluate(`${field("slot")}?.value === "front"`), 30000);
        await sleep(800);
        const se = await statusError();
        if (se) throw new Error(`the status line says: ${se}`);
        failIfErrors();

        // the property editor: a label, a duplicate refused, the slot, a fabric's weight
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
        await evaluate(`document.querySelector('#browser-patterns li[data-kind=pattern]').click()`);
        failIfErrors();

        // the fabric library: add a preset, it is listed
        await evaluate(`(() => { document.getElementById("lib-select").value = "denim"; document.getElementById("lib-add").click(); })()`);
        await until("the denim fabric", () => evaluate(`document.querySelectorAll("#browser-fabrics li[data-kind=fabric]").length === 2`), 30000);

        // save: the download lands in a folder; New empties the page; Open brings the label back
        const downloads = mkdtempSync(join(tmpdir(), "atelier-dl-"));
        await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads, eventsEnabled: false });
        const waitFile = (name) => until(`${name} downloaded`, () => { const f = join(downloads, name); return existsSync(f) && readFileSync(f, "utf8"); }, 30000);
        const pickInto = async (button, file, accept) => {
            await evaluate(`document.getElementById("${button}").click()`);
            const got = await evaluate(`document.getElementById("file-in").accept`);
            if (!got.includes(accept)) throw new Error(`${button}: the file input accepts ${got}`);
            const { result } = await send("Runtime.evaluate", { expression: `document.getElementById("file-in")` });
            await send("DOM.setFileInputFiles", { files: [file], objectId: result.objectId });
        };
        const patternCount = () => evaluate(`document.querySelectorAll("#browser-patterns li[data-kind=pattern]").length`);
        try {
            await key("s", "KeyS", 83, 2);
            const json = await waitFile("garment.json");
            if (!json.includes("Bodice")) throw new Error("the saved garment.json has no Bodice");
            await evaluate(`document.getElementById("menu-export-dxf").click()`);
            const dxf = await waitFile("garment.dxf");
            await evaluate(`document.getElementById("menu-new").click()`);
            await until("an empty document", async () => (await patternCount()) === 0, 30000);
            await pickInto("menu-open", join(downloads, "garment.json"), ".json");
            await until("the opened garment", () => evaluate(`document.querySelector('#browser-patterns li[data-kind=pattern]')?.textContent === "Bodice"`), 30000);
            if (!(await evaluate(`document.querySelectorAll("#browser-fabrics li[data-kind=fabric]").length === 2`))) throw new Error("the opened garment lost a fabric");
            await evaluate(`document.getElementById("menu-new").click()`);
            await until("an empty document again", async () => (await patternCount()) === 0, 30000);
            await pickInto("menu-import-dxf", join(downloads, "garment.dxf"), ".dxf");
            await until("the imported piece", async () => (await patternCount()) === 1, 30000);
            if (!dxf.length) throw new Error("the DXF is empty");
        } finally { try { rmSync(downloads, { recursive: true, force: true }); } catch { /* left behind */ } }
        await evaluate(`document.querySelector('#browser-patterns li[data-kind=pattern]').click()`);
        const se2 = await statusError();
        if (se2) throw new Error(`the status line says: ${se2}`);
        failIfErrors();

        // an STL avatar is refused with a message until the kernel reads STL
        const stlDir = mkdtempSync(join(tmpdir(), "atelier-stl-"));
        try {
            const stlFile = join(stlDir, "tetra.stl");
            writeFileSync(stlFile, "solid t\nendsolid t\n");
            await pickInto("menu-avatar", stlFile, ".stp");
            await until("the STL message", () => evaluate(`/STL avatars need/.test(document.getElementById("status-text").textContent)`), 30000);
            if ((await evaluate(`document.querySelector('#browser-avatar li[data-kind=avatar]')?.textContent`)) !== "f-M") throw new Error("the avatar changed");
        } finally { try { rmSync(stlDir, { recursive: true, force: true }); } catch { /* left behind */ } }
        failIfErrors();

        const shotPath = process.env.ATELIER_SHOT;
        if (shotPath) {
            await frames();
            await sleep(800);
            const shot = await send("Page.captureScreenshot", { format: "png" });
            writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
        }
        await sleep(300);
        failIfErrors();
        const backend = await evaluate(`document.getElementById("lic").textContent`);
        console.log(`ok - atelier page: ${backend}; rectangle drawn, listed, selected, arranged, edited, saved, reopened, DXF round trip, STL refused${shotPath ? `; screenshot ${shotPath}` : ""}`);
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
    const port = await freePort();
    const server = spawn(process.execPath, [join(root, "scripts", "serve.mjs"), String(port)], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise((ok) => server.stdout.once("data", ok));
    const profile = mkdtempSync(join(tmpdir(), "atelier-chrome-"));
    const { child, url } = await launch(findChrome(), profile);
    const cdp = new Cdp(url);
    let failed = false;
    try {
        await cdp.open();
        await check(cdp, `http://127.0.0.1:${port}`);
    } catch (e) {
        failed = true;
        console.error(`not ok - atelier page: ${e.message}`);
    } finally {
        cdp.close();
        const exited = new Promise((ok) => child.once("exit", ok));
        child.kill();
        server.kill();
        await Promise.race([exited, sleep(5000)]);
        try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* left behind */ }
    }
    if (failed) process.exit(1);
}

main().catch((e) => { console.error(`browser-smoke: ${e.message}`); process.exit(1); });
