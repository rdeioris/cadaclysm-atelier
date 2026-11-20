// Atelier.pieceAt: the piece under a pattern point by the kernel's profile_contains, the
// highest layer first (a later piece over an earlier one of the same layer); a hole is not
// the piece; a point on no piece answers null.
import assert from "node:assert/strict";
import { loadKernel } from "./package.mjs";
import { Atelier } from "../kernel.js";
import * as m from "../model.js";

const k = await loadKernel();
const params = Object.fromEntries(m.FABRIC_FIELDS.map((n) => [n, 1]));
const a = new Atelier(k);
a.reset(m.newDocumentOps({ slug: "x", label: "X", params }));
const hole = m.rectPath(20, 20, 20, 20);
const add = (path, layer) => a.apply(m.addPattern(a.nodes(), { label: `P${a.nodes().length}`, path, fabric: "f_x", layer }).ops, "add");
add({ ...m.rectPath(0, 0, 100, 100), holes: [{ start: hole.start, segments: hole.segments }] }, 2);   // p1, on top
add(m.rectPath(50, 0, 100, 100), 0);                                                                     // p2, under p1 where they overlap
add(m.rectPath(120, 0, 100, 100), 0);                                                                    // p3, over p2 (same layer, later)
assert.equal(a.pieceAt([75, 50]), "p1", "the higher layer");
assert.equal(a.pieceAt([110, 50]), "p2");
assert.equal(a.pieceAt([130, 50]), "p3", "the same layer: the later piece");
assert.equal(a.pieceAt([30, 30]), null, "in p1's hole, on no other piece");
assert.equal(a.pieceAt([100, 50]), "p1", "on p1's outline counts as p1");
assert.equal(a.pieceAt([-10, 50]), null);
a.free();
console.log("pick-kernel: ok");
