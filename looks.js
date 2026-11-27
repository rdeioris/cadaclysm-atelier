// The View worker's side of the materials: the weave tiles, the user images and the print
// atlases, loaded once and kept, and from them the cloth's look -- the per-vertex UVs and the
// View's material -- for both engines: the GPU cloth's one showCloth / setClothMaterial (sim
// vertices) and the CPU cloth's showMesh / setMeshMaterial per piece (pieceLook).
// Loading is async (a fetch, a decode, a PNG encode); `now` is sync and uses what is loaded,
// so a show never waits: the engines get the full look when `prepare` has run.
import { loadLibrary, textureKeys, viewMaterial, vertexUvs, outlineStarts, weaveUrl, fromBase64, printsOf } from "./materials.js";
import { composeAtlas, pieceBounds, printUvs } from "./prints.js";

export class Looks {
    // io: { fetchBytes(url) -> Uint8Array, readImage(id) -> the stored record or null,
    //       decode(bytes, mime) -> { rgba, width, height }, encode(atlas) -> PNG bytes,
    //       onDecoded() (a print's image is ready for the 2D window) }
    constructor(io) {
        this.io = io;
        this.library = null;
        this.textures = new Map();      // texture key -> image bytes
        this.decoded = new Map();       // image id -> { rgba, width, height }
        this.atlases = new Map();       // pattern id -> { sig, bytes }
        this.pending = new Map();       // a load or a decode under way, by key
    }
    async ensureLibrary() {
        this.library ??= await loadLibrary(async (u) => new TextDecoder().decode(await this.io.fetchBytes(u)));
        return this.library;
    }
    once(key, make) {
        let p = this.pending.get(key);
        if (!p) { p = make().finally(() => this.pending.delete(key)); this.pending.set(key, p); }
        return p;
    }
    // Texture `key`'s bytes: a library tile fetched, a user image read from the document.
    load(key) {
        if (this.textures.has(key)) return Promise.resolve(this.textures.get(key));
        return this.once(key, async () => {
            let bytes = null;
            if (key.startsWith("weave:")) { const [, name, slot] = key.split(":"); bytes = await this.io.fetchBytes(weaveUrl(name, slot)); }
            else if (key.startsWith("image:")) { const r = this.io.readImage(key.slice("image:".length)); bytes = r?.data ? fromBase64(r.data) : null; }
            if (bytes) this.textures.set(key, bytes);
            return bytes;
        });
    }
    // Image `id` decoded (a print's pixels); null when the document has no such image.
    decode(id) {
        if (this.decoded.has(id)) return Promise.resolve(this.decoded.get(id));
        return this.once(`decode:${id}`, async () => {
            const r = this.io.readImage(id);
            if (!r?.data) return null;
            const d = await this.io.decode(fromBase64(r.data), r.mime);
            this.decoded.set(id, d);
            return d;
        });
    }
    // The decoded image now, or null while it decodes (io.onDecoded follows once it is).
    bitmap(id) {
        const d = this.decoded.get(id);
        if (d) return d;
        this.decode(id).then((x) => { if (x) this.io.onDecoded?.(); }).catch(() => {});
        return null;
    }

    // Everything the cloth of `topology` ({ patterns, vertexPatterns, links, starts }) needs
    // for `nodes`: the library, the maps, the decoded prints and each printed piece's atlas
    // (composed again only when its prints or bounds changed). A texture that fails to load
    // is left out (the piece draws without it).
    async prepare(nodes, topology) {
        await this.ensureLibrary();
        await Promise.all([...textureKeys(nodes, topology.patterns)].map((k) => this.load(k).catch(() => null)));
        if (!topology.links) return;
        const starts = topology.starts ?? outlineStarts(nodes, topology.patterns);
        const bounds = pieceBounds(topology.links, topology.vertexPatterns, starts, topology.patterns.length);
        const byId = new Map(nodes.map((n) => [n.id, n]));
        await Promise.all(topology.patterns.map(async (pid, i) => {
            const prints = printsOf(byId.get(pid));
            if (!prints.length || !bounds[i]) { this.atlases.delete(pid); return; }
            await Promise.all(prints.map((p) => this.decode(p.image).catch(() => null)));
            const sig = JSON.stringify([bounds[i], prints, prints.map((p) => this.decoded.has(p.image))]);
            if (this.atlases.get(pid)?.sig === sig) return;
            const bytes = await this.io.encode(composeAtlas(bounds[i], prints, this.decoded));
            this.atlases.set(pid, { sig, bytes });
        }));
    }

