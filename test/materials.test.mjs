// materials.js: the fabric UVs (grain, tile, rotation; a piece moved in 2D keeps them), the
// View's material for a two-piece cloth (one fabric with a weave, one plain), the panel's
// fields, checks and ops (the colour kept, "none" removing the material, an image dropped with
// its last reference), and the image helpers.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    fabricUv, vertexUvs, outlineStarts, viewMaterial, materialOps, materialFields, validateMaterial, textureKeys, referencedImages,
    unusedImageOps, imageIndex, imageId, toBase64, fromBase64, imageOp, isMaterialKey, imageSlotOf, weaveKey, imageKey, atlasKey, NONE, IMAGES,
} from "../materials.js";
import { fieldsFor, validate, opsFor } from "../props.js";

const library = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "weaves", "weaves.json"), "utf8"));
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);
const nearAll = (a, b, msg) => { assert.equal(a.length, b.length, msg); a.forEach((v, i) => near(v, b[i], `${msg}[${i}]`)); };

// ---- fabricUv ----------------------------------------------------------------------------------
{
    // grain up (0, 1), no rotation: u = x / w, v = -y / h (the image's top toward the grain)
    nearAll(fabricUv([30, 20], [0, 1], [10, 40], 0), [3, -0.5], "grain up");
    nearAll(fabricUv([0, 0], [0, 1], [10, 10], 0), [0, 0], "the start");
    // a grain of any length is its direction
    nearAll(fabricUv([30, 20], [0, 5], [10, 40], 0), [3, -0.5], "a long grain");
    // grain along +x turns the tile 90 degrees: v runs along x, u along -y
    nearAll(fabricUv([30, 20], [1, 0], [10, 40], 0), [-2, -0.75], "grain along x");
    // a 30 degree texture rotation turns it 30 degrees: a point along the turned weft has v 0,
    // along the turned warp u 0
    const a = Math.PI / 6;
    const weft = [Math.cos(a), Math.sin(a)], warp = [-Math.sin(a), Math.cos(a)];
    nearAll(fabricUv([weft[0] * 12, weft[1] * 12], [0, 1], [6, 8], 30), [2, 0], "along the turned weft");
    nearAll(fabricUv([warp[0] * 16, warp[1] * 16], [0, 1], [6, 8], 30), [0, -2], "along the turned warp");
    // and grain (1, 0) with -90 is grain (0, 1) with none
    nearAll(fabricUv([7, 9], [1, 0], [5, 5], 90), fabricUv([7, 9], [0, -1], [5, 5], 180), "grain and rotation compose");
}

