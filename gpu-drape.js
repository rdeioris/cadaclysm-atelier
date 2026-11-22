// The live drape on the View's GPU (WebGPU): the cloth is built on the View worker's own kernel
// (View.showCloth reads a cloth handle of the same wasm instance) and stepped there by
// View.stepCloth, its vertices written straight into the View's vertex buffer. GpuDrapeHost
// speaks the cloth worker's port protocol (cloth-worker.js) in-process, so the View worker
// keeps one code path:
//   in:  avatar, build {text, ops, run}, update {text, ops}, run, pause, reset, pin {vertex},
//        drag {vertex, target}, gia {on} (a live cloth is re-shown with it after a positions read)
//   out: hello, topology (+ gpu: {item}), frame (positions: null), state, pinned
// Edits go through the View (pinCloth, dragCloth, setClothOptions), never straight to the
// kernel cloth: its state is stale between the View's round trips.
import { Drape } from "./cloth.js";
import { healthOf, SEW_FRAMES } from "./drape.js";
import { fabricColours } from "./arrange.js";

// The 3D strip's engine label. GIA (the global intersection analysis: it untangles a cloth caught
// through itself) is off on the GPU unless the GIA button asks for it; the CPU always runs it.
export const ENGINE_TEXT = { gpu: "GPU · GIA off", gpuGia: "GPU · GIA on", cpu: "CPU" };
export const ENGINE_TITLE = {
    gpu: "WebGPU cloth; the global intersection analysis is off (the GIA button turns it on)",
    gpuGia: "WebGPU cloth with the global intersection analysis (self-collision untangling): slower a frame",
    cpu: "the cloth steps on the CPU, in its own worker; the global intersection analysis always runs",
};
// The engine label and the GIA button for an engine ("gpu" / "cpu") and the session's GIA choice:
// on the GPU the button is the choice; on the CPU it reads on and is disabled (always on there).
export function giaState(engine, gia) {
    if (engine !== "gpu") return { text: ENGINE_TEXT.cpu, title: ENGINE_TITLE.cpu, on: true, disabled: true, button: "GIA always runs on the CPU engine" };
    const key = gia ? "gpuGia" : "gpu";
    return {
        text: ENGINE_TEXT[key], title: ENGINE_TITLE[key], on: !!gia, disabled: false,
        button: gia ? "GIA on: the GPU untangles self-intersections (slower); click to turn it off" : "GIA off: click to run the global intersection analysis (self-collision) on the GPU, slower a frame",
    };
}
// Whether this View can step the cloth on the GPU (an older package has no showCloth).
export const gpuClothOk = (viewer) => !!viewer && typeof viewer.showCloth === "function" && !!viewer.clothGpu;

// cloth_status' eight doubles (drape.js STATUS) from a View.clothHealth answer, with the frames
// this host counted (they carry over a re-mesh, which re-shows the cloth) and the mesh's size.
export function statusFromHealth(h, frames, vertices, triangles) {
    return Float64Array.from([frames, vertices, triangles, h.seamPairs ?? 0, h.weldedPairs ?? 0, h.nonFinite, h.dropped, h.maxSpeed]);
}
// Whether a sewing cloth should start draping: every seam pair welded (both counts known, from
// the last round trip), no seams at all, or SEW_FRAMES frames sewn -- drape.js sewingDone's
// rule, except that unknown pair counts (a gone handle) never read as done.
export function sewingOver(h, frames, sewFrames = SEW_FRAMES) {
    if (frames >= sewFrames) return true;
    if (h.seamPairs == null || h.weldedPairs == null) return false;
    return h.seamPairs === 0 || h.weldedPairs >= h.seamPairs;
}
// The cloth's one colour: the first pattern's fabric colour (one View item per cloth).
export function clothColour(nodes) {
    const first = nodes.find((n) => n.id === "garment")?.patterns?.[0];
    const fabric = nodes.find((n) => n.id === first)?.fabric;
    return fabricColours(nodes).get(fabric) ?? "#cccccc";
}

