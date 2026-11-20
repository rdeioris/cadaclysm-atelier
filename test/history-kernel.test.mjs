// New, Open and Sample start a fresh history (spec, Decisions: "Kernel document"): the kernel's
// document_clear_history, so the first undo never empties the document, with no undo floor here.
import assert from "node:assert/strict";
import { loadKernel } from "./package.mjs";
import { Atelier } from "../kernel.js";
import * as m from "../model.js";

const k = await loadKernel();
const params = Object.fromEntries(m.FABRIC_FIELDS.map((n) => [n, 1]));
const rect = (a, label, x) => a.apply(m.addPattern(a.nodes(), { label, path: m.rectPath(x, 0, 100, 50), fabric: "f_x" }).ops, "rect");

const a = new Atelier(k);
a.reset(m.newDocumentOps({ slug: "x", label: "X", params }));
assert.equal(a.head(), "c0", "New: a fresh history");
assert.equal(a.undo(), false, "nothing to take back after New");
assert.equal(a.nodes().filter((n) => n.kind === "garment.fabric").length, 1, "the fabric stays");
rect(a, "A", 0);
assert.equal(a.head(), "c1");
assert.equal(a.undo(), true);
assert.equal(a.head(), "c0");
assert.equal(a.undo(), false);
assert.equal(a.redo(), undefined);
assert.equal(a.head(), "c1", "redo puts the rectangle back");

rect(a, "B", 200);
const text = a.save();
const b = new Atelier(k);
b.load(text);
assert.equal(b.head(), "c0", "Open: the file's history is not the user's");
assert.equal(b.undo(), false);
assert.deepEqual(b.nodes().map((n) => n.id), a.nodes().map((n) => n.id));
assert.equal(JSON.parse(b.save()).version, 3, "a saved, cleared document is format version 3");
a.free(); b.free();
console.log("history-kernel: ok");