// ---- a two-piece cloth: links, starts, UVs, the View's material --------------------------------
const outline = (id, start) => ({ id: `${id}_outline`, kind: "profile.path", path: { start, segments: [{ type: "line", to: [start[0] + 100, start[1]] }, { type: "line", to: [start[0] + 100, start[1] + 100] }, { type: "line", to: start }] } });
const nodes = [
    { id: "f_denim", kind: "garment.fabric", label: "Denim", meta: { atelier: { colour: "#334466", material: { weave: "denim", maps: { diffuse: null, normal: null, roughness: null }, tile_mm: [12, 12], rotation_deg: 0, roughness: 0.85, normal_strength: 1, sheen: "#202020", sheen_roughness: 0.6 } } } },
    { id: "f_plain", kind: "garment.fabric", label: "Plain", meta: { atelier: { colour: "#aa0000" } } },
    outline("p1", [100, 200]), outline("p2", [400, 0]),
    { id: "p1", kind: "garment.pattern", label: "Front", outline: "p1_outline", fabric: "f_denim", grain: [0, 1], meta: { atelier: { slot: "front" } } },
    { id: "p2", kind: "garment.pattern", label: "Back", outline: "p2_outline", fabric: "f_plain", grain: [0, 1] },
    { id: "garment", kind: "garment.garment", patterns: ["p1", "p2"], seams: [] },
];
{
    const patterns = ["p1", "p2"];
    const starts = outlineStarts(nodes, patterns);
    assert.deepEqual(Array.from(starts), [100, 200, 400, 0]);
    // three vertices on p1, two on p2: links are absolute pattern positions
    const vertexPatterns = Uint32Array.from([0, 0, 0, 1, 1]);
    const links = Float64Array.from([100, 200, 112, 200, 100, 224, 400, 0, 450, 50]);
    const uvs = vertexUvs(links, vertexPatterns, patterns, starts, nodes);
    nearAll(Array.from(uvs.subarray(0, 6)), [0, 0, 1, 0, 0, -2], "p1 in 12 mm tiles from its start");
    nearAll(Array.from(uvs.subarray(6)), [0, 0, 0.5, -0.5], "p2 in the default 100 mm tile");
    // a piece moved 2D by (70, -30) since: its links and start move together, the UVs stay
    const movedLinks = Float64Array.from(links); for (let v = 0; v < 3; v++) { movedLinks[2 * v] += 70; movedLinks[2 * v + 1] -= 30; }
    const movedStarts = Float64Array.from([170, 170, 400, 0]);
    nearAll(Array.from(vertexUvs(movedLinks, vertexPatterns, patterns, movedStarts, nodes)), Array.from(uvs), "a moved piece keeps its UVs");

    // the View's material: one set per piece, the denim's three library tiles listed once
    const bytes = (k) => Uint8Array.of(k.length);
    const textures = new Map([...textureKeys(nodes, patterns)].map((k) => [k, bytes(k)]));
    assert.deepEqual([...textureKeys(nodes, patterns)].sort(), ["weave:denim:diffuse", "weave:denim:normal", "weave:denim:roughness"]);
    const m = viewMaterial(nodes, { patterns, vertexPatterns }, { library, textures });
    assert.equal(m.textures.length, 3);
    assert.deepEqual(Array.from(m.groups), [0, 0, 0, 1, 1], "a vertex's set is its piece's");
    assert.ok(m.groups instanceof Uint16Array);
    assert.deepEqual(m.sets[0], { roughnessFactor: 1, base: 0, normal: 1, roughness: 2, normalStrength: 1, sheen: "#202020", sheenRoughness: 0.6 },
        "the denim: its tiles, the roughness map at its own value (0.85 / 0.85)");
    assert.deepEqual(m.sets[1], { roughnessFactor: 1 }, "the plain fabric: no maps, roughness 1");
    assert.equal(m.textures[0].image, textures.get(weaveKey("denim", "diffuse")));
    // a smoother denim scales the library map down; a user roughness map takes the factor as it is
    const smooth = nodes.map((n) => (n.id === "f_denim" ? { ...n, meta: { atelier: { ...n.meta.atelier, material: { ...n.meta.atelier.material, roughness: 0.425 } } } } : n));
    near(viewMaterial(smooth, { patterns, vertexPatterns }, { library, textures }).sets[0].roughnessFactor, 0.5, "half the weave's roughness");
    const own = smooth.map((n) => (n.id === "f_denim" ? { ...n, meta: { atelier: { ...n.meta.atelier, material: { ...n.meta.atelier.material, maps: { diffuse: "aaaa", normal: null, roughness: "bbbb" } } } } } : n));
    const ownTex = new Map([...textureKeys(own, patterns)].map((k) => [k, bytes(k)]));
    assert.deepEqual([...textureKeys(own, patterns)].sort(), ["image:aaaa", "image:bbbb", "weave:denim:normal"], "a user image overrides its slot");
    const mo = viewMaterial(own, { patterns, vertexPatterns }, { library, textures: ownTex });
    near(mo.sets[0].roughnessFactor, 0.425, "a user map: the factor itself");
    assert.equal(mo.textures[mo.sets[0].base].image, ownTex.get(imageKey("aaaa")));
    // a texture still loading is left out of its set
    const partial = viewMaterial(nodes, { patterns, vertexPatterns }, { library, textures: new Map([[weaveKey("denim", "normal"), Uint8Array.of(1)]]) });
    assert.deepEqual([partial.sets[0].base, partial.sets[0].normal, partial.sets[0].roughness], [undefined, 0, undefined]);
    near(partial.sets[0].roughnessFactor, 0.85, "no library map: the roughness itself");
    // prints make a material too, their atlas the decal
    const printed = nodes.map((n) => (n.id === "p2" ? { ...n, meta: { atelier: { prints: [{ id: "pr1", image: "cccc", at: [10, 10], rotation_deg: 0, width_mm: 20 }] } } } : n));
    const withAtlas = viewMaterial(printed, { patterns, vertexPatterns }, { library, textures, atlases: new Map([["p2", Uint8Array.of(9)]]) });
    assert.deepEqual(withAtlas.sets[1], { roughnessFactor: 1, decal: 3 });
    assert.equal(withAtlas.textures[3].image[0], 9);
    // no material and no prints anywhere: null (the cloth drawn as before)
    const bare = nodes.map((n) => (n.kind === "garment.fabric" ? { ...n, meta: { atelier: { colour: "#123456" } } } : n));
    assert.equal(viewMaterial(bare, { patterns, vertexPatterns }, { library, textures }), null);
    const onlyPrints = bare.map((n) => (n.id === "p1" ? { ...n, meta: { atelier: { prints: [{ id: "pr1", image: "cccc", at: [0, 0], width_mm: 10 }] } } } : n));
    assert.deepEqual(viewMaterial(onlyPrints, { patterns, vertexPatterns }, {}).sets, [{ roughnessFactor: 1 }, { roughnessFactor: 1 }], "prints alone: a material, the atlas still to come");
}

