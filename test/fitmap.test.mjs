// fitmap.js: the maps and their units, the default ranges, the legend's state and the range
// typed in it, the one-hover-in-flight rule, the hover burst's cache, the value under a point;
// the CPU engine's colours (the cloth worker's cloth_strain_colours, re-shown per pattern mesh,
// the item map kept) and the GPU engine's (gpu-drape.js: setClothMap once per change, kept
// across a re-show; strain() from one positions read) on the sample T-shirt on the real kernel.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadKernel } from "./package.mjs";
import { Atelier } from "../kernel.js";
import { Drape } from "../cloth.js";
import { avatarMesh, splitByPattern, gather } from "../drape.js";
import { GpuDrapeHost } from "../gpu-drape.js";
import { MAPS, mapOf, RAMP, legendGradient, toShown, fromShown, defaultRange, shownText, valueText, FitMap, Latest, BurstCache, valueAt, recolourMeshes, STRAIN_MAX, STRESS_AT } from "../fitmap.js";
import { PRESETS, presetParams } from "../fabrics.js";
import * as m from "../model.js";

// ---- the pure parts ---------------------------------------------------------------------------
assert.deepEqual(MAPS.map((x) => x.key), ["off", "strain", "weft", "warp", "bias", "stress"]);
assert.deepEqual(MAPS.slice(1).map((x) => x.code), [1, 2, 3, 4, 5], "cloth_strain's map numbers");
assert.equal(mapOf("nope").key, "off");
assert.equal(mapOf("stress").unit, "N/m");
assert.equal(mapOf("bias").unit, "%");
assert.deepEqual(RAMP, ["#0000ff", "#00ffff", "#00ff00", "#ffff00", "#ff0000"], "the kernel's five stops");
assert.match(legendGradient(), /^linear-gradient\(to right, #0000ff, #00ffff, #00ff00, #ffff00, #ff0000\)$/);
assert.equal(toShown("strain", 0.05), 5);
assert.equal(fromShown("warp", 5), 0.05);
assert.equal(toShown("stress", 2500), 2.5, "g/s^2 (mN/m) shown in N/m");
assert.equal(fromShown("stress", 2.5), 2500);
assert.equal(shownText("strain", 0.0425), "4.25");
assert.equal(shownText("strain", 0.15), "15");
assert.equal(shownText("stress", 123456), "123");
assert.equal(shownText("strain", NaN), "");
assert.equal(valueText("strain", 0.0425), "Strain 4.25 %");
assert.equal(valueText("stress", 1500), "Stress 1.5 N/m");
assert.equal(valueText("weft", NaN), "Weft: no value here");
assert.equal(valueText("off", 1), "");

// default ranges: 0-10 % for the strains; stress 0 to the largest stretch stiffness x 5 %
const fabric = (slug) => ({ id: `f_${slug}`, kind: "garment.fabric", ...presetParams(slug) });
const jersey = fabric("cotton_jersey"), denim = fabric(PRESETS.find((p) => p.slug === "denim").slug);
for (const k of ["strain", "weft", "warp", "bias"]) assert.deepEqual(defaultRange(k, [jersey]), [0, STRAIN_MAX]);
const kMax = Math.max(jersey.stretch_warp, jersey.stretch_weft, denim.stretch_warp, denim.stretch_weft);
assert.deepEqual(defaultRange("stress", [jersey, denim, { id: "p1", kind: "garment.pattern" }]), [0, kMax * STRESS_AT]);
assert.ok(defaultRange("stress", [])[1] > 0, "no fabric: still a range");

// the page's state
{
    const f = new FitMap();
    assert.equal(f.on, false);
    assert.deepEqual(f.message(), { kind: "fitmap", map: null });
    assert.equal(f.legend().on, false);
    assert.deepEqual(f.set("weft", [jersey]), { kind: "fitmap", map: { key: "weft", code: 2, min: 0, max: 0.1 } });
    assert.deepEqual(f.legend(), { on: true, title: "Weft", unit: "%", lo: "0", hi: "10", gradient: legendGradient() });
    assert.deepEqual(f.setRange("1", " 20 "), { kind: "fitmap", map: { key: "weft", code: 2, min: 0.01, max: 0.2 } });
    assert.match(f.setRange("5", "5").error, /below/);
    assert.match(f.setRange("", "5").error, /numbers/);
    assert.match(f.setRange("a", "5").error, /numbers/);
    assert.equal(f.hi, 0.2, "a refused range keeps the last");
    const s = f.set("stress", [jersey]);
    assert.equal(s.map.code, 5); assert.equal(s.map.max, Math.max(jersey.stretch_warp, jersey.stretch_weft) * STRESS_AT, "a new map takes its default range");
    assert.equal(f.legend().unit, "N/m");
    assert.deepEqual(f.setRange("0", "3").map, { key: "stress", code: 5, min: 0, max: 3000 });
    assert.deepEqual(f.set("off").map, null);
}

// one hover in flight, the newest waiting, older ones dropped
{
    const sent = [];
    const l = new Latest((x) => sent.push(x));
    l.push(1); l.push(2); l.push(3);
    assert.deepEqual(sent, [1], "one in flight");
    l.done();
    assert.deepEqual(sent, [1, 3], "the newest, the one between dropped");
    l.done();
    assert.deepEqual(sent, [1, 3], "nothing waiting");
    l.push(4);
    assert.deepEqual(sent, [1, 3, 4]);
}
// a hover burst reads once
{
    const c = new BurstCache(300);
    let reads = 0;
    const read = () => ++reads;
    assert.equal(c.get("a", 0, read), 1);
    assert.equal(c.get("a", 200, read), 1);
    assert.equal(c.get("a", 450, read), 1, "hovers 250 ms apart: one burst");
    assert.equal(c.get("a", 800, read), 2, "a pause: read afresh");
    assert.equal(c.get("b", 810, read), 3, "another map: read afresh");
    c.clear();
    assert.equal(c.get("b", 820, read), 4);
}
// the value under a point: the nearest vertex's (among a piece's)
{
    const pos = Float64Array.of(0, 0, 0, 10, 0, 0, 20, 0, 0), vals = Float64Array.of(0.1, 0.2, NaN);
    assert.equal(valueAt(vals, pos, [9, 1, 0]), 0.2);
    assert.equal(valueAt(vals, pos, [9, 1, 0], Uint32Array.of(0, 2)), 0.1);
    assert.ok(Number.isNaN(valueAt(vals, pos, [19, 0, 0])));
    assert.ok(Number.isNaN(valueAt(null, pos, [0, 0, 0])));
}

// ---- the CPU engine: the sample's cloth, re-shown with the kernel's colours ---------------------
const k = await loadKernel();
const asset = (n) => new URL(`../assets/${n}`, import.meta.url);
const scene = k.open(new Uint8Array(readFileSync(asset("f-M.stp"))), "step", undefined, "native");
const avatar = avatarMesh(scene.vertices(), scene.origin(), scene.indices());
scene.free();
const a = new Atelier(k);
a.load(readFileSync(asset("tshirt.json"), "utf8"));
const drape = new Drape(k, avatar);
drape.build(a.save());
for (let i = 0; i < 3; i++) drape.step();
const n = drape.positions().length / 3;
const strain = k.cadaclysm_blacksmith_cloth_strain(drape.h, 1);
assert.equal(strain.length, n);
assert.ok(strain.some(Number.isFinite), "the sewing cloth has strain values");
const colours = k.cadaclysm_blacksmith_cloth_strain_colours(drape.h, 1, 0, STRAIN_MAX);
assert.equal(colours.length, 3 * n);
{
    // the fake View: showMesh / remove recorded
    const calls = [];
    let next = 100;
    const viewer = { showMesh(mesh) { calls.push(["showMesh", mesh]); return next++; }, remove(id) { calls.push(["remove", id]); } };
    const topo = drape.topology(), positions = drape.positions();
    const meshes = [...splitByPattern(topo.triangles, topo.vertexPatterns)].map(([p, g], i) => ({ item: i + 1, id: topo.patterns[p], verts: g.verts, indices: g.indices, buf: gather(positions, g.verts), colour: "#123456" }));
    meshes.push({ item: 99, gpu: true });
    const items = new Map(meshes.map((x) => [x.item, x.id]));
    recolourMeshes(viewer, meshes, colours, (old, nu, mesh) => { items.delete(old); items.set(nu, mesh.id); });
    const shown = calls.filter((c) => c[0] === "showMesh");
    assert.equal(shown.length, 4, "one re-show per pattern mesh, none for the GPU item");
    assert.deepEqual(calls.filter((c) => c[0] === "remove").map((c) => c[1]), [1, 2, 3, 4], "the old items go");
    for (const [i, [, mesh]] of shown.entries()) {
        assert.equal(mesh.colour, undefined);
        assert.equal(mesh.edges, undefined, "colours cannot go with edges");
        assert.deepEqual(Array.from(mesh.colours), Array.from(gather(colours, meshes[i].verts)), "the piece's vertices' colours");
        assert.equal(mesh.positions, meshes[i].buf);
        assert.equal(mesh.indices, meshes[i].indices);
    }
    assert.deepEqual([...items.keys()].sort((x, y) => x - y), [99, 100, 101, 102, 103], "the item map follows");
    // the map off: the fabric colours again
    calls.length = 0;
    recolourMeshes(viewer, meshes, null);
    assert.deepEqual(calls.filter((c) => c[0] === "showMesh").map((c) => [c[1].colour, c[1].colours]), [["#123456", undefined], ["#123456", undefined], ["#123456", undefined], ["#123456", undefined]]);
}

// ---- the GPU engine: setClothMap once per change, kept across a re-show ---------------------------
class FakeView {
    constructor() { this.calls = []; this.next = 1; this.shown = new Map(); this.clothGpu = true; }
    named(name) { return this.calls.filter((c) => c[0] === name); }
    showCloth(h, opts) { const id = this.next++; this.shown.set(id, h); this.calls.push(["showCloth", h, opts]); return id; }
    setClothMap(id, map) { if (!this.shown.has(id)) throw new Error(`setClothMap: ${id} is no cloth`); this.calls.push(["setClothMap", id, map]); }
    remove(id) { this.shown.delete(id); this.calls.push(["remove", id]); }
    stepCloth() { return 0; }
    async clothHealth() { return { nonFinite: 0, dropped: 0, maxSpeed: 0, seamPairs: null, weldedPairs: null }; }
    async clothPositions(id) { this.calls.push(["clothPositions", id]); return Float32Array.from(k.cadaclysm_blacksmith_cloth_positions(this.shown.get(id))); }
    setClothOptions() {}
}
{
    const view = new FakeView();
    const host = new GpuDrapeHost(view, k);
    host.onmessage = () => {};
    await host.postMessage({ kind: "avatar", avatar });
    const map = { key: "strain", code: 1, min: 0, max: 0.1 };
    await host.postMessage({ kind: "map", map });
    assert.equal(view.named("setClothMap").length, 0, "no cloth yet");
    await host.postMessage({ kind: "build", text: a.save(), ops: null, run: false });
    const id = host.drape.id;
    assert.deepEqual(view.named("setClothMap"), [["setClothMap", id, { map: "strain", min: 0, max: 0.1 }]], "the map drawn at show time");
    await host.postMessage({ kind: "map", map: { key: "stress", code: 5, min: 0, max: 5000 } });
    assert.deepEqual(view.named("setClothMap").at(-1), ["setClothMap", id, { map: "stress", min: 0, max: 5000 }]);
    // a re-show (the GIA switch) draws it again
    await host.postMessage({ kind: "gia", on: false });
    assert.notEqual(host.drape.id, id);
    assert.deepEqual(view.named("setClothMap").at(-1), ["setClothMap", host.drape.id, { map: "stress", min: 0, max: 5000 }]);
    const count = view.named("setClothMap").length;
    await host.postMessage({ kind: "map", map: null });
    assert.deepEqual(view.named("setClothMap").at(-1), ["setClothMap", host.drape.id, null], "off: the cloth's own colours");
    assert.equal(view.named("setClothMap").length, count + 1, "once per change");
    // the hover's values: one positions read, cloth_strain from those positions
    const reads = view.named("clothPositions").length;
    const r = await host.strain(1);
    assert.equal(view.named("clothPositions").length, reads + 1);
    assert.deepEqual(Array.from(r.values), Array.from(k.cadaclysm_blacksmith_cloth_strain(host.drape.h, 1, r.positions)));
    assert.equal(r.values.length, r.positions.length / 3);
    await host.postMessage({ kind: "reset" });
    assert.equal(await host.strain(1), null, "no cloth: no values");
}
drape.free();
console.log("fitmap: ok");