// Each sim vertex's colour, its piece's fabric colour: three numbers in 0..1 a vertex, for
// showCloth's `colours` (a package without it draws the whole cloth in `colour`).
export function vertexColours(nodes, topology) {
    const colours = fabricColours(nodes), fabricOf = new Map(nodes.filter((n) => n.kind === "garment.pattern").map((n) => [n.id, n.fabric]));
    const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const byPattern = topology.patterns.map((id) => rgb(colours.get(fabricOf.get(id)) ?? "#cccccc"));
    const out = new Float32Array(topology.vertexPatterns.length * 3);
    topology.vertexPatterns.forEach((p, k) => out.set(byPattern[p] ?? byPattern[0] ?? [0.8, 0.8, 0.8], k * 3));
    return out;
}

// One task of the event loop, so queued messages (pause, pin, drag, an update) are read
// between frames and the GPU's map callbacks land.
function taskYielder() {
    if (typeof MessageChannel !== "function") return () => new Promise((r) => setTimeout(r, 0));
    const ch = new MessageChannel(), waiting = [];
    ch.port1.onmessage = () => waiting.shift()?.();
    ch.port1.unref?.(); ch.port2.unref?.();      // Node: an idle channel keeps no process alive
    return () => new Promise((r) => { waiting.push(r); ch.port2.postMessage(0); });
}

// A Drape shown on the View: item `id`. Pins, drags and the sewing switch go through the View.
export class GpuDrape extends Drape {
    constructor(k, viewer, avatar = null) {
        super(k, avatar);
        this.viewer = viewer;
        this.id = 0;                 // the View item, or 0 while not shown
        this.gen = 0;                // bumped whenever the item goes or comes: awaits check it
        this.shownGia = null;        // the `gia` the item was shown with (fixed for its life)
    }
    // `gia`: the View runs the intersection analysis for this item; it is set at show time only.
    show(colour, gia = false) {
        if (this.id) this.viewer.remove(this.id);
        this.id = 0; this.gen++;
        this.id = this.viewer.showCloth(this.h, { colour, colours: vertexColours(this.nodes, this.topology()), gia: !!gia });
        this.shownGia = !!gia;
        return this.id;
    }
    // Before showCloth (in build) the kernel cloth is current: Drape's own switch.
    maybeDrape(health = null, frames = 0) {
        if (!this.id) return super.maybeDrape();
        if (this.phase !== "sewing" || !health || !sewingOver(health, frames)) return false;
        const opts = Float64Array.from(this.f("cloth_options")(this.h));
        opts.set(this.gravity, 4);
        this.viewer.setClothOptions(this.id, opts);
        this.phase = "draping";
        return true;
    }
    step() { throw new Error("a GPU cloth steps through GpuDrapeHost"); }
    togglePin(v) {
        if (!this.id) return super.togglePin(v);
        if (this.pins.has(v)) { this.viewer.unpinCloth(this.id, v); this.pins.delete(v); return false; }
        this.viewer.pinCloth(this.id, v, null);
        this.pins.set(v, Array.from(this.f("cloth_vertex_link")(this.h, v)));
        return true;
    }
    drag(v, target) {
        if (!this.id) return super.drag(v, target);
        this.viewer.dragCloth(this.id, v, target ? Array.from(target) : null);
    }
    // The item goes before the handle it borrows.
    freeCloth() {
        if (this.id) { const id = this.id; this.id = 0; this.gen++; this.viewer.remove(id); }
        super.freeCloth();
    }
}