// ---- the panel -----------------------------------------------------------------------------------
{
    const plain = nodes.find((n) => n.id === "f_plain");
    const f0 = materialFields(plain, { weaves: library });
    assert.deepEqual(f0.map((f) => f.key), ["material.weave"], "no material: the weave select only");
    assert.equal(f0[0].value, NONE);
    assert.deepEqual(f0[0].options.map((o) => o.value), [NONE, "plain", "twill", "denim", "jersey", "rib", "fleece", "satin", "canvas", IMAGES]);
    const denim = nodes.find((n) => n.id === "f_denim");
    const f1 = materialFields(denim, { weaves: library });
    const by = new Map(f1.map((f) => [f.key, f]));
    assert.equal(by.get("material.weave").value, "denim");
    assert.equal(by.get("material.diffuse").value, "Denim (3/1 twill) (library)");
    assert.equal(by.get("material.diffuse.pick").type, "action");
    assert.ok(!by.has("material.diffuse.clear"), "nothing to clear");
    assert.deepEqual(by.get("material.tile").value, [12, 12]);
    assert.match(by.get("material.source").value, /\(estimated\)/, "library values say they are estimated");
    // through props.js: the fabric's own fields, then the Material section
    const all = fieldsFor({ kind: "fabric", id: "f_denim" }, nodes, new Map(), null, { weaves: library, images: { x: { name: "x.png" } } });
    assert.equal(all[0].key, "label");
    assert.ok(all.some((f) => f.key === "material.sheen"));
    assert.ok(all.findIndex((f) => f.key === "material.weave") > all.findIndex((f) => f.key === "density"), "after the physics");
    // a user image shows its name and a clear
    const own = { ...denim, meta: { atelier: { ...denim.meta.atelier, material: { ...denim.meta.atelier.material, maps: { diffuse: "abcd", normal: null, roughness: null } } } } };
    const f2 = new Map(materialFields(own, { weaves: library, images: { abcd: { name: "plaid.png", width: 10, height: 10 } } }).map((f) => [f.key, f]));
    assert.equal(f2.get("material.diffuse").value, "plaid.png");
    assert.ok(f2.has("material.diffuse.clear"));
    assert.ok(isMaterialKey("material.tile") && !isMaterialKey("colour"));
    assert.equal(imageSlotOf("material.normal.pick"), "normal");
    assert.equal(imageSlotOf("material.normal.clear"), null);

    // validation: tile above 0, rotation finite, factors in 0..1
    assert.equal(validateMaterial("material.tile", [10, 12]), null);
    assert.match(validateMaterial("material.tile", [10, 0]), /above 0/);
    assert.match(validateMaterial("material.tile", [10]), /two sizes/);
    assert.equal(validateMaterial("material.rotation", -45), null);
    assert.match(validateMaterial("material.rotation", NaN), /degrees/);
    assert.match(validateMaterial("material.rotation", Infinity), /degrees/);
    for (const k of ["material.roughness", "material.normal_strength", "material.sheen_roughness"]) {
        assert.equal(validateMaterial(k, 0), null); assert.equal(validateMaterial(k, 1), null);
        assert.ok(validateMaterial(k, 1.01)); assert.ok(validateMaterial(k, -0.1)); assert.ok(validateMaterial(k, NaN));
    }
    assert.equal(validateMaterial("material.sheen", "#A0B0C0"), null);
    assert.ok(validateMaterial("material.sheen", "red"));
    assert.ok(validate({ kind: "fabric", id: "f_denim" }, nodes, "material.roughness", 2), "props.js delegates");
    assert.equal(validate({ kind: "fabric", id: "f_denim" }, nodes, "material.weave", "denim"), null);

    // ops: a weave pick fills the tile, the roughness and the sheen; the colour is kept
    const ops = materialOps(nodes, "f_plain", "material.weave", "satin", library);
    assert.equal(ops.length, 1);
    const set = ops[0].fields.meta.atelier;
    assert.equal(set.colour, "#aa0000", "the colour kept");
    assert.deepEqual(set.material, { weave: "satin", maps: { diffuse: null, normal: null, roughness: null }, tile_mm: [8, 8], rotation_deg: 0, roughness: 0.35, normal_strength: 1, sheen: "#606060", sheen_roughness: 0.25 });
    // the same through props.js's opsFor (ctx.weaves)
    assert.deepEqual(opsFor({ kind: "fabric", id: "f_plain" }, nodes, "material.weave", "satin", { weaves: library }), ops);
    // a field edit keeps the rest
    const t = materialOps(nodes, "f_denim", "material.tile", [20, 10])[0].fields.meta.atelier;
    assert.deepEqual(t.material.tile_mm, [20, 10]); assert.equal(t.material.weave, "denim"); assert.equal(t.colour, "#334466");
    assert.equal(materialOps(nodes, "f_denim", "material.sheen", " #ABCDEF ")[0].fields.meta.atelier.material.sheen, "#abcdef");
    assert.throws(() => materialOps(nodes, "f_plain", "material.roughness", 0.5), /choose a weave/);
    assert.throws(() => materialOps(nodes, "f_plain", "material.weave", "velvet", library), /no weave velvet/);
    // "none" removes the material, nothing else
    const none = materialOps(nodes, "f_denim", "material.weave", NONE, library)[0].fields.meta.atelier;
    assert.deepEqual(none, { colour: "#334466" });
    // "Images…" keeps the values and leaves no weave
    const imgs = materialOps(nodes, "f_denim", "material.weave", IMAGES, library)[0].fields.meta.atelier.material;
    assert.equal(imgs.weave, null); assert.deepEqual(imgs.tile_mm, [12, 12]);
    // an image set; its clear drops the image from the document when nothing else names it
    const withImage = materialOps(nodes, "f_denim", "material.diffuse.image", "abcd1234abcd1234");
    assert.equal(withImage[0].fields.meta.atelier.material.maps.diffuse, "abcd1234abcd1234");
    const imaged = nodes.map((n) => (n.id === "f_denim" ? { ...n, ...withImage[0].fields } : n));
    assert.deepEqual([...referencedImages(imaged)], ["abcd1234abcd1234"]);
    const cleared = materialOps(imaged, "f_denim", "material.diffuse.clear", null);
    assert.deepEqual(cleared.slice(1), [{ op: "meta", app: "atelier.image.abcd1234abcd1234", value: null }]);
    assert.equal(cleared[0].fields.meta.atelier.material.maps.diffuse, null);
    // a second fabric naming it keeps it
    const twice = [...imaged, { id: "f2", kind: "garment.fabric", meta: { atelier: { material: { maps: { diffuse: "abcd1234abcd1234" } } } } }];
    assert.equal(materialOps(twice, "f_denim", "material.diffuse.clear", null).length, 1);
    // "none" on the fabric with the image drops it too
    assert.equal(materialOps(imaged, "f_denim", "material.weave", NONE, library).at(-1).value, null);
    assert.deepEqual(unusedImageOps(imaged, []), []);
}

// ---- images -------------------------------------------------------------------------------------
{
    const bytes = Uint8Array.from({ length: 70000 }, (_, i) => (i * 7) & 255);
    assert.deepEqual(fromBase64(toBase64(bytes)), bytes, "base64 round trip (past one chunk)");
    const id = await imageId(Uint8Array.from([1, 2, 3]));
    assert.equal(id, "039058c6f2c0cb49", "the first 16 hex digits of the SHA-256");
    assert.deepEqual(imageOp(id, { name: "a" }), { op: "meta", app: `atelier.image.${id}`, value: { name: "a" } });
    const records = { abcd: { name: "plaid.png", mime: "image/png", width: 4, height: 2, data: "xxxx" } };
    const n2 = [{ id: "f", kind: "garment.fabric", meta: { atelier: { material: { maps: { diffuse: "abcd", normal: "gone" } } } } }];
    assert.deepEqual(imageIndex(n2, (i) => records[i] ?? null), { abcd: { name: "plaid.png", mime: "image/png", width: 4, height: 2 } }, "names without the data; a missing one left out");
    assert.equal(atlasKey("p1"), "atlas:p1");
}
console.log("materials: ok");
