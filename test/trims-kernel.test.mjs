// Trims (S3) with the real kernel: the tools' requests checked and written by kernel.js trimOps
// (one commit each, the kernel's refusals passed on), the layout the 2D window draws, a save and
// load, a moved and a mirrored piece's trims, and the cloth: trims set before the first step,
// their vertices following the cloth, a re-mesh keeping them.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadKernel } from "./package.mjs";
import { Atelier } from "../kernel.js";
import { Drape } from "../cloth.js";
import * as T from "../trims.js";
import { TEMPLATE } from "../trimgeo.js";
import * as m from "../model.js";

const k = await loadKernel();
const a = new Atelier(k);
a.load(readFileSync(new URL("../assets/tshirt.json", import.meta.url), "utf8"));
const node = (id) => a.nodes().find((n) => n.id === id);
const front = () => node("p1");
const sides = a.drawings().find((d) => d.id === "p1").sides;
const add = (req, what) => { const before = a.head(); a.commit(a.trimOps(req), what); assert.notEqual(a.head(), before, `${what}: one commit`); };

// the Front's hem stitched, a button and a buttonhole fastened, a zipper on the first side seam
add({ action: "add", id: "p1", record: T.topstitchRecord({ pattern: "p1", loop: 0, from: sides[0], to: sides[1] }) }, "topstitch");
add({ action: "add", id: "p1", record: T.buttonRecord([0, 600]) }, "button");
add({ action: "add", id: "p2", record: T.buttonholeRecord([580, 600]) }, "buttonhole");
add({ action: "fasten", button: { id: "p1", index: 1 }, hole: { id: "p2", index: 0 } }, "fasten");
add({ action: "zipper", seam: "s1", zipper: T.zipperRecord() }, "zipper");
assert.deepEqual(front().trims.map((t) => t.kind), ["topstitch", "button"]);
const tack = a.nodes().find((n) => n.kind === "garment.tack" && n.fastens);
assert.deepEqual([tack.a, tack.a_at, tack.b, tack.b_at, tack.fastens], ["p1", [0, 600], "p2", [580, 600], [1, 0]]);
assert.ok(node("s1").zipper, "the seam has its zipper");
assert.equal(a.issues().filter((i) => i.kind === 21 || i.kind === 22).length, 0, "no trim issues");
console.log("ok - topstitch, button, buttonhole, fastening and zipper written, one commit each");

// the kernel's refusals: nothing written, the fault named
{
    const head = a.head();
    assert.throws(() => a.trimOps({ action: "add", id: "p1", record: T.buttonRecord([5000, 600]) }), /OffPiece/);
    add({ action: "add", id: "p1", record: { ...T.buttonRecord([100, 600]), diameter: 30 } }, "a big button");
    add({ action: "add", id: "p2", record: { ...T.buttonholeRecord([480, 600]), length: 20 } }, "a small hole");
    assert.throws(() => a.trimOps({ action: "fasten", button: { id: "p1", index: 2 }, hole: { id: "p2", index: 1 } }), /HoleTooSmall/);
    assert.throws(() => a.trimOps({ action: "fasten", button: { id: "p1", index: 1 }, hole: { id: "p2", index: 1 } }), /already fastened/);
    assert.throws(() => a.trimOps({ action: "zipper", seam: "s1", zipper: T.zipperRecord() }), /has a zipper/);
    a.undo(); a.undo();
    assert.equal(a.head(), head);
    console.log("ok - refusals: off the piece, a hole too small, already fastened, a second zipper");
}

// the layout the 2D window draws: every instance mapped back to its record
const layout = a.trimLayout();
{
    const by = (f) => layout.instances.filter(f);
    const stitches = by((i) => i.template === TEMPLATE.STITCH);
    assert.ok(stitches.length > 100 && stitches.every((i) => i.ref.kind === "trim" && i.ref.id === "p1" && i.ref.index === 0), `${stitches.length} stitches on the Front's hem`);
    assert.deepEqual(by((i) => i.template === TEMPLATE.BUTTON).map((i) => [i.ref.id, i.ref.index, i.x, i.y]), [["p1", 1, 0, 600]]);
    assert.deepEqual(by((i) => i.template === TEMPLATE.BUTTONHOLE_BAR).map((i) => [i.ref.id, i.ref.index]), [["p2", 0]]);
    const teeth = by((i) => i.template === TEMPLATE.TOOTH);
    assert.ok(teeth.length > 10 && teeth.every((i) => i.ref.kind === "zipper" && i.ref.id === "s1"));
    assert.deepEqual([...new Set(teeth.map((i) => i.pattern))].sort(), ["p1", "p2"], "teeth on both sides of the seam");
    assert.equal(by((i) => i.template === TEMPLATE.SLIDER).length, 1);
    assert.equal(layout.skipped.length, 0);
    assert.equal(a.trimLayout(), layout, "kept until the next evaluation");
    const specs = T.trimSpecs({ layout, drawings: a.drawings(), nodes: a.nodes() });
    assert.deepEqual(specs.map((s) => s.key).sort(), ["trim/p1/0", "trim/p1/1", "trim/p2/0", "zip/s1"]);
    console.log(`ok - the layout: ${stitches.length} stitches, a button, a buttonhole bar, ${teeth.length} teeth, the slider`);
}

