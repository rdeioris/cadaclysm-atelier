// gpu-drape.js: the status from a View health answer, the sewing switch, and the host driving a
// real Drape (the sample T-shirt on the pkg's kernel) against a fake View that records its
// calls: build -> topology with the item, frames, sewing -> draping through setClothOptions,
// pins and drags through the View (never the kernel cloth), a blow-up pausing with a reason,
// an outline edit re-showing the cloth after a positions read, a stale edit, Reset, and the
// GIA switch (showCloth's `gia`: off by default, a live cloth re-shown with it, kept by a rebuild).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadKernel } from "./package.mjs";
import { Atelier } from "../kernel.js";
import { avatarMesh, healthOf, statusOf, SEW_FRAMES, MAX_SPEED } from "../drape.js";
import { GpuDrapeHost, statusFromHealth, sewingOver, clothColour, gpuClothOk, ENGINE_TEXT, giaState, vertexColours } from "../gpu-drape.js";
import { fabricColours } from "../arrange.js";
import * as m from "../model.js";

// ---- the pure parts ---------------------------------------------------------------------------
const H = (o = {}) => ({ nonFinite: 0, dropped: 0, maxSpeed: 120, weldCandidates: 0, overflow: 0, frames: 0, roundTrips: 0, welds: 0, resyncs: 0, weldedPairs: 3, seamPairs: 40, ...o });
{
    const s = statusOf(statusFromHealth(H({ nonFinite: 2, dropped: 1, maxSpeed: 7.5 }), 12, 900, 1600));
    assert.deepEqual(s, { frame: 12, vertices: 900, triangles: 1600, seamPairs: 40, welded: 3, nonFinite: 2, dropped: 1, maxSpeed: 7.5 });
    const unknown = statusOf(statusFromHealth(H({ weldedPairs: null, seamPairs: null }), 1, 9, 9));
    assert.equal(unknown.seamPairs, 0); assert.equal(unknown.welded, 0);
    // healthOf reads it as the CPU's status
    assert.equal(healthOf(statusFromHealth(H(), 5, 900, 1600), "sewing").stop, false);
    assert.equal(healthOf(statusFromHealth(H({ nonFinite: 1 }), 5, 900, 1600), "sewing").stop, true);
    assert.equal(healthOf(statusFromHealth(H({ maxSpeed: MAX_SPEED + 1 }), 5, 900, 1600), "draping").stop, true);

    assert.equal(sewingOver(H(), 0), false);
    assert.equal(sewingOver(H(), SEW_FRAMES - 1), false);
    assert.equal(sewingOver(H(), SEW_FRAMES), true, "SEW_FRAMES frames sewn");
    assert.equal(sewingOver(H({ weldedPairs: 40 }), 1), true, "every pair welded");
    assert.equal(sewingOver(H({ weldedPairs: 0, seamPairs: 0 }), 1), true, "no seams");
    assert.equal(sewingOver(H({ weldedPairs: null, seamPairs: null }), 1), false, "unknown counts are not done");

    assert.equal(gpuClothOk(null), false);
    assert.equal(gpuClothOk({ clothGpu: true }), false, "an older package: no showCloth");
    assert.equal(gpuClothOk({ clothGpu: false, showCloth() {} }), false, "WebGL2");
    assert.equal(gpuClothOk({ clothGpu: true, showCloth() {} }), true);
    assert.equal(ENGINE_TEXT.gpu, "GPU · GIA off");
    assert.equal(ENGINE_TEXT.gpuGia, "GPU · GIA on");
    // the label and the GIA button: off by default on the GPU; on and disabled on the CPU
    const off = giaState("gpu", false), on = giaState("gpu", true), cpu = giaState("cpu", false), cpuOn = giaState("cpu", true);
    assert.equal(off.text, "GPU · GIA off"); assert.equal(off.on, false); assert.equal(off.disabled, false);
    assert.equal(on.text, "GPU · GIA on"); assert.equal(on.on, true); assert.equal(on.disabled, false);
    assert.notEqual(on.title, off.title);
    assert.match(off.button, /GIA off/); assert.match(on.button, /GIA on/);
    for (const c of [cpu, cpuOn]) {
        assert.equal(c.text, "CPU"); assert.equal(c.on, true, "always on on the CPU"); assert.equal(c.disabled, true);
        assert.match(c.button, /always runs on the CPU/);
    }
    assert.deepEqual(giaState(null, false), cpu, "before the worker answers: the CPU's (disabled)");
}

