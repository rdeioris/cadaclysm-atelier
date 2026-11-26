// The fabric's material: the Material section of the fabric panel (fields, checks, ops), the
// fabric UVs, the View's material object, and the user images the document carries. Pure (no
// DOM, no kernel) except importImage, which runs in the worker. looks.js gathers the textures
// and hands the result to the engines; prints.js is the Print tool and its atlases.
//
// Where things are saved (the app's own fields: the kernel stores them and ignores them):
// - a fabric's material: the garment.fabric node's meta.atelier.material,
//   { weave: "denim" | null, maps: { diffuse, normal, roughness } (image ids or null),
//     tile_mm: [w, h], rotation_deg, roughness, normal_strength, sheen: "#rrggbb", sheen_roughness };
// - a user image: the document's meta, app key atelier.image.<id>,
//   { name, mime, width, height, data } with `data` base64 and <id> the first 16 hex digits of
//   the image's SHA-256, so a reused image is stored once.
// Library weaves (assets/weaves) are named, never stored: they ship with the app.

export const SLOTS = ["diffuse", "normal", "roughness"];
// The View's map slot for each of the material's maps.
const VIEW_SLOT = { diffuse: "base", normal: "normal", roughness: "roughness" };
const SLOT_LABEL = { diffuse: "Diffuse", normal: "Normal", roughness: "Roughness map" };
export const NONE = "none", IMAGES = "images";
export const IMAGE_APP = "atelier.image.";
// A user image is downscaled to this many pixels a side at most: the View never draws past
// its 1024 layer (textures::MAX_LAYER).
export const MAX_IMAGE_SIDE = 1024;
// The image files the pickers take.
export const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp";
const COLOUR = /^#[0-9a-fA-F]{6}$/;
const EST = "(estimated)";

const find = (nodes, id) => nodes.find((n) => n.id === id);
export const materialOf = (fabric) => fabric?.meta?.atelier?.material ?? null;
export const printsOf = (pattern) => pattern?.meta?.atelier?.prints ?? [];
const emptyMaps = () => ({ diffuse: null, normal: null, roughness: null });
// A material with no weave and no maps yet ("Images…" on a plain fabric): a 100 mm tile, as a
// photographed swatch would be.
export const defaultMaterial = () => ({ weave: null, maps: emptyMaps(), tile_mm: [100, 100], rotation_deg: 0, roughness: 0.8, normal_strength: 1, sheen: "#000000", sheen_roughness: 0.5 });

// ---- the weave library (assets/weaves/weaves.json) ----------------------------------------------
// `fetchText(url)` -> the text (the page and the worker pass their fetch). -> the parsed library.
export async function loadLibrary(fetchText) {
    return JSON.parse(await fetchText(new URL("./assets/weaves/weaves.json", import.meta.url)));
}
// A library tile's URL: assets/weaves/<name>-<slot>.png.
export const weaveUrl = (name, slot) => new URL(`./assets/weaves/${name}-${slot}.png`, import.meta.url);

