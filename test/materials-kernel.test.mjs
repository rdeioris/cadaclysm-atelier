// Materials and prints on the real kernel (./pkg): the sample T-shirt has no material and draws
// as before; a denim fabric with a user diffuse image and two prints on one piece survives
// document_save / document_load (the nodes' meta and the image's document meta equal); one
// undo removes a print and a redo puts it back; the cloth's topology carries each vertex's
// link and its piece's start, so a piece moved in 2D keeps its UVs; looks.js builds the look
// from the loaded tiles, images and atlases (both engines' shapes), and the GPU host takes a
// changed look through setClothMaterial without showing the cloth again.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadKernel } from "./package.mjs";
import { Atelier } from "../kernel.js";
import { Drape } from "../cloth.js";
import { translatePath, splitByPattern, gather } from "../drape.js";
import * as m from "../model.js";
import { materialOps, imageOp, imageId, toBase64, viewMaterial, vertexUvs, outlineStarts, referencedImages, IMAGE_APP } from "../materials.js";
import { printOps, nextPrintId } from "../prints.js";
import { Looks, pieceLook, lookOptions, lookMaterial } from "../looks.js";
import { GpuDrapeHost } from "../gpu-drape.js";
import { recolourMeshes } from "../fitmap.js";

const k = await loadKernel();
const asset = (n) => new URL(`../assets/${n}`, import.meta.url);
const library = JSON.parse(readFileSync(asset("weaves/weaves.json"), "utf8"));

// ---- the sample: no material, drawn as before ---------------------------------------------------
const a = new Atelier(k);
a.load(readFileSync(asset("tshirt.json"), "utf8"));
const drape = new Drape(k, null);
drape.build(a.save());
const topo = drape.topology();
const V = topo.vertexPatterns.length;
assert.equal(topo.links.length, 2 * V, "a link a vertex");
assert.deepEqual(Array.from(topo.starts), Array.from(outlineStarts(a.nodes(), topo.patterns)), "the starts of the nodes the cloth was built from");
assert.equal(viewMaterial(a.nodes(), topo, { library }), null, "the T-shirt has no material: shown as before");
assert.deepEqual([...referencedImages(a.nodes())], []);

