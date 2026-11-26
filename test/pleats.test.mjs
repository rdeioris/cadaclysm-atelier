// pleats.js (S2 spec §5), pure: a pleat set's spec from the Pleat tool's two drags, its numbers,
// pleat groups in the document, the panel's dart and pleat rows and the requests they make, and
// the Pleat and Rotate… gestures.
import assert from "node:assert/strict";
import { pleatDraft, pleatSpec, draftOfSpec, pleatFields, pleatValidate, draftWith, groupOfLine, linesWith, s2Fields, s2Request,
    isS2Key, intakeOf, S2_TOOLS, S2_SNAPPING } from "../pleats.js";
import { simFields } from "../simprops.js";
import { makeTool, SNAPPING } from "../tools.js";

const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

// ---- the spec from two drags ----
{
    assert.equal(intakeOf("knife", 20), 40);
    assert.equal(intakeOf("box", 20), 80);
    // a vertical line, a drag 240 mm to the right: knife pleats 20 deep, as many as leave as much flat as they take in
    const d = pleatDraft([[0, 0], [0, 300]], [[10, 100], [250, 120]]);
    assert.equal(d.area, 240, "only the extent across the line counts");
    assert.deepEqual(d.normal, [1, -0], "toward the drag");
    assert.equal(d.count, 3); assert.equal(d.depth, 20); assert.equal(d.kind, "knife"); assert.equal(d.direction, "right"); assert.equal(d.top_tack, true);
    const s = pleatSpec(d);
    assert.deepEqual(s.line, [[0, 0], [0, 300]]);
    assert.deepEqual(s.across, [[0, 0], [120, 0]], "the finished width: 240 less 3 × 40 intake, from the line's start");
    assert.deepEqual({ count: s.count, depth: s.depth, kind: s.kind, direction: s.direction, top_tack: s.top_tack }, { count: 3, depth: 20, kind: "knife", direction: "right", top_tack: true });
    // leftward: the normal flips; the numbers last chosen carry over
    const l = pleatDraft([[0, 0], [0, 300]], [[0, 50], [-100, 50]], { depth: 10, kind: "box", top_tack: false });
    assert.ok(near(l.normal[0], -1) && near(l.normal[1], 0));
    assert.equal(l.count, 1, "100 mm: one 40 mm box pleat");
    assert.deepEqual(pleatSpec(l).across, [[0, 0], [-60, 0]]);
    // a drag along the line, or a line of no length: nothing
    assert.equal(pleatDraft([[0, 0], [0, 300]], [[0, 0], [0, 100]]), null);
    assert.equal(pleatDraft([[5, 5], [5, 5]], [[0, 0], [100, 0]]), null);
    // a tiny area: at least one pleat, and a spec refused while the intake fills it
    const tiny = pleatDraft([[0, 0], [0, 300]], [[0, 0], [30, 0]]);
    assert.equal(tiny.count, 1);
    assert.throws(() => pleatSpec(tiny), /take in 40 mm, as much as the 30 mm/);
    // a stored spec as a draft: the same area, so a new count keeps the stretch
    const back = draftOfSpec(s);
    assert.ok(near(back.area, 240));
    assert.deepEqual(pleatSpec(draftWith(back, "count", 2)).across, [[0, 0], [160, 0]]);
    assert.deepEqual(pleatSpec(back), s, "a spec round-trips");
}

// ---- the numbers ----
{
    const d = pleatDraft([[0, 0], [0, 300]], [[0, 0], [240, 0]]);
    assert.deepEqual(pleatFields(d).map((f) => f.key), ["count", "depth", "kind", "direction", "top_tack", "area"]);
    assert.deepEqual(pleatFields(d, "pleat_").map((f) => f.key), ["pleat_count", "pleat_depth", "pleat_kind", "pleat_direction", "pleat_top_tack", "pleat_area"]);
    assert.equal(pleatFields(d).find((f) => f.key === "top_tack").value, "true");
    assert.equal(pleatValidate("count", 2.5), "pleats: a whole number from 1 to 200");
    assert.equal(pleatValidate("count", 0) !== null, true);
    assert.equal(pleatValidate("depth", -1) !== null, true);
    assert.equal(pleatValidate("kind", "accordion"), "a pleat is knife or box");
    assert.equal(pleatValidate("direction", "up"), "a pleat faces left or right");
    assert.equal(pleatValidate("depth", 12), null);
    assert.equal(draftWith(d, "top_tack", "false").top_tack, false);
    assert.equal(draftWith(d, "kind", "box").kind, "box");
    assert.equal(draftWith(d, "area", 9), d, "the area is the drag's, not a field");
}