// ---- the panel ---------------------------------------------------------------------------------
// The Material section's fields for `fabric` (props.js appends them to the fabric's):
// `looks` is { weaves: the library, images: { id: { name, width, height } } }.
export function materialFields(fabric, looks = {}) {
    const lib = looks.weaves?.weaves ?? {};
    const m = materialOf(fabric);
    const weave = { key: "material.weave", label: "Weave", unit: "", type: "select", value: m ? m.weave ?? IMAGES : NONE,
        options: [{ value: NONE, label: "none" }, ...Object.entries(lib).map(([value, w]) => ({ value, label: w.label })), { value: IMAGES, label: "Images…" }],
        tip: "The fabric's texture in 3D: a procedural weave from the library, or your own images (Images…). The fabric colour tints it. none: the plain colour, as before." };
    if (!m) return [weave];
    const fields = [weave];
    for (const slot of SLOTS) {
        const id = m.maps?.[slot] ?? null;
        const shown = id ? looks.images?.[id]?.name ?? id : m.weave && lib[m.weave] ? `${lib[m.weave].label} (library)` : "none";
        fields.push({ key: `material.${slot}`, label: SLOT_LABEL[slot], unit: "", type: "readonly", value: shown });
        fields.push({ key: `material.${slot}.pick`, label: `${SLOT_LABEL[slot]} image…`, unit: "", type: "action", value: null,
            tip: slot === "normal" ? "A tangent-space normal map (OpenGL: green up), PNG or JPEG." : slot === "roughness" ? "A roughness map: its green channel (glTF's layout), PNG or JPEG." : "A colour image, PNG or JPEG: the fabric colour tints it." });
        if (id) fields.push({ key: `material.${slot}.clear`, label: `Clear ${SLOT_LABEL[slot].toLowerCase()}`, unit: "", type: "action", value: null });
    }
    fields.push(
        { key: "material.tile", label: "Tile", unit: "mm", type: "numbers", value: m.tile_mm ?? [100, 100], tip: "The texture's repeat on the cloth: width (across the grain) and height (along it)." },
        { key: "material.rotation", label: "Texture rotation", unit: "deg", type: "number", value: m.rotation_deg ?? 0, tip: "The texture turned against each piece's grain line, counter-clockwise." },
        { key: "material.roughness", label: "Roughness", unit: "", type: "number", value: m.roughness ?? 1,
            tip: "0 (glossy) to 1 (matte). A library weave's roughness map is scaled to it; at most the map's own (1 keeps the map as it is), and your own map is multiplied by it." },
        { key: "material.normal_strength", label: "Normal strength", unit: "", type: "number", value: m.normal_strength ?? 1, tip: "How deep the weave's relief reads, 0 to 1." },
        { key: "material.sheen", label: "Sheen colour", unit: "", type: "colour", value: m.sheen ?? "#000000", tip: "The cloth sheen's colour (#rrggbb): the soft rim glow of fibres. Black: none." },
        { key: "material.sheen_roughness", label: "Sheen roughness", unit: "", type: "number", value: m.sheen_roughness ?? 0.5, tip: "0 a tight rim glow, 1 a broad one." },
    );
    if (m.weave && lib[m.weave]) fields.push({ key: "material.source", label: "Source", unit: "", type: "readonly", value: `${lib[m.weave].label}: procedural tile; tile, roughness and sheen ${EST}` });
    return fields;
}

// Whether a panel key is the Material section's, and whether it asks for an image file.
export const isMaterialKey = (key) => typeof key === "string" && key.startsWith("material.");
export const imageSlotOf = (key) => /^material\.(diffuse|normal|roughness)\.pick$/.exec(key)?.[1] ?? null;

// An error when `value` cannot go into material field `key`, else null.
export function validateMaterial(key, value) {
    const num = (v) => typeof v === "number" && Number.isFinite(v);
    const unit = (v) => num(v) && v >= 0 && v <= 1;
    switch (key) {
        case "material.tile": return Array.isArray(value) && value.length === 2 && value.every((v) => num(v) && v > 0) ? null : "a tile is two sizes above 0 mm (width, height)";
        case "material.rotation": return num(value) ? null : "a rotation is a number of degrees";
        case "material.roughness": return unit(value) ? null : "roughness is from 0 to 1";
        case "material.normal_strength": return unit(value) ? null : "normal strength is from 0 to 1";
        case "material.sheen_roughness": return unit(value) ? null : "sheen roughness is from 0 to 1";
        case "material.sheen": return typeof value === "string" && COLOUR.test(value.trim()) ? null : "a colour is #rrggbb (six hex digits)";
        default: return null;
    }
}