// ---- a material, an image and two prints, through the kernel's document ---------------------------
const fabric = a.nodes().find((n) => n.kind === "garment.fabric").id;
const front = topo.patterns[0];
const png = new Uint8Array(readFileSync(asset("weaves/plain-diffuse.png")));        // any image's bytes
const id = await imageId(png);
const image = { name: "plaid.png", mime: "image/png", width: 512, height: 512, data: toBase64(png) };
a.apply(materialOps(a.nodes(), fabric, "material.weave", "denim", library), "denim");
a.apply([imageOp(id, image), ...materialOps(a.nodes(), fabric, "material.diffuse.image", id, library)], "diffuse image");
const p1 = { id: nextPrintId(a.nodes()), image: id, at: [150, 300], rotation_deg: 0, width_mm: 120 };
a.apply(printOps(a.nodes(), front, [p1]), "print");
const p2 = { id: nextPrintId(a.nodes()), image: id, at: [150, 150], rotation_deg: 30, width_mm: 40 };
a.apply(printOps(a.nodes(), front, [p1, p2]), "print");
assert.equal(p2.id, "pr2");
const meta = (nodes) => Object.fromEntries(nodes.filter((n) => n.meta).map((n) => [n.id, n.meta]));
{
    const fab = a.nodes().find((n) => n.id === fabric);
    assert.equal(fab.meta.atelier.material.weave, "denim");
    assert.equal(fab.meta.atelier.material.maps.diffuse, id);
    assert.ok(fab.meta.atelier.colour === undefined || /^#/.test(fab.meta.atelier.colour));
    assert.deepEqual(a.meta(`${IMAGE_APP}${id}`), image, "the image in the document's meta");
    assert.equal(a.meta(`${IMAGE_APP}0000000000000000`), null);
    // save and open: everything equal
    const text = a.save();
    const b = new Atelier(k);
    b.load(text);
    assert.deepEqual(meta(b.nodes()), meta(a.nodes()), "the nodes' meta after the round trip");
    assert.deepEqual(b.nodes().find((n) => n.id === front).meta.atelier.prints, [p1, p2]);
    assert.deepEqual(b.meta(`${IMAGE_APP}${id}`), image, "the image after the round trip");
    // an image stored once however many name it: in the document's state, and in the history's
    // one commit that added it (the undo history is saved too: plan risk 9)
    assert.equal(text.split(image.data.slice(0, 64)).length - 1, 2, "the base64 in the state and its one commit");
    b.free();
    // a material or print edit does not touch the cloth: the drape sees the same garment
    assert.equal(drape.update(a.save()).kind, "same");
}
// undo removes the second print, redo puts it back
{
    const prints = () => a.nodes().find((n) => n.id === front).meta?.atelier?.prints ?? [];
    assert.equal(prints().length, 2);
    a.undo();
    assert.deepEqual(prints(), [p1], "one undo: the last print gone");
    a.redo();
    assert.deepEqual(prints(), [p1, p2], "redo: back");
    // the last print naming the image and the fabric map gone: the image goes, in one undo step
    a.apply(printOps(a.nodes(), front, []), "no prints");
    assert.ok(a.meta(`${IMAGE_APP}${id}`), "the fabric still names it");
    a.apply(materialOps(a.nodes(), fabric, "material.diffuse.clear", null, library), "clear");
    assert.equal(a.meta(`${IMAGE_APP}${id}`), null, "nothing names it: removed");
    a.undo();
    assert.deepEqual(a.meta(`${IMAGE_APP}${id}`), image, "an undo brings it back");
    a.undo();
    assert.equal(prints().length, 2);
}

// ---- the UVs follow the cloth's frame: a piece moved in 2D keeps them --------------------------------
const nodes = a.nodes();
const uvs0 = vertexUvs(topo.links, topo.vertexPatterns, topo.patterns, topo.starts, nodes);
{
    const outline = nodes.find((n) => n.id === nodes.find((x) => x.id === front).outline);
    a.apply([{ op: "set", id: outline.id, fields: { path: translatePath(outline.path, [250, -40]) } }], "move");
    const r = drape.update(a.save());
    assert.equal(r.remeshed, false, "a 2D move keeps the cloth");
    const t1 = drape.topology();
    assert.deepEqual(Array.from(t1.links), Array.from(topo.links), "the cloth's links stay");
    assert.deepEqual(Array.from(vertexUvs(t1.links, t1.vertexPatterns, t1.patterns, t1.starts, a.nodes())), Array.from(uvs0), "the same UVs");
    // the starts of the page's nodes (moved) would not do: they are not the cloth's
    const wrong = vertexUvs(t1.links, t1.vertexPatterns, t1.patterns, outlineStarts(a.nodes(), t1.patterns), a.nodes());
    assert.notDeepEqual(Array.from(wrong), Array.from(uvs0));
    a.undo();
    drape.update(a.save());
}

// ---- looks.js: the textures loaded, the atlas composed, both engines' shapes ---------------------------
const fakeDecode = async () => ({ rgba: new Uint8Array(4 * 4 * 4).fill(255), width: 4, height: 4 });
let encoded = 0;
const looks = new Looks({
    fetchBytes: async (url) => new Uint8Array(readFileSync(fileURLToPath(url))),
    readImage: (i) => a.meta(`${IMAGE_APP}${i}`),
    decode: fakeDecode,
    encode: async (atlas) => { encoded++; return Uint8Array.of(atlas.width & 255, atlas.height & 255, 9); },
});
assert.equal(looks.now(a.nodes(), topo).material.textures.length, 0, "nothing loaded yet: the sets without their maps");
await looks.prepare(a.nodes(), topo);
assert.equal(encoded, 1, "one printed piece, one atlas");
const look = looks.now(a.nodes(), topo);
assert.equal(look.uvs.length, 2 * V);
assert.equal(look.decalUvs.length, 2 * V);
assert.equal(look.material.groups.length, V);
assert.equal(look.material.sets.length, topo.patterns.length);
const set0 = look.material.sets[0];
assert.deepEqual(Object.keys(set0).sort(), ["base", "decal", "normal", "normalStrength", "roughness", "roughnessFactor", "sheen", "sheenRoughness"]);
assert.equal(look.material.textures[set0.base].key, `image:${id}`, "the user's diffuse over the weave's");
assert.equal(look.material.textures[set0.normal].key, "weave:denim:normal");
assert.deepEqual(look.material.textures[set0.normal].image, new Uint8Array(readFileSync(asset("weaves/denim-normal.png"))));
assert.equal(look.material.textures[set0.decal].key, `atlas:${front}`);
assert.equal(look.material.textures.length, 4, "image, normal, roughness, atlas: each once for every piece");
// a second prepare with nothing changed composes nothing and keeps the signature
await looks.prepare(a.nodes(), topo);
assert.equal(encoded, 1);
assert.equal(looks.now(a.nodes(), topo).sig, look.sig);
// a print moved: a new atlas, a new signature
a.apply(printOps(a.nodes(), front, [{ ...p1, at: [160, 300] }, p2]), "move print");
await looks.prepare(a.nodes(), topo);
assert.equal(encoded, 2);
const look2 = looks.now(a.nodes(), topo);
assert.notEqual(look2.sig, look.sig);
// CPU: one piece's look, its own textures only, no groups
{
    const [[p, g]] = [...splitByPattern(topo.triangles, topo.vertexPatterns)];
    const piece = pieceLook(look2, g.verts);
    assert.equal(piece.uvs.length, 2 * g.verts.length);
    assert.equal(piece.material.sets.length, 1);
    assert.equal(piece.material.groups, undefined);
    const used = ["base", "normal", "roughness", "decal"].filter((s) => piece.material.sets[0][s] !== undefined);
    assert.equal(piece.material.textures.length, new Set(used.map((s) => look2.material.sets[p][s])).size);
    assert.equal(piece.decalUvs?.length ?? 0, look2.material.sets[p].decal !== undefined ? 2 * g.verts.length : 0);
    assert.deepEqual(Object.keys(lookOptions(piece)).sort(), piece.decalUvs ? ["decalUvs", "material", "uvs"] : ["material", "uvs"]);
    assert.deepEqual(lookOptions(null), {});
    assert.equal(lookMaterial(null), null);
    assert.deepEqual(Object.keys(lookMaterial(look2)).sort(), ["decalUvs", "groups", "sets", "textures", "uvs"]);
    // the fit map on: the colours only; off: the fabric colour with the material again
    const calls = [];
    const viewer = { showMesh: (o) => { calls.push(o); return calls.length + 100; }, remove() {} };
    const meshes = [{ item: 1, id: topo.patterns[p], verts: g.verts, indices: g.indices, buf: gather(drape.positions(), g.verts), colour: "#336699", look: piece }];
    recolourMeshes(viewer, meshes, new Float32Array(3 * V).fill(0.5));
    assert.equal(calls[0].material, undefined, "a map drops the material");
    recolourMeshes(viewer, meshes, null);
    assert.equal(calls[1].material, piece.material, "the map off: the material back");
    assert.equal(calls[1].uvs, piece.uvs);
    assert.equal(calls[1].colour, "#336699");
}
// the material removed everywhere: no look (drawn as before)
{
    const bare = a.nodes().map((n) => (n.meta?.atelier ? { ...n, meta: { ...n.meta, atelier: { ...n.meta.atelier, material: undefined, prints: undefined } } } : n));
    assert.equal(looks.now(bare, topo), null);
}

// ---- the GPU host: the look at show, a changed one through setClothMaterial ------------------------
{
    const calls = [];
    const view = {
        clothGpu: true,
        showCloth: (h, o) => { calls.push(["showCloth", o]); return 7; },
        setClothMaterial: (i, mat) => calls.push(["setClothMaterial", i, mat]),
        remove: () => {}, stepCloth: () => 0, clothHealth: async () => ({}), clothPositions: async () => null, setClothMap: () => {},
    };
    const host = new GpuDrapeHost(view, k);
    host.onmessage = () => {};
    let lookNow = look;
    host.lookFor = (t) => { assert.equal(t.links.length, 2 * V, "the host's topology has the links"); return lookNow; };
    await host.postMessage({ kind: "build", text: a.save(), ops: null, run: false });
    const shown = calls.find((c) => c[0] === "showCloth")[1];
    assert.equal(shown.material, look.material, "showCloth takes the look");
    assert.equal(shown.uvs, look.uvs);
    assert.equal(shown.decalUvs, look.decalUvs);
    assert.equal(shown.thickness, true);
    lookNow = look2;
    await host.postMessage({ kind: "material" });
    const set = calls.filter((c) => c[0] === "setClothMaterial");
    assert.equal(set.length, 1);
    assert.equal(set[0][1], 7);
    assert.deepEqual(set[0][2], lookMaterial(look2));
    assert.equal(calls.filter((c) => c[0] === "showCloth").length, 1, "not shown again");
    lookNow = null;
    await host.postMessage({ kind: "material" });
    assert.equal(calls.at(-1)[2], null, "no look: the material off");
    await host.postMessage({ kind: "reset" });
}
drape.free();
console.log("materials-kernel: ok");