// ---- groups in the document, the panel's rows, the requests ----
const spec = pleatSpec(pleatDraft([[20, 300], [20, 0]], [[20, 100], [180, 100]]));
const line = (kind, extra = {}) => ({ kind, path: { start: [0, 0], segments: [{ type: "line", to: [0, 9] }] }, ...extra });
const piece = { id: "p1", kind: "garment.pattern", label: "Skirt", internal: [line("dart"), line("fold", { prefold: true }), line("fold", { prefold: true }), line("line")],
    pleats: [{ spec, internal: [1, 2], tacks: ["t1"] }] };
const nodes = [piece];
{
    assert.equal(groupOfLine(piece, 2), 0);
    assert.equal(groupOfLine(piece, 0), -1);
    assert.equal(groupOfLine({}, 0), -1);
    assert.deepEqual(linesWith(piece, 1), [1, 2]);
    assert.deepEqual(linesWith(piece, 3), [3]);
    // a dart: its line rows plus Close (cut), Close (fold), Rotate…
    const dartRows = simFields({ kind: "internal", id: "p1", index: 0 }, piece, nodes).map((f) => f.key);
    assert.deepEqual(dartRows.filter(isS2Key), ["dart_cut", "dart_fold", "dart_rotate"]);
    assert.ok(dartRows.includes("line_kind") && dartRows.at(-1) === "remove");
    // a pleat line: the group's numbers in place of the line's
    const pleatRows = simFields({ kind: "internal", id: "p1", index: 2 }, piece, nodes).map((f) => f.key);
    assert.deepEqual(pleatRows, ["pleat_count", "pleat_depth", "pleat_kind", "pleat_direction", "pleat_top_tack", "pleat_area", "pleat_remove"]);
    assert.equal(s2Fields(piece, 3), null, "a plain line has none");
    assert.equal(s2Fields(piece, 9), null);
    // requests
    const sel = (index) => ({ kind: "internal", id: "p1", index });
    assert.deepEqual(s2Request(sel(0), nodes, "dart_cut", null), { kind: "dart", id: "p1", index: 0, action: "cut" });
    assert.deepEqual(s2Request(sel(0), nodes, "dart_fold", null), { kind: "dart", id: "p1", index: 0, action: "fold" });
    assert.deepEqual(s2Request(sel(0), nodes, "dart_rotate", null), { rotate: { id: "p1", index: 0 } });
    assert.deepEqual(s2Request(sel(1), nodes, "pleat_remove", null), { kind: "pleat", action: "remove", id: "p1", group: 0 });
    const edit = s2Request(sel(2), nodes, "pleat_depth", 10);
    assert.equal(edit.action, "edit"); assert.equal(edit.group, 0); assert.equal(edit.spec.depth, 10); assert.equal(edit.spec.count, spec.count);
    assert.deepEqual(s2Request(sel(2), nodes, "pleat_count", 0), { error: "pleats: a whole number from 1 to 200" });
    assert.match(s2Request(sel(2), nodes, "pleat_count", 4).error, /take in/, "four pleats fill the area");
    assert.deepEqual(s2Request(sel(3), nodes, "pleat_remove", null), { error: "that line is not in a pleat group" });
    assert.deepEqual(s2Request(sel(7), nodes, "dart_cut", null), { error: "that line is gone" });
    assert.equal(s2Request(sel(0), nodes, "angle", 90), null, "not one of these");
    assert.equal(s2Request({ kind: "pattern", id: "p1" }, nodes, "dart_cut", null), null);
}

