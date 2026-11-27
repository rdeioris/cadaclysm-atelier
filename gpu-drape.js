// The live drape on the View's GPU (WebGPU): the cloth is built on the View worker's own kernel
// (View.showCloth reads a cloth handle of the same wasm instance) and stepped there by
// View.stepCloth, its vertices written straight into the View's vertex buffer. GpuDrapeHost
// speaks the cloth worker's port protocol (cloth-worker.js) in-process, so the View worker
// keeps one code path:
//   in:  avatar, build {text, ops, run}, update {text, ops}, run, pause, reset, pin {vertex},
//        drag {vertex, target}, gia {on} (a live cloth is re-shown with it after a positions read)
//        map {map: {key, code, min, max} | null} (the fit map: View.setClothMap, fitmap.js)
//        material (the fabrics or prints changed: View.setClothMaterial with `lookFor`'s look)
//   out: hello, topology (+ gpu: {item}), frame (positions: null), state, pinned (+ place: the
//        pin's piece and pattern point, which the View's worker saves in the piece's `pins`)
// Edits go through the View (pinCloth, dragCloth, setClothOptions), never straight to the
// kernel cloth: its state is stale between the View's round trips.
import { Drape } from "./cloth.js";
import { healthOf, SEW_FRAMES } from "./drape.js";
import { fabricColours } from "./arrange.js";
import { lookOptions, lookMaterial } from "./looks.js";