// The ops that set the material field `key` of fabric `fabricId` to `value` (one batch), the
// rest of the node's meta kept (the colour, the slot); an image no fabric or print names any
// longer is removed from the document in the same batch. `library` the weaves (a weave pick
// fills the tile, the roughness and the sheen from it). Keys: material.weave ("none",
// "images" or a weave), material.tile / rotation / roughness / normal_strength / sheen /
// sheen_roughness, material.<slot>.image (an image id) and material.<slot>.clear.
export function materialOps(nodes, fabricId, key, value, library = null) {
    const n = find(nodes, fabricId);
    if (!n || n.kind !== "garment.fabric") throw new Error(`no fabric ${fabricId}`);
    const cur = materialOf(n);
    let next;
    const slot = /^material\.(diffuse|normal|roughness)\.(image|clear)$/.exec(key);
    if (key === "material.weave") {
        if (value === NONE) next = null;
        else if (value === IMAGES) next = { ...(cur ?? defaultMaterial()), weave: null, maps: { ...emptyMaps(), ...(cur?.maps ?? {}) } };
        else {
            const w = library?.weaves?.[value];
            if (!w) throw new Error(`no weave ${value} in the library`);
            next = { ...(cur ?? defaultMaterial()), weave: value, maps: { ...emptyMaps(), ...(cur?.maps ?? {}) },
                tile_mm: [...w.tile_mm], roughness: w.roughness, normal_strength: cur?.normal_strength ?? 1, sheen: w.sheen, sheen_roughness: w.sheen_roughness };
        }
    } else if (slot) {
        next = { ...(cur ?? defaultMaterial()), maps: { ...emptyMaps(), ...(cur?.maps ?? {}), [slot[1]]: slot[2] === "image" ? value : null } };
    } else {
        if (!cur) throw new Error("choose a weave or Images… first");
        const field = { "material.tile": "tile_mm", "material.rotation": "rotation_deg", "material.roughness": "roughness",
            "material.normal_strength": "normal_strength", "material.sheen": "sheen", "material.sheen_roughness": "sheen_roughness" }[key];
        if (!field) throw new Error(`no material field ${key}`);
        next = { ...cur, [field]: field === "sheen" ? value.trim().toLowerCase() : field === "tile_mm" ? [...value] : value };
    }
    const meta = n.meta ?? {}, atelier = { ...(meta.atelier ?? {}) };
    if (next) atelier.material = next; else delete atelier.material;
    const ops = [{ op: "set", id: fabricId, fields: { meta: { ...meta, atelier } } }];
    return [...ops, ...unusedImageOps(nodes, ops)];
}

// ---- the user images in the document ------------------------------------------------------------
// The image ids the nodes name: the fabrics' maps and the pieces' prints.
export function referencedImages(nodes) {
    const ids = new Set();
    for (const n of nodes) {
        if (n.kind === "garment.fabric") for (const id of Object.values(materialOf(n)?.maps ?? {})) if (id) ids.add(id);
        if (n.kind === "garment.pattern") for (const p of printsOf(n)) if (p.image) ids.add(p.image);
    }
    return ids;
}
// `nodes` after the add / set / remove ops of a batch (a set merges its fields, as the kernel does).
export function nodesAfter(nodes, ops) {
    const out = new Map(nodes.map((n) => [n.id, n]));
    for (const o of ops) {
        if (o.op === "add") out.set(o.node.id, o.node);
        else if (o.op === "remove") out.delete(o.id);
        else if (o.op === "set" && out.has(o.id)) out.set(o.id, { ...out.get(o.id), ...o.fields });
    }
    return [...out.values()];
}
// The meta ops removing the images `ops` leave unnamed (an image's last fabric map or print gone).
export function unusedImageOps(nodes, ops) {
    const after = referencedImages(nodesAfter(nodes, ops));
    return [...referencedImages(nodes)].filter((id) => !after.has(id)).map((id) => ({ op: "meta", app: `${IMAGE_APP}${id}`, value: null }));
}
// The meta op storing image `id`: { name, mime, width, height, data } (data base64).
export const imageOp = (id, image) => ({ op: "meta", app: `${IMAGE_APP}${id}`, value: image });