// a save and load keeps every trim
{
    const b = new Atelier(k);
    b.load(a.save());
    for (const id of ["p1", "p2", "s1", tack.id]) {
        const x = b.nodes().find((n) => n.id === id), y = node(id);
        assert.deepEqual([x.trims, x.zipper, x.fastens], [y.trims, y.zipper, y.fastens]);
    }
    assert.equal(b.trimLayout().instances.length, layout.instances.length);
    b.free();
    console.log("ok - save and load");
}

// a moved piece takes its button along, a mirrored one keeps its topstitch on the same stretch
{
    const moved = a.transformedPiece("p1", [1, 0, 40, 0, 1, 25]);
    assert.deepEqual(moved.trims[1].at, [40, 625]);
    assert.ok(Math.abs(moved.trims[0].from - sides[0]) < 1e-6 && Math.abs(moved.trims[0].to - sides[1]) < 1e-6, "a translation keeps the arc lengths");
    a.commit(m.pieceOps(a.nodes(), "p1", moved), "move");
    assert.deepEqual(a.nodes().find((n) => n.id === tack.id).a_at, [40, 625], "the fastening's tack end with it");
    const lay = a.trimLayout().instances.filter((i) => i.ref?.id === "p1" && i.template === TEMPLATE.BUTTON);
    assert.deepEqual([lay[0].x, lay[0].y], [40, 625]);
    a.undo();
    // a mirror across x = 0: the hem's stitches still lie along the hem
    const mir = a.transformedPiece("p1", [-1, 0, 0, 0, 1, 0]);
    const b = new Atelier(k);
    b.load(a.save());
    b.commit(m.pieceOps(b.nodes(), "p1", mir), "mirror");
    const hemY = (L) => L.instances.filter((i) => i.ref?.id === "p1" && i.template === TEMPLATE.STITCH).map((i) => i.y);
    const before = hemY(a.trimLayout()), after = hemY(b.trimLayout());
    const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
    assert.ok(Math.abs(mean(before) - mean(after)) < 1, `the mirrored hem's stitches at y ${mean(after).toFixed(1)}, before ${mean(before).toFixed(1)}`);
    assert.ok(Math.abs(after.length - before.length) <= 2);
    b.free();
    console.log("ok - a moved piece's trims; a mirrored piece's topstitch on the same stretch");
}

// the cloth: trims set at build, their mass on the particles, their vertices moving with the cloth
{
    const drape = new Drape(k);
    drape.build(a.save());
    assert.ok(drape.trims, `the trims are set: ${drape.trimNotes.join("; ")}`);
    const mesh = drape.trimMesh();
    const n = k.cadaclysm_blacksmith_cloth_trim_vertex_count(drape.h);
    assert.ok(n > 1000 && mesh.vertices === n && mesh.indices.length % 3 === 0 && Math.max(...mesh.indices) < n);
    assert.equal(mesh.colours.length, 3 * n, "a colour a vertex, from its template");
    assert.ok(mesh.metal && mesh.groups.some((g) => g === 1) && mesh.groups.some((g) => g === 0), "the zipper's teeth metal, the rest plain");
    const v0 = drape.trimVertices();
    assert.equal(v0.length, 6 * n);
    for (let i = 0; i < 6; i++) drape.step();
    const v1 = drape.trimVertices();
    let moved = 0;
    for (let i = 0; i < 3 * n; i++) moved = Math.max(moved, Math.abs(v1[i] - v0[i]));
    assert.ok(moved > 0.01, `the trims move with the cloth (${moved.toFixed(3)} mm)`);
    // an outline edit re-meshes the Front with its trims laid out again
    const path = structuredClone(a.nodes().find((n) => n.id === "p1_outline").path);
    path.segments[1].to = [path.segments[1].to[0] + 5, path.segments[1].to[1]];
    const b = new Atelier(k);
    b.load(a.save());
    b.commit(m.setOutline(b.nodes(), "p1", path), "outline", "p1");
    const r = drape.update(b.save());
    assert.equal(r.kind, "remesh");
    assert.ok(drape.trims && drape.trimMesh().vertices > 1000, `the re-meshed cloth keeps its trims: ${drape.trimNotes.join("; ")}`);
    drape.step();
    assert.equal(drape.trimVertices().length, 6 * drape.trimMesh().vertices);
    // a trim edit makes the cloth stale
    b.commit(T.removeTrimOps(b.nodes(), "p1", 1), "remove button");
    assert.equal(drape.update(b.save()).kind, "stale");
    b.free();
    drape.free();
    console.log(`ok - the cloth: ${n} trim vertices set before the first step, moving ${moved.toFixed(2)} mm in 6 frames, kept through a re-mesh`);
}
// a cloth without trims has none to draw
{
    const plain = new Atelier(k);
    plain.load(readFileSync(new URL("../assets/tshirt.json", import.meta.url), "utf8"));
    const drape = new Drape(k);
    drape.build(plain.save());
    assert.equal(drape.trims, null);
    assert.equal(drape.trimMesh(), null);
    assert.equal(drape.trimVertices(), null);
    drape.free(); plain.free();
    console.log("ok - no trims, nothing drawn");
}
a.free();