export class GpuDrapeHost {
    // `viewer` the View, `k` the kernel module it was loaded with.
    constructor(viewer, k) {
        this.viewer = viewer;
        this.k = k;
        this.drape = null;
        this.onmessage = null;
        this.running = false;
        this.pending = null;          // the newest garment update not yet applied: {text, ops}
        this.gia = false;             // the session's GIA choice: showCloth's `gia`
        this.reshow = false;          // a GIA change waiting for the shown item: re-show it
        this.applying = null;         // the update under way (a promise)
        this.looping = false;
        this.budget = Infinity;    // frames a film step may still submit
        this.frames = 0;              // frames stepped since the build
        this.counts = [0, 0];         // vertices, triangles
        this.health = null;           // the last clothHealth answer
        this.pinPoints = new Float32Array(0);
        this.colour = "#cccccc";
        this.yieldTask = taskYielder();
        this.inbox = Promise.resolve();
        Promise.resolve().then(() => this.send({ kind: "hello" }));
    }

    send(msg) { this.onmessage?.({ data: msg }); }
    postMessage(msg) {
        // one message at a time, in order, as a port delivers them (a pin awaits a readback)
        this.inbox = this.inbox.then(() => this.onPort(msg));
        return this.inbox;
    }
    // The cloth's sim vertex positions now (xyz, mm): a round trip through the kernel cloth.
    async positions() {
        if (!this.drape?.id) return null;
        return this.viewer.clothPositions(this.drape.id);
    }

    status() {
        if (this.health) return statusFromHealth(this.health, this.frames, ...this.counts);
        const s = this.drape.status();
        s[0] = this.frames;
        return s;
    }
    topology() {
        const d = this.drape;
        const t = d.topology();
        const positions = d.positions();             // the kernel cloth is current here
        const s = d.status();
        this.counts = [s[1], s[2]];
        this.pinPoints = d.pinPositions(positions);
        this.send({ kind: "topology", ...t, positions, pins: this.pinPoints, status: this.status(), phase: d.phase, stale: d.stale, gpu: { item: d.id } });
    }
    frame(health, ms) {
        const d = this.drape;
        this.send({ kind: "frame", positions: null, pins: this.pinPoints, status: this.status(), phase: d.phase, health, ms, running: this.running, stale: d.stale });
    }
    state(extra = {}) { this.send({ kind: "state", running: this.running, live: !!this.drape?.live, stale: this.drape?.stale ?? null, ...extra }); }

    // Latest wins: the cloth's state comes back from the GPU, then the kernel re-meshes what the
    // edit touched; a re-mesh shows the cloth afresh.
    // A GIA change re-shows the cloth the same way (the View takes `gia` at show time only).
    applyPending() {
        // (the body below always awaits before it ends, so `applying` is set before it clears)
        if (!this.applying && !(this.due() && this.drape?.id)) return Promise.resolve();
        return (this.applying ??= (async () => {
            try {
                while (this.due() && this.drape?.id) {
                    const gen = this.drape.gen;
                    await this.viewer.clothPositions(this.drape.id);
                    if (this.drape.gen !== gen) return;          // reset or rebuilt meanwhile
                    let shown = false;
                    if (this.pending) {
                        const { text, ops } = this.pending;
                        this.pending = null;
                        const r = this.drape.update(text, ops);
                        if (r.remeshed) { this.drape.show(this.colour, this.gia); shown = true; }
                        else if (r.kind === "stale") this.state();
                    }
                    this.reshow = false;
                    if (!shown && this.drape.shownGia !== this.gia) { this.drape.show(this.colour, this.gia); shown = true; }
                    if (shown) { this.health = null; this.topology(); }
                }
            } finally { this.applying = null; }
        })());
    }

    // Work waiting for a positions read: a garment update or a GIA change.
    due() { return !!this.pending || this.reshow; }

