// The trim templates (trimgeo.js) with the wasm kernel: every template closed, under its
// triangle budget, sized by its record, the button's holes through it, the cache and the
// template set, and every handle freed.
import assert from "node:assert/strict";
import { loadKernel } from "./package.mjs";
import {
    TEMPLATE, BUDGET, buildTemplate, TemplateCache, templateSet, templateKey,
    stitchSize, buttonSize, buttonholeSize, zipperSizes,
} from "../trimgeo.js";

const k = await loadKernel();

// welded (equal positions) edge census: edges not on exactly 2 triangles, and the Euler
// characteristic V - E + F (2 a sphere, 2 - 2g a solid with g holes through it)
function census(m) {
    const id = new Map(), w = [];
    for (let i = 0; i < m.positions.length; i += 3) {
        const key = `${m.positions[i]},${m.positions[i + 1]},${m.positions[i + 2]}`;
        if (!id.has(key)) id.set(key, id.size);
        w.push(id.get(key));
    }
    const edges = new Map();
    let faces = 0;
    for (let t = 0; t < m.indices.length; t += 3) {
        const v = [w[m.indices[t]], w[m.indices[t + 1]], w[m.indices[t + 2]]];
        if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) continue;
        faces++;
        for (let e = 0; e < 3; e++) {
            const a = v[e], b = v[(e + 1) % 3], key = a < b ? `${a},${b}` : `${b},${a}`;
            edges.set(key, (edges.get(key) ?? 0) + 1);
        }
    }
    let open = 0;
    for (const n of edges.values()) if (n !== 2) open++;
    return { open, chi: id.size - edges.size + faces };
}
function box(m) {
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = 0; i < m.positions.length; i += 3)
        for (let a = 0; a < 3; a++) { const v = m.positions[i + a]; b[a] = Math.min(b[a], v); b[a + 3] = Math.max(b[a + 3], v); }
    return b;
}
const size = (b) => [b[3] - b[0], b[4] - b[1], b[5] - b[2]];
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

// the records (sizes in mm; the kernel's size keys from them)
const topstitch = { stitch_length: 3, thread: 0.4 };
const button = (holes, diameter = 15) => ({ diameter, thickness: 3, holes });
const buttonhole = { length: 17 };
const zipper = { tape_width: 12, tooth_pitch: 5 };
const z = zipperSizes(zipper);
const cases = [
    ["stitch", TEMPLATE.STITCH, stitchSize(topstitch)],
    ["button 0 holes", TEMPLATE.BUTTON, buttonSize(button(0))],
    ["button 2 holes", TEMPLATE.BUTTON, buttonSize(button(2))],
    ["button 4 holes", TEMPLATE.BUTTON, buttonSize(button(4))],
    ["button 4 holes, 30 mm", TEMPLATE.BUTTON, buttonSize(button(4, 30))],
    ["buttonhole bar", TEMPLATE.BUTTONHOLE_BAR, buttonholeSize(buttonhole)],
    ["buttonhole bar, 40 mm", TEMPLATE.BUTTONHOLE_BAR, buttonholeSize({ length: 40 })],
    ["tooth", TEMPLATE.TOOTH, z.tooth],
    ["tape", TEMPLATE.TAPE, z.tape],
    ["slider", TEMPLATE.SLIDER, z.slider],
    ["slider, 8 mm pitch", TEMPLATE.SLIDER, zipperSizes({ tape_width: 15, tooth_pitch: 8 }).slider],
];
const built = {};
for (const [name, kind, sz] of cases) {
    const m = buildTemplate(k, kind, sz);
    built[name] = m;
    assert.ok(m.positions instanceof Float32Array && m.normals instanceof Float32Array && m.indices instanceof Uint32Array, `${name}: typed arrays`);
    assert.equal(m.positions.length, m.normals.length, `${name}: a normal a position`);
    assert.ok(m.positions.every(Number.isFinite) && m.normals.every(Number.isFinite), `${name}: no NaN`);
    const tris = m.indices.length / 3, c = census(m);
    assert.ok(tris > 0 && tris <= BUDGET[kind], `${name}: ${tris} triangles, budget ${BUDGET[kind]}`);
    assert.equal(c.open, 0, `${name}: closed`);
    built[name].chi = c.chi;
    console.log(`ok - ${name} [${sz.map((v) => +v.toFixed(3))}]: closed, ${tris} triangles (budget ${BUDGET[kind]}), chi ${c.chi}`);
}

// the button's holes go through it: genus = holes (chi 2 - 2g), and they cost triangles
assert.equal(built["button 0 holes"].chi, 2);
assert.equal(built["button 2 holes"].chi, -2);
assert.equal(built["button 4 holes"].chi, -6);
const tri = (n) => built[n].indices.length / 3;
assert.ok(tri("button 0 holes") < tri("button 2 holes") && tri("button 2 holes") < tri("button 4 holes"), "holes add triangles");
assert.equal(built["buttonhole bar"].chi, 0, "the bar is a ring (genus 1)");
console.log("ok - the button has 0, 2 and 4 holes through it (genus 0, 2 and 4: chi 2, -2, -6); the bar is a ring");