// ---- the host on the real kernel, a fake View ---------------------------------------------------
const kernel = await loadKernel();
// the kernel, its cloth edits recorded: none may run while the cloth is on the GPU
const kernelCalls = [];
const WATCHED = new Set(["cloth_pin", "cloth_unpin", "cloth_drag", "cloth_set_options", "cloth_step"].map((n) => `cadaclysm_blacksmith_${n}`));
const k = new Proxy(kernel, {
    get(t, name) {
        const v = t[name];
        if (typeof v !== "function" || !WATCHED.has(name)) return v;
        return (...args) => { kernelCalls.push(name.slice("cadaclysm_blacksmith_".length)); return v(...args); };
    },
});

class FakeView {
    constructor() { this.calls = []; this.next = 1; this.shown = new Map(); this.health = H(); this.clothGpu = true; }
    log(name, ...args) { this.calls.push([name, ...args]); }
    named(name) { return this.calls.filter((c) => c[0] === name); }
    showCloth(h, opts) { const id = this.next++; this.shown.set(id, h); this.log("showCloth", h, opts); return id; }
    remove(id) { this.log("remove", id); this.shown.delete(id); }
    // `hold` > 0: that many submits held back (a weld's round trip in flight), as the View does
    stepCloth(id, n) { this.log("stepCloth", id, n); if (!this.shown.has(id)) throw new Error(`stepCloth: item ${id} is no cloth`); if (this.hold > 0) { this.hold--; return 0; } return n; }
    async clothHealth(id) { this.log("clothHealth", id); await new Promise((r) => setTimeout(r, 2)); return { ...this.health }; }
    async clothPositions(id) {
        this.log("clothPositions", id);
        await new Promise((r) => setTimeout(r, 1));
        return Float32Array.from(kernel.cadaclysm_blacksmith_cloth_positions(this.shown.get(id)));
    }
    pinCloth(id, v, at) { this.log("pinCloth", id, v, at); }
    unpinCloth(id, v) { this.log("unpinCloth", id, v); }
    dragCloth(id, v, target) { this.log("dragCloth", id, v, target); }
    setClothOptions(id, opts) { this.log("setClothOptions", id, opts); }
}