    // Two frames in flight: step frame N+1, then await frame N's health and report it, so the
    // GPU always has the next frame queued while the CPU reads the last one back.
    async loop() {
        if (this.looping) return;
        this.looping = true;
        let inflight = null;
        this.lastDone = 0;
        try {
            while (this.running && this.drape?.id) {
                try {
                    if (this.due()) {
                        if (inflight) { const f = inflight; inflight = null; await this.finish(f); }
                        await this.applyPending();
                    } else if (this.budget <= 0) {
                        // a film step's frames are all submitted: report the last, then stop
                        if (inflight) { const f = inflight; inflight = null; await this.finish(f); }
                        if (this.budget > 0) continue;         // a new run came in meanwhile
                        if (this.running) { this.running = false; this.state(); }   // a pause meanwhile has said so already
                        break;
                    } else {
                        const f = this.submit();
                        this.budget -= f.n;                    // frames stepped: a held-back submit steps none
                        const prev = inflight;
                        inflight = f;
                        if (prev) await this.finish(prev);
                    }
                } catch (e) { inflight = null; this.running = false; this.state({ error: String(e?.message ?? e) }); }
                await this.yieldTask();
            }
            if (inflight) await this.finish(inflight).catch(() => {});
        } finally { this.looping = false; }
    }
    // One frame submitted, its health asked for (not awaited).
    submit() {
        const d = this.drape, gen = d.gen;
        const n = this.viewer.stepCloth(d.id, 1);
        // a removed item's readback may fail: not an error once the item is gone
        const h = this.viewer.clothHealth(d.id).catch((e) => { if (d.gen === gen) throw e; return null; });
        return { d, gen, n, h };
    }
    // A submitted frame's health: the count, the sewing switch, the report.
    async finish({ d, gen, n, h }) {
        const health0 = await h;
        if (d !== this.drape || d.gen !== gen) return;   // reset or re-shown meanwhile
        this.health = health0;
        this.frames += n;
        d.maybeDrape(health0, this.frames);
        if (!n || !this.running) return;                 // a round trip held the frame back, or paused
        const now = performance.now();
        const ms = this.lastDone ? now - this.lastDone : 0;
        this.lastDone = now;
        const health = healthOf(this.status(), d.phase);
        if (health.stop) this.running = false;
        this.frame(health, ms);
        if (health.stop) this.state({ reason: `paused, the cloth blew up: ${health.text}` });
    }

    async onPort(data) {
        try {
            switch (data.kind) {
                case "avatar": (this.drape ??= new GpuDrape(this.k, this.viewer)).avatar = data.avatar; break;
                case "build": {
                    const d = (this.drape ??= new GpuDrape(this.k, this.viewer));
                    this.pending = null; this.reshow = false;
                    this.running = false;
                    d.build(data.text, data.ops);             // drops the old item and cloth
                    this.colour = clothColour(d.nodes);
                    this.frames = 0; this.health = null;
                    d.show(this.colour, this.gia);
                    this.topology();
                    this.budget = Infinity;
                    this.running = !!data.run;
                    this.state();
                    this.loop();
                    break;
                }
                case "update":
                    if (this.drape?.id) { this.pending = { text: data.text, ops: data.ops }; if (!this.running) await this.applyPending(); }
                    break;
                case "run": this.running = !!this.drape?.id; this.budget = data.frames > 0 ? data.frames : Infinity; this.state(); this.loop(); break;
                case "pause": this.running = false; this.state(); break;
                case "gia":
                    this.gia = !!data.on;
                    if (this.drape?.id && this.drape.shownGia !== this.gia) { this.reshow = true; if (!this.running) await this.applyPending(); }
                    break;
                case "reset": this.running = false; this.pending = null; this.reshow = false; this.drape?.freeCloth(); this.health = null; this.state(); break;
                case "pin": {
                    const d = this.drape;
                    if (!d?.id) break;
                    const gen = d.gen;
                    const on = d.togglePin(data.vertex);
                    // the pin lands on this round trip: where it is pinned is where it is read
                    const positions = await this.viewer.clothPositions(d.id);
                    if (d.gen !== gen) break;
                    this.pinPoints = d.pinPositions(positions);
                    this.frame(null, 0);
                    this.send({ kind: "pinned", vertex: data.vertex, on });
                    break;
                }
                case "drag": if (this.drape?.id) this.drape.drag(data.vertex, data.target); break;
            }
        } catch (e) {
            if (data.kind === "build") this.running = false;
            this.state({ error: String(e?.message ?? e) });
        }
    }
}
