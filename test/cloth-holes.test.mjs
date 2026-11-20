// A piece's holes reach the cloth: the sim mesh leaves each hole empty, both when the cloth is
// built on a holed piece and when a hole is added to a live cloth's piece (a re-mesh). The
// kernel's mesher honours outline.holes; this checks the app passes them through (kernel.js
// save -> cloth.js open / update -> cloth_new / cloth_remesh_pattern).
import assert from "node:assert/strict";
import { loadKernel } from "./package.mjs";
import { Atelier } from "../kernel.js";
import { Drape } from "../cloth.js";
import * as m from "../model.js";

const k = await loadKernel();
const params = Object.fromEntries(m.FABRIC_FIELDS.map((n) => [n, 1]));
const a = new Atelier(k);
a.reset(m.newDocumentOps({ slug: "x", label: "X", params }));
a.apply(m.addPattern(a.nodes(), { label: "Front", path: m.rectPath(0, 0, 200, 100), fabric: "f_x", allowance: 10 }).ops, "piece");

// test-side membership, against the hole shapes as drawn (no app geometry involved)
const inRect = ([x, y]) => x > 30 && x < 70 && y > 30 && y < 70;
const inEllipse = ([x, y]) => ((x - 150) / 30) ** 2 + ((y - 50) / 20) ** 2 < 1;
// every sim triangle's centroid on its pattern (cloth_vertex_links: (u, v) in mm per vertex)
function centroids(drape) {
    const tris = drape.f("cloth_triangles")(drape.h), uv = drape.f("cloth_vertex_links")(drape.h);
    const out = [];
    for (let t = 0; t + 2 < tris.length; t += 3) {
        const [i, j, l] = [tris[t], tris[t + 1], tris[t + 2]];
        out.push([(uv[2 * i] + uv[2 * j] + uv[2 * l]) / 3, (uv[2 * i + 1] + uv[2 * j + 1] + uv[2 * l + 1]) / 3]);
    }
    return out;
}
function check(drape, holes, what) {
    const c = centroids(drape);
    assert.ok(c.length > 50, `${what}: the piece is meshed (${c.length} triangles)`);
    assert.ok(c.every(([x, y]) => x > -1e-6 && x < 200 + 1e-6 && y > -1e-6 && y < 100 + 1e-6), `${what}: links are pattern mm`);
    for (const [name, inside] of holes) {
        const bad = c.filter(inside);
        assert.equal(bad.length, 0, `${what}: ${bad.length} triangle centroids inside the ${name} hole, e.g. ${JSON.stringify(bad[0])}`);
    }
    // the material around the holes is meshed: some centroid lies just outside each
    assert.ok(c.some(([x, y]) => x > 70 && x < 80 && y > 40 && y < 60), `${what}: material beside the rectangle hole`);
}

// a live cloth on the plain piece: material where the hole will be
const drape = new Drape(k, null);
drape.build(a.save());
assert.ok(centroids(drape).some(inRect), "the plain piece is meshed where the hole goes");

// a rectangle hole added: the live cloth re-meshes the piece without it
a.apply(m.addHole(a.nodes(), "p1", m.rectPath(30, 30, 40, 40)), "hole");
const r = drape.update(a.save());
assert.equal(r.remeshed, true, JSON.stringify(r));
check(drape, [["rectangle", inRect]], "re-meshed");

// an ellipse hole from the kernel, then a fresh cloth on the twice-holed piece
a.apply(m.addHole(a.nodes(), "p1", a.ellipsePath(150, 50, 30, 20)), "hole");
const fresh = new Drape(k, null);
fresh.build(a.save());
check(fresh, [["rectangle", inRect], ["ellipse", inEllipse]], "built");
drape.free?.(); fresh.free?.();
a.free();
console.log("cloth-holes: ok -- a built and a re-meshed cloth leave the holes empty");
