// Wrapped pieces against the real kernel: arrange.js arrangedPoint (what the 3D window draws
// before Simulate) is the kernel's own arrangement for a long sleeve drawn far along x in 2D, its
// Mirror (the hoodie's left sleeve), and cuffs on each (a wrap on a wrap: the same layer, and two
// layers up with the wrap's radius grown); and wrappedMesh's size on a 150-triangle curved sleeve.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadKernel } from "./package.mjs";
import { Atelier } from "../kernel.js";
import { Drape } from "../cloth.js";
import { avatarMesh } from "../drape.js";
import { presetParams } from "../fabrics.js";
import { arrangedPoint, slotFields, sceneBox, wrappedMesh } from "../arrange.js";
import * as m from "../model.js";

const k = await loadKernel();
const asset = (n) => new URL(`../assets/${n}`, import.meta.url);
const lm = JSON.parse(readFileSync(asset("forms.json"), "utf8")).forms.find((f) => f.name === "f-M-head");
const scene = k.open(new Uint8Array(readFileSync(asset(lm.file))), "step", undefined, "native");
const bounds = sceneBox(scene.vertices(), scene.origin());
const avatar = avatarMesh(scene.vertices(), scene.origin(), scene.indices());
scene.free();

const a = new Atelier(k);
a.apply(m.newDocumentOps({ slug: "cotton_fleece", label: "Fleece", params: presetParams("cotton_fleece") }), "new");
const fabric = "f_cotton_fleece";
const add = (label, points, extra = {}) => { const r = m.addPattern(a.nodes(), { label, path: m.polyPath(points), fabric, ...extra }); a.apply(r.ops, `add ${label}`); return r.id; };

// the hoodie's sleeve (pattern.mjs: hem 220, cap 80, 460 long) where the hoodie draws it, at x 866
const cx = 866, bw = 213.8;
const sleeveR = add("Right sleeve", [[cx - 110, -90], [cx + 110, -90], [cx + bw, 290], [cx, 370], [cx - bw, 290]]);
// Mirror as the tool does it, about x = 1116: the left sleeve lands at x 1366
const sleeveL = (() => {
    const { path } = a.mirroredPiece(sleeveR, [1116, -90, 1116, 310]);
    const r = m.addPattern(a.nodes(), { label: "Left sleeve", path, fabric, grain: [0, 1] });
    a.apply(r.ops, "mirror");
    return r.id;
})();
const cuff = (x0, layer) => add(`Cuff ${x0} ${layer}`, [[x0 - 110, -180], [x0 + 110, -180], [x0 + 110, -110], [x0 - 110, -110]], { layer });
const cuffR = cuff(cx, 0), cuffL = cuff(1366, 2);
const place = (id, slot, host = null) => {
    const byId = m.byId(a.nodes());
    a.apply(m.setPattern(a.nodes(), id, slotFields(byId.get(id), host ? `on:${host}` : slot, bounds, a.drawing(id).bounds, { landmarks: lm, host: host ? byId.get(host) : null })), "slot");
};
place(sleeveR, "right_arm"); place(sleeveL, "left_arm"); place(cuffR, null, sleeveR); place(cuffL, null, sleeveL);
const nodes = m.byId(a.nodes());
assert.equal(nodes.get(cuffL).wrap.radius, nodes.get(sleeveL).wrap.radius + 16, "two layers up: the wrap grown");
assert.ok(Math.min(...a.drawing(sleeveL).bounds.slice(0, 1)) > 1100, "the mirrored sleeve lies past the axis");

