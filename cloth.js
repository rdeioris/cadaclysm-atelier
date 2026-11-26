// The kernel side of the live drape: one cloth (cadaclysm_blacksmith_cloth_*) on its own copy
// of the garment document. The cloth worker drives it; Node tests it. It never touches the
// View: positions, triangles and status come out as plain typed arrays.
import { garmentChange, sewingDone, healthOf, frameOps, frozenChanges, optionsChanged } from "./drape.js";
import { outlineStarts } from "./materials.js";

const batch = (ops) => JSON.stringify({ op: "batch", ops });

export class Drape {
    // `avatar`: { positions (xyz, mm), indices } or null (no collider).
    constructor(k, avatar = null) {
        this.k = k;
        this.f = (n) => k[`cadaclysm_blacksmith_${n}`];
        this.avatar = avatar;
        this.d = 0; this.g = 0; this.h = 0;
        this.nodes = [];
        this.phase = "sewing";
        this.stale = null;          // why the cloth no longer matches the garment, or null
        this.pins = new Map();      // sim vertex -> its link [pattern, u, v]: found again after a remesh
        this.offsets = new Map();   // pattern id -> [dx, dy] it moved in 2D since the cloth was built
        this.gravity = null;
        this.user = null;           // the garment's options (its saved ones over the defaults): 20 doubles
    }

    // A document from its saved text, with a preview's ops on top (a 2D drag under way),
    // evaluated. -> { d, g, nodes }; throws when it holds no garment.
    open(text, ops) {
        const d = this.f("document_load")(text);
        try {
            if (ops?.length) { this.f("document_preview_begin")(d); this.f("document_preview")(d, batch(ops)); }
            this.f("document_evaluate")(d, false);
            const nodes = JSON.parse(this.f("document_nodes")(d));
            if (!nodes.some((n) => n.id === "garment") || this.f("document_result_kind")(d, "garment") !== "garment")
                throw new Error("no garment to simulate: draw a piece first");
            const g = this.f("document_result_garment")(d, "garment");
            return { d, g, nodes };
        } catch (e) { this.f("document_free")(d); throw e; }
    }
    swap({ d, g, nodes }) {
        if (this.g) this.f("garment_free")(this.g);
        if (this.d) this.f("document_free")(this.d);
        Object.assign(this, { d, g, nodes });
    }

    // The options the garment `g` saves (garment_sim_options: NaN where unset) over the defaults.
    savedOptions(g) {
        const def = this.f("cloth_default_options")(), saved = this.f("garment_sim_options")(g);
        return Float64Array.from(def, (d, i) => (Number.isNaN(saved[i]) ? d : saved[i]));
    }
    // What the cloth runs with: the garment's options, gravity off while sewing.
    effective() {
        const o = Float64Array.from(this.user);
        if (this.phase === "sewing") o[4] = o[5] = o[6] = 0;
        return o;
    }
    pushOptions() { this.f("cloth_set_options")(this.h, this.effective()); }
    // The garment's options again (a live edit of the saved ones), on top of the phase's.
    takeOptions() {
        this.user = this.savedOptions(this.g);
        this.gravity = this.user.slice(4, 7);
        this.pushOptions();
    }

    // A new cloth on the garment in `text` (+ preview `ops`), with its saved options and pins,
    // sewing with gravity off.
    build(text, ops = null) {
        const doc = this.open(text, ops);
        this.user = this.savedOptions(doc.g);
        const opts = Float64Array.from(this.user);
        this.gravity = opts.slice(4, 7);
        opts[4] = opts[5] = opts[6] = 0;
        let h;
        try {
            const a = this.avatar;
            h = this.f("cloth_new")(doc.g, a ? Float64Array.from(a.positions) : new Float64Array(0), a ? Uint32Array.from(a.indices) : new Uint32Array(0), opts);
        } catch (e) { this.f("garment_free")(doc.g); this.f("document_free")(doc.d); throw e; }
        this.freeCloth();
        this.swap(doc);
        this.h = h;
        this.phase = "sewing";
        this.stale = null;
        this.pins.clear();
        this.offsets.clear();
        this.savedPins();
        this.maybeDrape();
    }
    get live() { return this.h !== 0; }

    // Gravity on once sewing is done (see sewingDone).
    maybeDrape() {
        if (this.phase !== "sewing" || !sewingDone(this.status())) return false;
        this.phase = "draping";
        this.pushOptions();
        return true;
    }

    // One frame. -> the health of the new state ({text, warn, stop}).
    step() {
        this.f("cloth_step")(this.h, 1);
        this.maybeDrape();
        return healthOf(this.status(), this.phase);
    }
    status() { return Float64Array.from(this.f("cloth_status")(this.h)); }
    positions() { return this.f("cloth_positions")(this.h); }
    // What the View needs to draw the cloth: triangles, each vertex's pattern node id index into
    // `patterns`, and the pattern node ids; for the materials (materials.js), each vertex's exact
    // pattern position (`links`, two a vertex, mm) and each pattern's outline start in the nodes
    // the cloth was built from (`starts`, two a pattern): link - start is the vertex's place on
    // its piece, wherever the piece has moved in 2D since.
    topology() {
        const ids = this.patternIds();             // kernel pattern id -> node id
        const patterns = [...new Set(ids.values())];
        const index = new Map(patterns.map((p, i) => [p, i]));
        const vp = this.f("cloth_vertex_patterns")(this.h);
        const vertexPatterns = Uint32Array.from(vp, (p) => index.get(ids.get(p)) ?? 0);
        const links = Float64Array.from(this.f("cloth_vertex_links")(this.h));
        return { triangles: Uint32Array.from(this.f("cloth_triangles")(this.h)), vertexPatterns, patterns, links, starts: outlineStarts(this.nodes, patterns) };
    }
    patternIds() {
        const order = this.nodes.find((n) => n.id === "garment")?.patterns ?? [];
        const kernel = this.f("garment_patterns")(this.g);
        return new Map(order.map((id, i) => [kernel[i], id]));
    }
    kernelPattern(id) {
        for (const [k, n] of this.patternIds()) if (n === id) return k;
        throw new Error(`no pattern ${id}`);
    }

