// The ellipse comes from the kernel (spec §3): four exact conic quarters, read back as a path.
import assert from "node:assert/strict";
import { loadKernel } from "./package.mjs";
import { Atelier } from "../kernel.js";
import * as m from "../model.js";

const k = await loadKernel();
const params = Object.fromEntries(m.FABRIC_FIELDS.map((n) => [n, 1]));
const a = new Atelier(k);
a.reset(m.newDocumentOps({ slug: "x", label: "X", params }));
const path = a.ellipsePath(50, 20, 30, 10);
assert.deepEqual(Object.keys(path).sort(), ["segments", "start"]);
assert.deepEqual(path.start, [80, 20]);
assert.deepEqual(path.segments.map((s) => s.type), ["conic", "conic", "conic", "conic"]);
assert.deepEqual(path.segments[3].to, [80, 20], "closed on its start");
assert.ok(m.isClosedPath(path));
a.apply(m.addPattern(a.nodes(), { label: "Oval", path, fabric: "f_x" }).ops, "oval");
const d = a.drawing("p1");
assert.equal(d.sides.length, 5, "four sides, one a quarter");
assert.deepEqual(d.bounds.map((v) => Math.round(v * 1e6) / 1e6), [20, 10, 80, 30]);
assert.equal(a.ellipseBeziers(0, 0, 5, 5).length, 4 * 16);
assert.throws(() => a.ellipsePath(0, 0, 0, 5), /semi-axis|positive/);
a.free();
console.log("shapes-kernel: ok");