const asset = (n) => new URL(`../assets/${n}`, import.meta.url);
const scene = kernel.open(new Uint8Array(readFileSync(asset("f-M.stp"))), "step", undefined, "native");
const avatar = avatarMesh(scene.vertices(), scene.origin(), scene.indices());
scene.free();
const a = new Atelier(kernel);
a.load(readFileSync(asset("tshirt.json"), "utf8"));
assert.match(clothColour(a.nodes()), /^#/);
// one piece in a copy of the fabric, in a colour of its own (the kernel keeps both fabrics and the colour)
{
    const f0 = a.nodes().find((n) => n.kind === "garment.fabric").id, dup = m.duplicateFabric(a.nodes(), f0);
    a.apply(dup.ops, "duplicate fabric");
    a.apply([{ op: "set", id: dup.id, fields: { meta: { atelier: { colour: "#204060" } } } }], "colour");
    a.apply(m.setPattern(a.nodes(), "p2", { fabric: dup.id }), "fabric");
    assert.equal(fabricColours(a.nodes()).get(dup.id), "#204060", "the colour read back from the kernel's document");
    const fs = a.nodes().filter((n) => n.kind === "garment.fabric");
    for (const k of m.FABRIC_FIELDS) assert.equal(fs[1][k], fs[0][k], `the copy's ${k}`);
}

const view = new FakeView();
const host = new GpuDrapeHost(view, k);
const got = [];
host.onmessage = ({ data }) => got.push(data);
const of = (kind) => got.filter((x) => x.kind === kind);
const last = (kind) => of(kind).at(-1);
async function until(what, cond, ms = 20000) {
    const t0 = Date.now();
    while (!cond()) {
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}; got ${JSON.stringify(got.map((x) => x.kind))}`);
        await new Promise((r) => setTimeout(r, 1));
    }
}

await until("hello", () => of("hello").length === 1);
await host.postMessage({ kind: "avatar", avatar });

// build, not running: a topology carrying the View item, the kernel cloth shown
await host.postMessage({ kind: "build", text: a.save(), ops: null, run: false });
const topo = last("topology");
assert.ok(topo, "a topology");
const item1 = view.named("showCloth")[0] && view.next - 1;
assert.equal(topo.gpu.item, item1);
assert.equal(view.named("showCloth")[0][1], host.drape.h, "the kernel handle is shown");
assert.equal(view.named("showCloth")[0][2].colour, clothColour(a.nodes()));
assert.equal(view.named("showCloth")[0][2].gia, false, "GIA off unless asked for");
// every sim vertex in its piece's fabric colour: p2 in the copy's #204060, the rest in the first fabric's
{
    const cs = view.named("showCloth")[0][2].colours, base = clothColour(a.nodes());
    const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    assert.equal(cs.length, 3 * topo.vertexPatterns.length);
    const p2 = topo.patterns.indexOf("p2");
    let n2 = 0;
    topo.vertexPatterns.forEach((p, k) => {
        const want = rgb(p === p2 ? "#204060" : base);
        if (p === p2) n2++;
        for (let c = 0; c < 3; c++) assert.ok(Math.abs(cs[k * 3 + c] - want[c]) < 1e-6, `vertex ${k} (pattern ${topo.patterns[p]})`);
    });
    assert.ok(n2 > 0 && n2 < topo.vertexPatterns.length, `${n2} vertices in p2`);
    assert.deepEqual([...vertexColours(a.nodes(), topo)], [...cs]);
}
assert.deepEqual([...topo.patterns].sort(), ["p1", "p2", "p3", "p4"]);
assert.equal(topo.positions.length, 3 * topo.vertexPatterns.length);
assert.equal(topo.phase, "sewing");
assert.equal(statusOf(topo.status).frame, 0);
assert.deepEqual(last("state"), { kind: "state", running: false, live: true, stale: null });
const vertices = topo.vertexPatterns.length;

// run: frames arrive, positions null, the health line from the View's health
view.health = H({ weldedPairs: 0, seamPairs: 40 });
await host.postMessage({ kind: "run" });
assert.equal(last("state").running, true);
await until("frames", () => of("frame").length >= 5);
const f5 = of("frame")[4];
assert.equal(f5.positions, null);
assert.equal(statusOf(f5.status).frame, 5);
assert.equal(statusOf(f5.status).vertices, vertices);
assert.match(f5.health.text, /frame 5 · sewing · seams 0\/40/);
assert.equal(f5.running, true);
assert.equal(view.named("setClothOptions").length, 0, "still sewing");

// sewing -> draping after SEW_FRAMES frames: gravity back through the View
await until("draping", () => of("frame").some((x) => x.phase === "draping"));
const so = view.named("setClothOptions");
assert.equal(so.length, 1, "one switch");
assert.equal(so[0][1], item1);
assert.equal(so[0][2].length, 20);
assert.deepEqual([...so[0][2].slice(4, 7)], [...host.drape.gravity], "the stored gravity");
assert.ok(host.drape.gravity.some((g) => g !== 0));
assert.equal(statusOf(of("frame").find((x) => x.phase === "draping").status).frame, SEW_FRAMES);

// pause
await host.postMessage({ kind: "pause" });
assert.equal(last("state").running, false);
await new Promise((r) => setTimeout(r, 20));
let frozen = of("frame").length;
await new Promise((r) => setTimeout(r, 20));
assert.equal(of("frame").length, frozen, "no frames while paused");
// a film step: run 3 frames, then the host stops on its own and says so
{
    const f0 = host.frames, n0 = of("frame").length;
    await host.postMessage({ kind: "run", frames: 3 });
    await until("the step's stop", () => !host.running && !host.looping);
    assert.equal(host.frames - f0, 3, "three frames stepped");
    assert.equal(of("frame").length - n0, 3, "three frames reported");
    assert.equal(last("state").running, false, "stopped, and said so");
    await host.postMessage({ kind: "run", frames: 1 });
    await until("one more", () => !host.running && !host.looping);
    assert.equal(host.frames - f0, 4);
    // a round trip holds submits back mid-step: the step still steps exactly its frames
    const n1 = of("frame").length;
    view.hold = 2;
    await host.postMessage({ kind: "run", frames: 2 });
    await until("the held step's stop", () => !host.running && !host.looping);
    assert.equal(view.hold, 0, "the held submits were made");
    assert.equal(host.frames - f0, 6, "two frames stepped, not two submits");
    assert.equal(of("frame").length - n1, 2, "two frames reported");
    frozen = of("frame").length;
}

// pin and unpin through the View; the pin drawn where it was read
await host.postMessage({ kind: "pin", vertex: 7 });
assert.deepEqual(view.named("pinCloth").at(-1), ["pinCloth", item1, 7, null]);
assert.deepEqual(last("pinned"), { kind: "pinned", vertex: 7, on: true });
const pinsAt = kernel.cadaclysm_blacksmith_cloth_positions(host.drape.h).slice(21, 24);
assert.deepEqual([...last("frame").pins], [...Float32Array.from(pinsAt)]);
await host.postMessage({ kind: "pin", vertex: 7 });
assert.deepEqual(view.named("unpinCloth").at(-1), ["unpinCloth", item1, 7]);
assert.equal(last("pinned").on, false);
assert.equal(last("frame").pins.length, 0);
await host.postMessage({ kind: "drag", vertex: 9, target: [1, 2, 3] });
assert.deepEqual(view.named("dragCloth").at(-1), ["dragCloth", item1, 9, [1, 2, 3]]);
await host.postMessage({ kind: "drag", vertex: 9, target: null });
assert.deepEqual(view.named("dragCloth").at(-1), ["dragCloth", item1, 9, null]);
assert.deepEqual(kernelCalls, [], `no kernel cloth edit while shown: ${kernelCalls}`);

// an outline edit while running: positions read back first, then the cloth shown afresh
await host.postMessage({ kind: "run" });
await until("running", () => of("frame").length > frozen + 2);
const b = a.drawing("p3").bounds, cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2, s = 1.02;
a.commit(m.setOutline(a.nodes(), "p3", a.transformed("p3", [s, 0, cx * (1 - s), 0, s, cy * (1 - s)])), "edit", "p3");
const topos = of("topology").length, callsBefore = view.calls.length;
await host.postMessage({ kind: "update", text: a.save(), ops: null });
await until("the re-mesh", () => of("topology").length > topos);
const after = view.calls.slice(callsBefore).map((c) => c[0]);
const iPos = after.indexOf("clothPositions"), iRemove = after.indexOf("remove"), iShow = after.indexOf("showCloth");
assert.ok(iPos >= 0 && iPos < iRemove && iRemove < iShow, `positions, remove, show: ${after.join(",")}`);
assert.deepEqual(view.calls.slice(callsBefore)[iRemove], ["remove", item1]);
const item2 = last("topology").gpu.item;
assert.notEqual(item2, item1);
assert.ok(last("topology").phase === "draping", "the drape is kept");
await until("frames on the new item", () => view.named("stepCloth").at(-1)[1] === item2 && of("frame").length > 0);
assert.ok(statusOf(last("frame").status).frame > SEW_FRAMES, "the frame count carries over a re-mesh");

// a seam removed: stale, the cloth kept and stepping
const seam = a.nodes().find((n) => n.kind === "garment.seam");
const g = m.byId(a.nodes()).get("garment");
a.apply([{ op: "remove", id: seam.id }, { op: "set", id: "garment", fields: { seams: g.seams.filter((x) => x !== seam.id) } }], "remove seam");
await host.postMessage({ kind: "update", text: a.save(), ops: null });
await until("stale", () => of("state").some((x) => x.stale === "the seams changed"));
assert.equal(host.drape.id, item2);

// a blow-up pauses with a reason
view.health = H({ nonFinite: 3 });
await until("the blow-up", () => of("state").some((x) => x.reason));
assert.match(last("state").reason, /paused, the cloth blew up: .*3 non-finite/);
assert.equal(last("state").running, false);
assert.equal(host.running, false);

// reset: the item goes, the cloth with it
await host.postMessage({ kind: "reset" });
assert.deepEqual(view.named("remove").at(-1), ["remove", item2]);
assert.equal(last("state").running, false); assert.equal(last("state").live, false);
assert.equal(host.drape.id, 0);
assert.equal(await host.positions(), null);

// a rebuild whose seams are all welded at once drapes on the first frame; positions() reads the View
view.health = H({ weldedPairs: 40, seamPairs: 40 });
const options = view.named("setClothOptions").length;
await host.postMessage({ kind: "build", text: a.save(), ops: null, run: true });
await until("the quick switch", () => view.named("setClothOptions").length > options);
const item3 = last("topology").gpu.item;
assert.equal((await host.positions()).length, 3 * last("topology").vertexPatterns.length);
assert.equal(view.named("clothPositions").at(-1)[1], item3);

// GIA on while running: positions read back, the item removed, the cloth shown with gia true;
// the frames go on on the new item, the count carried over
{
    const topos = of("topology").length, callsBefore = view.calls.length, f0 = host.frames;
    await host.postMessage({ kind: "gia", on: true });
    await until("the GIA re-show", () => of("topology").length > topos);
    const calls = view.calls.slice(callsBefore), names = calls.map((c) => c[0]);
    const iPos = names.indexOf("clothPositions"), iRemove = names.indexOf("remove"), iShow = names.indexOf("showCloth");
    assert.ok(iPos >= 0 && iPos < iRemove && iRemove < iShow, `positions, remove, show: ${names.join(",")}`);
    assert.deepEqual(calls[iRemove], ["remove", item3]);
    const { colours: shownColours, ...rest } = calls[iShow][2];
    assert.deepEqual(rest, { colour: clothColour(a.nodes()), gia: true });
    assert.equal(shownColours.length, 3 * last("topology").vertexPatterns.length, "the vertex colours shown again");
    assert.equal(names.filter((n) => n === "showCloth").length, 1, "shown once");
    const item4 = last("topology").gpu.item;
    assert.notEqual(item4, item3);
    await until("frames on the GIA item", () => view.named("stepCloth").at(-1)[1] === item4 && statusOf(last("frame").status).frame > f0);
    assert.equal(last("state").running, true, "still running");
    // the same choice again: nothing re-shown
    const shows = view.named("showCloth").length;
    await host.postMessage({ kind: "gia", on: true });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(view.named("showCloth").length, shows, "no re-show for the same choice");
    // paused: GIA off re-shows at once, the cloth stays paused
    await host.postMessage({ kind: "pause" });
    await host.postMessage({ kind: "gia", on: false });
    assert.equal(view.named("showCloth").length, shows + 1);
    assert.equal(view.named("showCloth").at(-1)[2].gia, false);
    assert.equal(host.running, false);
    // a rebuild keeps the choice; with no cloth the choice is only kept
    await host.postMessage({ kind: "gia", on: true });
    await host.postMessage({ kind: "reset" });
    const shows2 = view.named("showCloth").length;
    await host.postMessage({ kind: "gia", on: false });
    await host.postMessage({ kind: "gia", on: true });
    assert.equal(view.named("showCloth").length, shows2, "no cloth: nothing shown");
    await host.postMessage({ kind: "build", text: a.save(), ops: null, run: false });
    assert.equal(view.named("showCloth").at(-1)[2].gia, true, "the rebuild shows with GIA on");
    await host.postMessage({ kind: "gia", on: false });
    assert.equal(view.named("showCloth").at(-1)[2].gia, false);
}
await host.postMessage({ kind: "pause" });
await host.postMessage({ kind: "reset" });
assert.deepEqual(kernelCalls, [], `no kernel cloth edit while shown: ${kernelCalls}`);
host.drape.free();
console.log("gpu-drape: ok");