export function toBase64(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
}
export function fromBase64(text) {
    const s = atob(text), out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
}
// The image id: the first 16 hex digits of the bytes' SHA-256.
export async function imageId(bytes) {
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return Array.from(d.subarray(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}
// An image file picked by the user (the worker: createImageBitmap and OffscreenCanvas), at most
// MAX_IMAGE_SIDE a side, re-encoded (PNG; JPEG at 0.9 for a JPEG). -> { id, op, name, width, height }:
// `op` stores it (nothing is committed here).
export async function importImage(bytes, mime, name) {
    const bmp = await createImageBitmap(new Blob([bytes], { type: mime || "application/octet-stream" }));
    try {
        const k = Math.min(1, MAX_IMAGE_SIDE / Math.max(bmp.width, bmp.height));
        const width = Math.max(1, Math.round(bmp.width * k)), height = Math.max(1, Math.round(bmp.height * k));
        const canvas = new OffscreenCanvas(width, height);
        canvas.getContext("2d").drawImage(bmp, 0, 0, width, height);
        const jpeg = /jpe?g/i.test(mime ?? "");
        const blob = await canvas.convertToBlob(jpeg ? { type: "image/jpeg", quality: 0.9 } : { type: "image/png" });
        const data = new Uint8Array(await blob.arrayBuffer());
        const id = await imageId(data);
        const image = { name: name || "image", mime: blob.type, width, height, data: toBase64(data) };
        return { id, op: imageOp(id, image), name: image.name, width, height };
    } finally { bmp.close?.(); }
}
// A reader of the stored images by id, each record parsed once (an id names one content for
// ever): `readMeta(app)` the document's meta (kernel.js Atelier.meta).
export function imageReader(readMeta) {
    const cache = new Map();
    return (id) => {
        if (cache.has(id)) return cache.get(id);
        const r = readMeta(`${IMAGE_APP}${id}`);
        if (r) cache.set(id, r);
        return r ?? null;
    };
}
// The images the nodes name, without their data, for the page (the panel's names, the Print
// tool's aspect): { id: { name, mime, width, height } }. `readImage(id)` -> the stored record or null.
export function imageIndex(nodes, readImage) {
    const out = {};
    for (const id of referencedImages(nodes)) {
        const r = readImage(id);
        if (r) out[id] = { name: r.name, mime: r.mime, width: r.width, height: r.height };
    }
    return out;
}

// ---- the UVs and the View's material -------------------------------------------------------------
// A pattern-space point `local` (mm, from the outline's start) as fabric texture coordinates:
// `g` the unit grain (the warp) and `w` = (g.y, -g.x) the weft, both turned counter-clockwise
// by the texture's rotation; u = local.w / tile_w, v = -local.g / tile_h. The View's v runs
// down the image, so the image's top lies toward the grain's arrow: it reads the right way up.
export function fabricUv(local, grain, tileMm, rotationDeg = 0) {
    const l = Math.hypot(grain[0], grain[1]) || 1;
    const a = (rotationDeg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    const g0 = grain[0] / l, g1 = grain[1] / l;
    const g = [c * g0 - s * g1, s * g0 + c * g1], w = [g[1], -g[0]];
    return [(local[0] * w[0] + local[1] * w[1]) / tileMm[0], -(local[0] * g[0] + local[1] * g[1]) / tileMm[1]];
}
// The outline start of each of `patterns` (pattern node ids) from `nodes`: two numbers a pattern.
export function outlineStarts(nodes, patterns) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const out = new Float64Array(patterns.length * 2);
    patterns.forEach((id, i) => {
        const p = byId.get(id), s = byId.get(p?.outline ?? `${id}_outline`)?.path?.start ?? [0, 0];
        out[2 * i] = s[0]; out[2 * i + 1] = s[1];
    });
    return out;
}
// The fabric UVs, a pair per sim vertex: each vertex's piece-local point (its link, the exact
// pattern position, less its piece's outline start: `starts` from the nodes the cloth was built
// from, so a piece moved in 2D since gives the same UVs) through its fabric's tile and rotation.
export function vertexUvs(links, vertexPatterns, patterns, starts, nodes) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const per = patterns.map((id) => {
        const p = byId.get(id), m = materialOf(byId.get(p?.fabric));
        return { grain: p?.grain ?? [0, 1], tile: m?.tile_mm ?? [100, 100], rot: m?.rotation_deg ?? 0 };
    });
    const out = new Float32Array(vertexPatterns.length * 2);
    for (let v = 0; v < vertexPatterns.length; v++) {
        const p = vertexPatterns[v], q = per[p];
        if (!q) continue;
        const uv = fabricUv([links[2 * v] - starts[2 * p], links[2 * v + 1] - starts[2 * p + 1]], q.grain, q.tile, q.rot);
        out[2 * v] = uv[0]; out[2 * v + 1] = uv[1];
    }
    return out;
}

// A texture's key: a library tile, a user image, a piece's print atlas.
export const weaveKey = (name, slot) => `weave:${name}:${slot}`;
export const imageKey = (id) => `image:${id}`;
export const atlasKey = (pattern) => `atlas:${pattern}`;
// The key of a material's map `slot`: the user's image when set, else the weave's tile, else none.
export const slotKey = (m, slot) => (m?.maps?.[slot] ? imageKey(m.maps[slot]) : m?.weave ? weaveKey(m.weave, slot) : null);
// Every texture key the fabrics of `patterns` need (the atlases aside).
export function textureKeys(nodes, patterns) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const keys = new Set();
    for (const id of patterns) {
        const m = materialOf(byId.get(byId.get(id)?.fabric));
        for (const slot of SLOTS) { const k = slotKey(m, slot); if (k) keys.add(k); }
    }
    return keys;
}