const drape = new Drape(k, avatar);
drape.build(a.save());
{
    const pos = drape.positions(), links = k.cadaclysm_blacksmith_cloth_vertex_links(drape.h), topo = drape.topology();
    const worst = new Map();
    topo.vertexPatterns.forEach((pi, v) => {
        const id = topo.patterns[pi], n = nodes.get(id);
        const p = arrangedPoint(n.frame, n.wrap ?? null, links[2 * v], links[2 * v + 1]);
        const e = Math.hypot(p[0] - pos[3 * v], p[1] - pos[3 * v + 1], p[2] - pos[3 * v + 2]);
        worst.set(id, Math.max(worst.get(id) ?? 0, e));
    });
    assert.deepEqual([...worst.keys()].sort(), [sleeveR, sleeveL, cuffR, cuffL].sort(), "every piece built");
    for (const [id, e] of worst) assert.ok(e < 0.01, `${nodes.get(id).label}: arrangedPoint ${e.toFixed(4)} mm off the kernel's arrangement`);
}
drape.free();

// A curved sleeve the kernel fills with 150 triangles (a 150-point cap and the hem: every
// triangle spans the piece, the worst case for an even split). Longest-edge bisection cuts it to
// edges of 15 mm at most within a bound set by its area; one global split count (the first
// version) made 145k triangles of a fill like this.
{
    const pts = [[cx - 110, -90], [cx + 110, -90]];
    for (let i = 0; i < 150; i++) { const t = (Math.PI * i) / 149; pts.push([cx + bw * Math.cos(t), 290 + 80 * Math.sin(t)]); }
    const id = add("Curved sleeve", pts);
    const fill = a.fillOf(id);
    assert.equal(fill.indices.length / 3, 150, "the kernel's fill: 150 triangles");
    let area = 0;
    for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; area += (p[0] * q[1] - q[0] * p[1]) / 2; }
    const f = slotFields(m.byId(a.nodes()).get(id), "right_arm", bounds, a.drawing(id).bounds, { landmarks: lm });
    const w = wrappedMesh(fill, f.frame, f.wrap, 15);
    const tris = w.indices.length / 3;
    // at least the area over a 15 mm right isosceles triangle's (hypotenuse 15), at most 20 x area / 15^2
    assert.ok(tris >= Math.abs(area) / 56.25 && tris <= (20 * Math.abs(area)) / 225, `${tris} triangles for ${Math.abs(area).toFixed(0)} mm2`);
    let longest = 0;
    for (let i = 0; i < w.indices.length; i += 3) for (let j = 0; j < 3; j++) {
        const p = w.indices[i + j], q = w.indices[i + (j + 1) % 3];
        longest = Math.max(longest, Math.hypot(w.uv[2 * p] - w.uv[2 * q], w.uv[2 * p + 1] - w.uv[2 * q + 1]));
    }
    assert.ok(longest <= 15 + 1e-9, `longest 2D edge ${longest}`);
    // conforming: every edge is used by two triangles, or once on the outline
    const uses = new Map();
    for (let i = 0; i < w.indices.length; i += 3) for (let j = 0; j < 3; j++) {
        const p = w.indices[i + j], q = w.indices[i + (j + 1) % 3], key = p < q ? `${p},${q}` : `${q},${p}`;
        uses.set(key, (uses.get(key) ?? 0) + 1);
    }
    assert.ok([...uses.values()].every((n) => n <= 2), "no edge in three triangles");
    // an edge used once lies on the outline: a T-junction inside would leave one used once off it
    const onOutline = (x, y) => pts.some((p, i) => {
        const q = pts[(i + 1) % pts.length], dx = q[0] - p[0], dy = q[1] - p[1], t = Math.max(0, Math.min(1, ((x - p[0]) * dx + (y - p[1]) * dy) / (dx * dx + dy * dy)));
        return Math.hypot(p[0] + t * dx - x, p[1] + t * dy - y) < 1e-3;     // the fill is float32
    });
    const inner = [...uses].filter(([key, n]) => n === 1 && !key.split(",").map(Number).every((v) => onOutline(w.uv[2 * v], w.uv[2 * v + 1])));
    assert.equal(inner.length, 0, `${inner.length} edges used once off the outline (cracks)`);
    console.log(`  curved sleeve: 150 -> ${tris} triangles, ${w.positions.length / 3} vertices`);
}
a.free();
console.log("wrapped-kernel: ok");