// ---- the Pleat tool: two drags, the panel, Enter; Escape; a click and a drag along refused ----
{
    assert.ok(SNAPPING.has("pleat") && S2_SNAPPING.includes("pleat"));
    const pleatNext = {};
    const ctx = { nodes, selection: null, pxToWorld: 1, pleatNext };
    const t = makeTool("pleat", ctx);
    const hit = { kind: "pattern", id: "p1" };
    const dragOn = (a, b, h = hit) => { t.down(a, h, {}); t.move(b, h, {}); return t.up(b, h, {}); };
    assert.match(t.down([0, 0], null, {}).status, /on a piece/, "the line starts on a piece");
    t.up([0, 0], null, {});
    assert.match(dragOn([20, 300], [20, 300.5]).status, /drag the placement line/, "a click is not a line");
    let r = dragOn([20, 300], [20, 0]);
    assert.deepEqual(r.overlay.lines, [[[20, 300], [20, 0]]]);
    assert.equal(t.draft(), null);
    t.down([20, 100], hit, {});
    assert.equal(t.move([100, 100], hit, {}).overlay.lines.length, 2, "the line and the drag across drawn");
    r = t.up([20, 50], hit, {});
    assert.match(r.status, /across the line, not along it/);
    r = dragOn([20, 100], [180, 100]);
    assert.equal(r.panel, true);
    assert.deepEqual(r.pleatPreview, { id: "p1", spec }, "the kernel previews the spec");
    assert.equal(t.draft().id, "p1"); assert.equal(t.draft().count, 2);
    assert.deepEqual(dragOn([0, 0], [50, 50]), {}, "drags are ignored while the panel is up");
    assert.deepEqual(t.move([60, 60], hit, {}), {}, "and hovers draw nothing over the preview");
    r = t.set("depth", 10);
    assert.equal(r.pleatPreview.spec.depth, 10);
    r = t.set("count", 0);
    assert.match(r.status, /whole number/);
    assert.equal(r.pleatPreview, undefined, "a refused value keeps the last frame");
    r = t.set("count", 9);
    assert.match(r.status, /take in/);
    assert.equal(t.draft().count, 9, "kept, so a smaller depth can follow");
    t.set("count", 3);
    r = t.key("Enter");
    assert.equal(r.cancel, true, "the preview dropped before the commit");
    assert.deepEqual(r.pleat, { action: "add", id: "p1", spec: pleatSpec({ ...draftOfSpec(spec), count: 3, depth: 10 }) });
    assert.equal(r.done, true);
    assert.deepEqual(r.select, { kind: "pattern", id: "p1" });
    assert.deepEqual(pleatNext, { depth: 10, kind: "knife", direction: "right", top_tack: true }, "the numbers kept for the next set");
    assert.equal(t.draft(), null);
    // the next set starts from them
    const t2 = makeTool("pleat", ctx);
    t2.down([20, 300], hit, {}); t2.up([20, 0], hit, {});
    t2.down([20, 100], hit, {});
    assert.equal(t2.up([180, 100], hit, {}).pleatPreview.spec.depth, 10);
    assert.deepEqual(t2.key("Escape"), { cancel: true, overlay: { lines: [] }, panel: true, done: true });
    assert.equal(t2.draft(), null);
    // the selected piece when the line starts off any (a notch hit reads as its piece)
    const t3 = makeTool("pleat", { ...ctx, selection: { kind: "pattern", id: "p1" } });
    t3.down([20, 300], null, {}); t3.up([20, 0], null, {});
    t3.down([20, 100], { kind: "notch", id: "p1", index: 0 }, {});
    assert.equal(t3.up([180, 100], null, {}).pleatPreview.id, "p1");
    assert.deepEqual(t3.key("Enter").pleat.id, "p1");
}

// ---- Rotate…: hover previews (throttled), the click rotates, Escape drops it ----
{
    assert.ok(S2_TOOLS["dart-rotate"]);
    const t = makeTool("dart-rotate", { nodes, pxToWorld: 0.5, rotateDart: { id: "p1", index: 0 } });
    assert.deepEqual(t.move([10, 0], null, {}), { dartPreview: { id: "p1", index: 0, at: [10, 0], tol: 6 } });
    assert.deepEqual(t.move([10.5, 0], null, {}), {}, "under 2 px: no new frame");
    assert.equal(t.move([12, 0], null, {}).dartPreview.at[0], 12);
    const r = t.up([12, 0], null, {});
    assert.deepEqual(r, { cancel: true, dart: { action: "rotate", id: "p1", index: 0, at: [12, 0], tol: 6 }, done: true, select: { kind: "pattern", id: "p1" } });
    assert.deepEqual(t.key("Escape"), { cancel: true, overlay: { lines: [] }, done: true, status: "rotate: cancelled", error: false });
    const none = makeTool("dart-rotate", { nodes, pxToWorld: 1 });
    assert.match(none.down([0, 0], null, {}).status, /select a dart/);
    assert.deepEqual(none.move([0, 0], null, {}), {});
}
console.log("pleats: ok");