// sizes follow the records: x along the instance, z out of the cloth, centred on the origin
// (the slider's tab hangs off its -x end)
const centred = (name, tol = 1e-4) => { const b = box(built[name]); for (let a = 0; a < 3; a++) near(b[a] + b[a + 3], 0, tol, `${name} centre ${"xyz"[a]}`); };
{
    const s = size(box(built.stitch));
    near(s[0], topstitch.stitch_length * 0.6, 1e-4, "stitch length");
    near(s[2], topstitch.thread, 1e-4, "stitch thread (z)");
    assert.ok(s[1] <= topstitch.thread + 1e-4 && s[1] >= topstitch.thread * 0.85, `stitch thread (y) ${s[1]}`);
    centred("stitch");
    for (const name of ["button 0 holes", "button 2 holes", "button 4 holes"]) {
        const b = size(box(built[name]));
        near(b[0], 15, 1e-4, `${name} diameter x`); near(b[1], 15, 1e-4, `${name} diameter y`); near(b[2], 3, 1e-4, `${name} thickness`);
        centred(name);
    }
    near(size(box(built["button 4 holes, 30 mm"]))[0], 30, 1e-4, "30 mm button");
    const h = size(box(built["buttonhole bar"]));
    near(h[0], 17, 1e-4, "bar length"); near(h[1], 1.5, 1e-4, "bar width"); near(h[2], 0.6, 1e-4, "bar thickness");
    near(size(box(built["buttonhole bar, 40 mm"]))[0], 40, 1e-4, "40 mm bar");
    centred("buttonhole bar");
    const t = size(box(built.tooth));
    near(t[0], 0.8 * 5, 1e-4, "tooth along the seam"); near(t[1], 5, 1e-4, "tooth depth"); near(t[2], 3, 1e-4, "tooth thickness");
    centred("tooth");
    const p = size(box(built.tape));
    near(p[0], 5, 1e-4, "tape along the seam (pitch)"); near(p[1], 12, 1e-4, "tape width"); near(p[2], 0.6, 1e-4, "tape thickness");
    centred("tape");
    const sl = box(built.slider), sl8 = box(built["slider, 8 mm pitch"]);
    near(sl[4] - sl[1], 2.4 * 5, 1e-4, "slider width"); near(sl[5] - sl[2], (1.2 + 0.16) * 5, 1e-4, "slider height with its tab");
    near(sl[5] + sl[2], 0, 1e-4, "slider centred in z");
    for (let a = 0; a < 6; a++) near(sl8[a], sl[a] * 8 / 5, 1e-3, `slider scales with the pitch (${a})`);
}
console.log("ok - every template's box follows its record");

// the cache builds each size once; the template set takes each (kind, size) once
const cache = new TemplateCache(8);
const a = cache.get(k, TEMPLATE.STITCH, [1.8, 0.4, 0]);
assert.equal(cache.get(k, TEMPLATE.STITCH, [1.8000001, 0.4, 0]), a, "the same size key hits the cache");
assert.notEqual(cache.get(k, TEMPLATE.STITCH, [2.4, 0.4, 0]), a, "another size builds anew");
assert.equal(cache.built, 2);
assert.notEqual(templateKey(TEMPLATE.BUTTON, [15, 3, 2]), templateKey(TEMPLATE.BUTTON, [15, 3, 4]), "the holes are in the key");
const row = (kind, s) => [0, 0, 0, 0, 0, 0, kind, ...s, 1, 1, 1, 0];
const rows = Float64Array.from([...row(0, [1.8, 0.4, 0]), ...row(3, z.tooth), ...row(0, [1.8, 0.4, 0]), ...row(4, z.tape), ...row(4, z.tape)]);
const set = templateSet(k, rows, cache);
assert.equal(set.templates.length, 3);
assert.deepEqual(Array.from(set.slot), [0, 1, 0, 2, 2]);
assert.equal(set.templates[0], a);
console.log("ok - the cache and the template set build each size once");

// determinism and handles: a second build is byte-equal, and no handle outlives a build
const live = { profile: new Set(), list: new Set(), solid: new Set() };
const kinds = {
    profile: /_(profile_(rect|regular_polygon|slot|rotate|round|with_hole|list_get))$/,
    list: /_profile_union$/,
    solid: /_(extrude|loft|cuboid|chamfer)$/,
};
const frees = { profile: /_profile_free$/, list: /_profile_list_free$/, solid: /_solid_free$/ };
const counting = new Proxy(k, {
    get(target, name) {
        const v = target[name];
        if (typeof v !== "function") return v;
        for (const [t, re] of Object.entries(kinds)) if (re.test(String(name))) return (...args) => { const h = v(...args); live[t].add(h); return h; };
        for (const [t, re] of Object.entries(frees)) if (re.test(String(name))) return (h) => { live[t].delete(h); return v(h); };
        return v;
    },
});
for (const [name, kind, sz] of cases) {
    const m = buildTemplate(counting, kind, sz);
    assert.deepEqual(new Uint8Array(m.positions.buffer), new Uint8Array(built[name].positions.buffer), `${name}: byte-equal positions`);
    assert.deepEqual(m.indices, built[name].indices, `${name}: equal indices`);
}
for (const [t, s] of Object.entries(live)) assert.equal(s.size, 0, `live ${t} handles: ${[...s]}`);
assert.throws(() => buildTemplate(counting, TEMPLATE.BUTTON, [15, 3, 3]), /holes must be 0, 2 or 4/);
assert.throws(() => buildTemplate(counting, TEMPLATE.BUTTONHOLE_BAR, [1, 1.5, 0.6]), /must exceed/);
for (const [t, s] of Object.entries(live)) assert.equal(s.size, 0, `live ${t} handles after a refusal: ${[...s]}`);
console.log("ok - builds are byte-equal and free every handle");