// The 3D strip's engine label. GIA (the global intersection analysis: it untangles a cloth caught
// through itself) is on by default on the GPU (as the View's showCloth) and the GIA button can
// turn it off; the CPU always runs it.
export const ENGINE_TEXT = { gpu: "GPU · GIA off", gpuGia: "GPU · GIA on", cpu: "CPU" };
export const ENGINE_TITLE = {
    gpu: "WebGPU cloth; the global intersection analysis is off (the GIA button turns it back on)",
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

// A stalled sewing: some seam pairs open and no new weld for STALL_FRAMES frames. The kernel's
// stall ramp caps a pair's pull at goal 0 under the soft sewing compliance, and a three-piece
// point (the front neck centre: front, hood left, hood right) can hold its last pair a few mm
// past the weld distance once the other two pieces have welded first (the stepped film's
// weld order), against a stiff constraint (ten times the sewing stiffness closes 0.3 mm of it).
// Such a cloth gets STALL_WELD times the weld distance, once, until the drape.
export const STALL_FRAMES = 5, STALL_WELD = 2;
// The frames between two read backs of trims drawn by the CPU on a GPU cloth (showClothTrims refused).
export const TRIM_EVERY = 10;

// A Drape shown on the View: item `id`. Pins, drags and the sewing switch go through the View.
export class GpuDrape extends Drape {
    constructor(k, viewer, avatar = null) {
        super(k, avatar);
        this.viewer = viewer;
        this.id = 0;                 // the View item, or 0 while not shown
        this.gen = 0;                // bumped whenever the item goes or comes: awaits check it
        this.shownGia = null;        // the `gia` the item was shown with (fixed for its life)
        this.lookFor = null;         // (topology) -> the materials' look (looks.js), or null: drawn plain
        this.unstall();
    }
    unstall() { this.lastWelded = -1; this.weldedAt = 0; this.weldDistance = null; }
    // `gia`: the View runs the intersection analysis for this item; it is set at show time only.
    show(colour, gia = false) {
        if (this.id) this.viewer.remove(this.id);
        this.id = 0; this.gen++;
        // thickness: the View draws each fabric's thickness (two faces and a rim along open edges);
        // the materials' UVs and material per sim vertex (the View copies them to the thick copies)
        const t = this.topology();
        this.id = this.viewer.showCloth(this.h, { colour, colours: vertexColours(this.nodes, t), gia: !!gia, thickness: true, ...lookOptions(this.lookFor?.(t) ?? null) });
        this.shownGia = !!gia;
        if (this.map) this.viewer.setClothMap(this.id, this.map);     // the fit map, kept across a re-show
        this.unstall();
        this.showTrims();
        return this.id;
    }
    // The trims (S3 §7), set on the kernel cloth before showCloth (Drape.setTrims, or the re-mesh's
    // cloth_remesh_pattern_trims): drawn by the GPU's attach pass as the cloth's own item, colour
    // and metal by template. The View refuses where it has no compute or no vertex target: the
    // trims are then drawn by the CPU from cloth_trim_vertices (the host reads them back now and
    // then). The arrays given are those set_trims took; after a re-mesh the cloth's own (null).
    showTrims() {
        this.trimsGpu = false; this.trimsCpu = false;
        if (!this.trims || !this.id) return;
        const own = this.trims.own;
        try {
            this.viewer.showClothTrims(this.id, own ? this.trims.templates : null, own ? this.trims.placements : null,
                { colours: this.trims.colours, metallic: this.trims.metallic });
            this.trimsGpu = true;
        } catch (e) {
            this.trimsCpu = true;
            this.trimNotes = [...this.trimNotes, `trims drawn by the CPU: ${e?.message ?? e}`];
        }
    }
    // Before showCloth (in build) the kernel cloth is current: Drape's own switch.
    maybeDrape(health = null, frames = 0) {
        if (!this.id) return super.maybeDrape();
        if (this.phase !== "sewing" || !health || !sewingOver(health, frames)) return false;
        this.phase = "draping";
        this.pushOptions();
        return true;
    }
    // A stalled sewing gets STALL_WELD times the weld distance (option 14), once; the drape puts
    // it back. -> true when it widened it.
    nudgeStall(h, frames) {
        if (!this.id || this.phase !== "sewing" || this.weldDistance != null || h?.seamPairs == null || h.weldedPairs == null) return false;
        if (h.weldedPairs !== this.lastWelded) { this.lastWelded = h.weldedPairs; this.weldedAt = frames; return false; }
        if (h.weldedPairs >= h.seamPairs || frames - this.weldedAt < STALL_FRAMES) return false;
        this.weldDistance = this.user[14];
        this.pushOptions();
        return true;
    }
    // The garment's options, gravity off and the weld distance widened while a stalled sewing
    // needs it (the user's own weld distance, set live meanwhile, widened the same).
    effective() {
        const o = super.effective();
        if (this.weldDistance != null && this.phase === "sewing") o[14] *= STALL_WELD;
        return o;
    }
    // Live edits go through the View, which applies them on its next round trip -- except while
    // the cloth is not shown, or is being re-meshed to be shown afresh (Drape.update's `direct`).
    pushOptions() {
        if (!this.id || this.direct) return super.pushOptions();
        this.viewer.setClothOptions(this.id, this.effective());
    }
    freeze(p, on) {
        if (!this.id || this.direct) return super.freeze(p, on);
        this.viewer.freezeCloth(this.id, p, on);
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
        this.gia = true;              // the session's GIA choice: showCloth's `gia` (on by default)
        this.reshow = false;          // a GIA change waiting for the shown item: re-show it
        this.applying = null;         // the update under way (a promise)
        this.looping = false;
        this.budget = Infinity;    // frames a film step may still submit
        this.frames = 0;              // frames stepped since the build
        this.counts = [0, 0];         // vertices, triangles
        this.health = null;           // the last clothHealth answer
        this.pinPoints = new Float32Array(0);
        this.colour = "#cccccc";
        this.map = null;              // the fit map (setClothMap's { map, min, max }), or null
        this.lookFor = null;          // (topology) -> the materials' look (looks.js): the View worker sets it
        this.yieldTask = taskYielder();
        this.inbox = Promise.resolve();
        Promise.resolve().then(() => this.send({ kind: "hello" }));
    }

    send(msg) { this.onmessage?.({ data: msg }); }
    // The drape, made on first use; its shows ask this host's `lookFor`.
    newDrape() {
        if (!this.drape) { this.drape = new GpuDrape(this.k, this.viewer); this.drape.lookFor = (t) => this.lookFor?.(t) ?? null; }
        return this.drape;
    }
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
    // The fit map `code` (cloth_strain's) per sim vertex, from the positions read now. -> { positions, values } or null
    async strain(code) {
        const p = await this.positions();
        if (!p || !this.drape?.h) return null;
        const positions = Float64Array.from(p);
        return { positions, values: this.k.cadaclysm_blacksmith_cloth_strain(this.drape.h, code, positions) };
    }

    // The trims on the cloth now (S3): {item: the GPU's trims item (clothTrimsItem: it changes on a
    // re-show) or 0, vertices: cloth_trim_vertices after a positions read (what the attach pass
    // writes, bit for bit)}; null without trims.
    async trimProbe() {
        const d = this.drape;
        if (!d?.id || !d.trims) return null;
        await this.viewer.clothPositions(d.id);
        if (!d.id) return null;
        return { item: d.trimsGpu ? this.viewer.clothTrimsItem(d.id) ?? 0 : 0, vertices: d.trimVertices() };
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
        // the trims: the GPU's own item, or (refused) a mesh the View's worker draws from the vertices sent
        const trims = d.trimsCpu ? d.trimMesh() : null;
        this.send({ kind: "topology", ...t, positions, pins: this.pinPoints, status: this.status(), phase: d.phase, stale: d.stale, gpu: { item: d.id, trims: !!d.trimsGpu },
            trims, trimVertices: trims ? d.trimVertices() : null, trimNotes: d.trimNotes });
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
        // trims the GPU could not draw: the CPU's, from a read back every TRIM_EVERY frames
        if (d.trimsCpu && n && this.frames % TRIM_EVERY === 0) {
            this.viewer.clothPositions(d.id).then(() => { if (d === this.drape && d.gen === gen) this.send({ kind: "trims", vertices: d.trimVertices() }); }).catch(() => {});
        }
        d.maybeDrape(health0, this.frames);
        d.nudgeStall(health0, this.frames);
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
                case "avatar": this.newDrape().avatar = data.avatar; break;
                case "build": {
                    const d = this.newDrape();
                    this.pending = null; this.reshow = false;
                    this.running = false;
                    d.build(data.text, data.ops);             // drops the old item and cloth
                    this.colour = clothColour(d.nodes);
                    this.frames = 0; this.health = null;
                    d.map = this.map;
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
                // the fit map: drawn by the View on the GPU, once per change
                case "map":
                    this.map = data.map ? { map: data.map.key, min: data.map.min, max: data.map.max } : null;
                    if (this.drape) { this.drape.map = this.map; if (this.drape.id) this.viewer.setClothMap(this.drape.id, this.map); }
                    break;
                // the materials changed (not the mesh): the shown cloth takes them, no re-show
                case "material":
                    if (this.drape?.id) this.viewer.setClothMaterial(this.drape.id, lookMaterial(this.lookFor?.(this.drape.topology()) ?? null));
                    break;
                case "reset": this.running = false; this.pending = null; this.reshow = false; this.drape?.freeCloth(); this.health = null; this.state(); break;
                case "pin": {
                    const d = this.drape;
                    if (!d?.id) break;
                    const gen = d.gen;
                    const place = d.pinPlace(data.vertex);
                    const on = d.togglePin(data.vertex);
                    // the pin lands on this round trip: where it is pinned is where it is read
                    const positions = await this.viewer.clothPositions(d.id);
                    if (d.gen !== gen) break;
                    this.pinPoints = d.pinPositions(positions);
                    this.frame(null, 0);
                    this.send({ kind: "pinned", vertex: data.vertex, on, place });
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