// The View's material ({ textures, groups, sets }) for a cloth of `topology` ({ patterns,
// vertexPatterns }): one set per piece (its fabric's maps; its print atlas as the decal), each
// texture listed once. `assets`: { library (weaves.json), textures: Map key -> image bytes,
// atlases: Map pattern id -> PNG bytes }; a texture not loaded yet is left out of its set.
// A piece whose fabric has no material and no prints gets a set with no maps and roughness 1.
// null when no fabric has a material and no piece has prints: the cloth is drawn as before.
export function viewMaterial(nodes, topology, assets = {}) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const lib = assets.library?.weaves ?? {};
    const textures = [], index = new Map();
    const tex = (key, bytes) => {
        if (!bytes) return undefined;
        if (!index.has(key)) { index.set(key, textures.length); textures.push({ image: bytes }); }
        return index.get(key);
    };
    let any = false;
    const sets = topology.patterns.map((id) => {
        const p = byId.get(id), m = materialOf(byId.get(p?.fabric));
        const set = { roughnessFactor: 1 };
        if (m) {
            any = true;
            for (const slot of SLOTS) {
                const key = slotKey(m, slot), t = key && tex(key, assets.textures?.get(key));
                if (t !== undefined && t !== null) set[VIEW_SLOT[slot]] = t;
            }
            // a library roughness map holds the weave's own roughness: the factor scales it to the field's
            const libMap = set.roughness !== undefined && !m.maps?.roughness && lib[m.weave]?.roughness > 0;
            const r = m.roughness ?? 1;
            set.roughnessFactor = libMap ? Math.min(1, r / lib[m.weave].roughness) : r;
            set.normalStrength = m.normal_strength ?? 1;
            set.sheen = m.sheen ?? "#000000";
            set.sheenRoughness = m.sheen_roughness ?? 0.5;
        }
        if (printsOf(p).length) {
            any = true;
            const t = tex(atlasKey(id), assets.atlases?.get(id));
            if (t !== undefined) set.decal = t;
        }
        return set;
    });
    if (!any) return null;
    return { textures, groups: Uint16Array.from(topology.vertexPatterns), sets };
}