    // The garment changed: re-mesh what an outline edit touched (keeping the drape), or mark
    // the cloth stale. -> the change ({kind, patterns?, why?}) and whether the mesh changed.
    update(text, ops = null) {
        if (!this.live) return { kind: "same", remeshed: false };
        // a piece moved in 2D keeps its cloth: its outline goes back into the cloth's frame
        let doc = this.open(text, ops);
        const fix = frameOps(this.nodes, doc.nodes, this.offsets);
        if (fix.length) {
            this.f("garment_free")(doc.g); this.f("document_free")(doc.d);
            doc = this.open(text, [...(ops ?? []), ...fix]);
        }
        const change = garmentChange(this.nodes, doc.nodes);
        if (change.kind === "stale") {
            this.f("garment_free")(doc.g); this.f("document_free")(doc.d);
            this.stale = change.why;
            return { ...change, remeshed: false };
        }
        const freezes = frozenChanges(this.nodes, doc.nodes), options = optionsChanged(this.nodes, doc.nodes);
        this.swap(doc);
        // a re-meshed cloth is shown afresh from the kernel's (gpu-drape.js): its live edits go
        // straight to the kernel cloth too
        this.direct = change.kind === "remesh";
        try {
            if (change.kind === "remesh") {
                try {
                    for (const id of change.patterns) this.f("cloth_remesh_pattern")(this.h, this.g, this.kernelPattern(id));
                } catch (e) {
                    this.stale = `re-mesh refused: ${e.message ?? e}`;
                    throw e;
                } finally { this.refindPins(); this.savedPins(); }
            }
            // the live edits: Freeze, and the saved options
            for (const { id, on } of freezes) this.freeze(this.kernelPattern(id), on);
            if (options) this.takeOptions();
        } finally { this.direct = false; }
        return { ...change, remeshed: change.kind === "remesh" };
    }
    // Freeze (on) or unfreeze kernel pattern `p`.
    freeze(p, on) { this.f("cloth_freeze")(this.h, p, on); }

    // The garment's saved pins (the kernel pinned them when it built or re-meshed the cloth) in
    // the pin map: each the vertex of its piece whose link lies nearest the saved point.
    savedPins() {
        const saved = this.f("garment_pins")(this.g);
        if (!saved.length) return;
        const links = this.f("cloth_vertex_links")(this.h), vp = this.f("cloth_vertex_patterns")(this.h);
        for (let i = 0; i + 2 < saved.length; i += 3) {
            let best = -1, bestD = Infinity;
            for (let v = 0; v < vp.length; v++) {
                if (vp[v] !== saved[i]) continue;
                const d = Math.hypot(links[2 * v] - saved[i + 1], links[2 * v + 1] - saved[i + 2]);
                if (d < bestD) { bestD = d; best = v; }
            }
            if (best >= 0 && !this.pins.has(best)) this.pins.set(best, [vp[best], links[2 * best], links[2 * best + 1]]);
        }
    }
    // Vertex `v`'s place on its piece as the document has it: {pattern (node id), at: [u, v]}
    // (the link in the cloth's frame, moved by what the piece has moved in 2D since).
    pinPlace(v) {
        const [p, u, w] = this.f("cloth_vertex_link")(this.h, v);
        const id = this.patternIds().get(p);
        const off = this.offsets.get(id) ?? [0, 0];
        return id === undefined ? null : { pattern: id, at: [u + off[0], w + off[1]] };
    }

    // Pins kept by the kernel through a remesh are on unchanged patterns, whose vertices keep
    // their exact links: find each again by its link (a re-meshed pattern's pins are dropped).
    refindPins() {
        if (!this.pins.size) return;
        const links = this.f("cloth_vertex_links")(this.h), vp = this.f("cloth_vertex_patterns")(this.h);
        const at = new Map();
        for (let v = 0; v < vp.length; v++) at.set(`${vp[v]}:${links[2 * v]}:${links[2 * v + 1]}`, v);
        const next = new Map();
        for (const [, l] of this.pins) { const v = at.get(`${l[0]}:${l[1]}:${l[2]}`); if (v !== undefined) next.set(v, l); }
        this.pins = next;
    }

    // Pin `v` where it is, or unpin it when it is pinned. -> true when it is now pinned.
    togglePin(v) {
        if (this.pins.has(v)) { this.f("cloth_unpin")(this.h, v); this.pins.delete(v); return false; }
        this.f("cloth_pin")(this.h, v, undefined);
        this.pins.set(v, Array.from(this.f("cloth_vertex_link")(this.h, v)));
        return true;
    }
    // The pinned vertices' positions, xyz triples.
    pinPositions(positions = this.positions()) {
        const out = new Float32Array(this.pins.size * 3);
        let i = 0;
        for (const v of this.pins.keys()) { out.set(positions.subarray(3 * v, 3 * v + 3), i); i += 3; }
        return out;
    }
    // Pull `v` towards `target` (xyz, mm); null lets go.
    drag(v, target) { this.f("cloth_drag")(this.h, v, target ? Float64Array.from(target) : undefined); }

    freeCloth() { if (this.h) { this.f("cloth_free")(this.h); this.h = 0; } this.pins.clear(); }
    free() { this.freeCloth(); this.swap({ d: 0, g: 0, nodes: [] }); }
}