    // The cloth's look from what is loaded: { uvs, decalUvs?, material, sig } (a pair or a
    // group a sim vertex), or null when the cloth has no material (drawn as before). `sig`
    // changes with anything the engines draw from it.
    now(nodes, topology) {
        if (!topology?.links || !topology.patterns) return null;
        const starts = topology.starts ?? outlineStarts(nodes, topology.patterns);
        const atlases = new Map(topology.patterns.filter((p) => this.atlases.has(p)).map((p) => [p, this.atlases.get(p).bytes]));
        const material = viewMaterial(nodes, topology, { library: this.library, textures: this.textures, atlases });
        if (!material) return null;
        const byId = new Map(nodes.map((n) => [n.id, n]));
        const look = { uvs: vertexUvs(topology.links, topology.vertexPatterns, topology.patterns, starts, nodes), material };
        if (material.sets.some((s) => s.decal !== undefined)) {
            const bounds = pieceBounds(topology.links, topology.vertexPatterns, starts, topology.patterns.length);
            look.decalUvs = printUvs(topology.links, topology.vertexPatterns, starts, bounds.map((b, i) => (atlases.has(topology.patterns[i]) ? b : null)));
        }
        look.sig = JSON.stringify({
            sets: material.sets, textures: material.textures.map((t) => t.key),
            atlases: topology.patterns.map((p) => this.atlases.get(p)?.sig ?? null),
            uv: topology.patterns.map((p) => { const n = byId.get(p), m = byId.get(n?.fabric)?.meta?.atelier?.material; return [n?.grain ?? null, m?.tile_mm ?? null, m?.rotation_deg ?? null]; }),
        });
        return look;
    }
}

// showMesh / showCloth's options for a look (none for null: drawn as before).
export const lookOptions = (look) => (look ? { uvs: look.uvs, ...(look.decalUvs ? { decalUvs: look.decalUvs } : {}), material: look.material } : {});
// setMeshMaterial / setClothMaterial's object for a look ({ uvs, decalUvs?, textures, groups?, sets }), or null.
export const lookMaterial = (look) => (look ? { uvs: look.uvs, ...(look.decalUvs ? { decalUvs: look.decalUvs } : {}), textures: look.material.textures, ...(look.material.groups ? { groups: look.material.groups } : {}), sets: look.material.sets } : null);

// One CPU piece's look: the cloth's look at its sim vertices `verts` (the mesh's vertex order),
// its one set with only the textures that set names.
export function pieceLook(look, verts) {
    if (!look || !verts.length) return null;
    const n = verts.length, m = look.material;
    const uvs = new Float32Array(2 * n);
    for (let i = 0; i < n; i++) { uvs[2 * i] = look.uvs[2 * verts[i]]; uvs[2 * i + 1] = look.uvs[2 * verts[i] + 1]; }
    const set = { ...m.sets[m.groups?.[verts[0]] ?? 0] };
    const textures = [], index = new Map();
    for (const slot of ["base", "normal", "roughness", "decal"]) {
        if (set[slot] === undefined) continue;
        if (!index.has(set[slot])) { index.set(set[slot], textures.length); textures.push(m.textures[set[slot]]); }
        set[slot] = index.get(set[slot]);
    }
    const out = { uvs, material: { textures, sets: [set] } };
    if (set.decal !== undefined && look.decalUvs) {
        const d = new Float32Array(2 * n);
        for (let i = 0; i < n; i++) { d[2 * i] = look.decalUvs[2 * verts[i]]; d[2 * i + 1] = look.decalUvs[2 * verts[i] + 1]; }
        out.decalUvs = d;
    }
    return out;
}
