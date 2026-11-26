// The cloth worker: the solver on its own wasm instance, so a step (hundreds of ms until the
// perf pass) never blocks the View, orbiting or the 2D window. It talks only to the View's
// worker, over the MessagePort the page hands it, and steps one frame at a time while running:
// after each frame it posts the positions and the status, then yields so a pause, a pin, a
// drag or a newer garment is read before the next step. Garment updates are latest-wins.
import { load } from "./pkg/index.js";
import { Drape } from "./cloth.js";
import { MAX_STEP_MS } from "./drape.js";
import { MAP_EVERY_MS } from "./fitmap.js";

const ready = (async () => {
    const module = await load();
    try {
        const r = await fetch(new URL("./cadaclysm.lic", import.meta.url));
        if (r.ok) module.license(await r.text());
    } catch { /* no licence beside the page */ }
    return module;
})();

let port = null;
let drape = null;
let running = false;
let pending = null;          // the newest garment update not yet applied: {text, ops}
let looping = false;
let budget = Infinity;        // frames a film step may still take
let map = null, mapAt = -Infinity;   // the fit map ({code, min, max}) and when its colours were last sent
const text = (e) => String(e && e.message ? e.message : e);
const send = (msg, transfer) => port.postMessage(msg, transfer ?? []);

function topology() {
    const t = drape.topology();
    const positions = drape.positions();
    send({ kind: "topology", ...t, positions, pins: drape.pinPositions(positions), status: drape.status(), phase: drape.phase, stale: drape.stale },
        [t.triangles.buffer, t.vertexPatterns.buffer, t.links.buffer, t.starts.buffer, positions.buffer]);
    colours(true);
}
// The fit map's colours and values (fitmap.js), at most every MAP_EVERY_MS unless `now`; null colours: the map is off.
function colours(now = false) {
    if (!drape?.live || (!map && !now)) return;
    const t = performance.now();
    if (!now && t - mapAt < MAP_EVERY_MS) return;
    mapAt = t;
    if (!map) { send({ kind: "colours", colours: null, values: null }); return; }
    const values = drape.f("cloth_strain")(drape.h, map.code), c = drape.f("cloth_strain_colours")(drape.h, map.code, map.min, map.max);
    send({ kind: "colours", colours: c, values }, [c.buffer, values.buffer]);
}
function frame(health, ms) {
    const positions = drape.positions();
    send({ kind: "frame", positions, pins: drape.pinPositions(positions), status: drape.status(), phase: drape.phase, health, ms, running, stale: drape.stale },
        [positions.buffer]);
    colours();
}
function state(extra = {}) { send({ kind: "state", running, live: !!drape?.live, stale: drape?.stale ?? null, ...extra }); }

function applyPending() {
    if (!pending || !drape?.live) return;
    const { text: t, ops } = pending;
    pending = null;
    const r = drape.update(t, ops);
    if (r.remeshed) topology();
    else if (r.kind === "stale") state();
}

function loop() {
    looping = false;
    if (!running || !drape?.live) return;
    try {
        applyPending();
        const t0 = performance.now();
        const health = drape.step();
        const ms = performance.now() - t0;
        const slow = ms > MAX_STEP_MS;
        if (health.stop || slow) running = false;
        frame(health, ms);
        if (running && --budget <= 0) { running = false; state(); }
        if (health.stop) state({ reason: `paused, the cloth blew up: ${health.text}` });
        else if (slow) state({ reason: `paused: one step took ${(ms / 1000).toFixed(1)} s (a tangled cloth); Reset and arrange the pieces nearer the avatar` });
    } catch (e) {
        running = false;
        state({ error: text(e) });
    }
    schedule();
}
function schedule() { if (running && !looping) { looping = true; setTimeout(loop, 0); } }

async function onPort({ data }) {
    try {
        const kernel = await ready;
        switch (data.kind) {
            case "avatar": (drape ??= new Drape(kernel)).avatar = data.avatar; break;
            case "build": {
                drape ??= new Drape(kernel);
                pending = null;
                budget = Infinity;
                drape.build(data.text, data.ops);
                topology();
                running = !!data.run;
                state();
                schedule();
                break;
            }
            case "update": if (drape?.live) { pending = { text: data.text, ops: data.ops }; if (!running) applyPending(); } break;
            case "run": running = !!drape?.live; budget = data.frames > 0 ? data.frames : Infinity; state(); schedule(); break;
            case "pause": running = false; state(); break;
            case "reset": running = false; pending = null; drape?.freeCloth(); state(); break;
            case "pin": {
                if (!drape?.live) break;
                const on = drape.togglePin(data.vertex);
                frame(null, 0);
                send({ kind: "pinned", vertex: data.vertex, on });
                break;
            }
            case "drag": if (drape?.live) drape.drag(data.vertex, data.target); break;
            case "map": map = data.map; colours(true); break;
        }
    } catch (e) {
        if (data.kind === "build") running = false;
        state({ error: text(e) });
    }
}

self.onmessage = ({ data }) => {
    if (data.kind === "port") { port = data.port; port.onmessage = onPort; ready.then(() => send({ kind: "hello" })).catch((e) => send({ kind: "state", running: false, live: false, error: text(e) })); }
};
