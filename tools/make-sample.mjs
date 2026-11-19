// Writes assets/tshirt.json, the T-shirt sample: front, back and two sleeves in cotton jersey,
// sewn at the shoulders, sides, armholes and underarms, each piece on its slot around the f-M
// dress form. The document goes through the kernel (Atelier.save()), so it is always valid.
//
//     node tools/make-sample.mjs
//
// Sizes: a women's M from the dress form's chart -- chest 920 mm (the garment 1000 mm round:
// 80 mm ease), body length 650 mm (high shoulder point to hem), sleeve length 200 mm (cap top
// to hem). Each sleeve cap half is solved to the length of the armhole it joins.
//
// The sleeve cap has zero ease: each cap half equals its armhole's length exactly (the seam
// check allows 2 %), where a set-in sleeve usually carries a little ease to shape the shoulder.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadKernel } from "../test/package.mjs";
import * as pkg from "../pkg/index.js";
import { Atelier } from "../kernel.js";
import * as m from "../model.js";
import { PRESETS, presetParams } from "../fabrics.js";
import { slotFields, sceneBox, limbFields } from "../arrange.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHEST = 920, EASE = 80, LENGTH = 650, SLEEVE = 200;
const HALF = (CHEST + EASE) / 4;          // half a panel's width: 250
const UNDERARM = 420;                     // side seam height from the hem
const NECK = 80;                          // half the neck width at the high shoulder point
const TIP = [200, LENGTH - 45];           // shoulder point: 45 mm slope
const CAP = 90;                           // sleeve cap height
const HEM_IN = 30;                        // the sleeve narrows 30 mm a side to the hem

// One body panel, counter-clockwise from the left hem corner. Sides:
// 0 hem, 1 right side, 2 right armhole, 3 right shoulder, 4 neckline, 5 left shoulder,
// 6 left armhole, 7 left side. `depth` is the neckline's depth below the shoulder line,
// `scoop` how far the armhole curves in.
function panel(depth, scoop) {
    const nc = LENGTH - (4 / 3) * depth;  // the cubic's controls for a curve `depth` deep at mid
    const pts = [[-HALF, 0], [HALF, 0], [HALF, UNDERARM], TIP, [NECK, LENGTH], [-NECK, LENGTH], [-TIP[0], TIP[1]], [-HALF, UNDERARM]];
    const curves = [];
    curves[2] = { c1: [HALF - scoop, UNDERARM + 4], c2: [TIP[0] - 8, UNDERARM + 0.55 * (TIP[1] - UNDERARM)] };
    curves[4] = { c1: [NECK, nc], c2: [-NECK, nc] };
    curves[6] = { c1: [-(TIP[0] - 8), UNDERARM + 0.55 * (TIP[1] - UNDERARM)], c2: [-(HALF - scoop), UNDERARM + 4] };
    return { pts, curves };
}

// Cubic Bézier length by dense sampling (the kernel's own figure is checked below).
function bezierLength(p0, c1, c2, p3, n = 4000) {
    let len = 0, prev = p0;
    for (let i = 1; i <= n; i++) {
        const t = i / n, u = 1 - t;
        const q = [0, 1].map((k) => u * u * u * p0[k] + 3 * u * u * t * c1[k] + 3 * u * t * t * c2[k] + t * t * t * p3[k]);
        len += Math.hypot(q[0] - prev[0], q[1] - prev[1]);
        prev = q;
    }
    return len;
}
const capCurve = (w, sign) => ({ c1: [sign * 0.6 * w, SLEEVE - CAP], c2: [sign * 0.35 * w, SLEEVE] });
const capLength = (w) => { const c = capCurve(w, 1); return bezierLength([w, SLEEVE - CAP], c.c1, c.c2, [0, SLEEVE]); };
// The half-width at the underarm whose cap half is `target` long.
function solveCap(target) {
    let lo = 1, hi = 1000;
    for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (capLength(mid) < target) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
}

// A sleeve, front half on +x. Sides: 0 hem, 1 front underarm, 2 front cap, 3 back cap,
// 4 back underarm. `mirror` flips it to x -> -x (the left sleeve: its front faces +z on the
// left-arm slot); the winding then runs clockwise, which the kernel takes as well.
function sleeve(wf, wb, mirror) {
    const s = mirror ? -1 : 1;
    const X = ([x, y]) => [s * x, y];
    const pts = [[-(wb - HEM_IN), 0], [wf - HEM_IN, 0], [wf, SLEEVE - CAP], [0, SLEEVE], [-wb, SLEEVE - CAP]].map(X);
    const f = capCurve(wf, 1);
    const curves = [];
    curves[2] = { c1: X(f.c1), c2: X(f.c2) };
    // the back half runs top -> underarm: the reverse of its own solved curve
    const b = capCurve(wb, -1);
    curves[3] = { c1: X(b.c2), c2: X(b.c1) };
    return { pts, curves };
}

const k = await loadKernel();
const a = new Atelier(k);
const preset = PRESETS.find((p) => p.slug === "cotton_jersey");
a.apply(m.newDocumentOps({ slug: preset.slug, label: preset.label, params: presetParams(preset.slug) }), "new");
const fabric = "f_cotton_jersey";

const front = panel(100, 48), back = panel(20, 36);
const arm = (p, i) => bezierLength(p.pts[i], p.curves[i].c1, p.curves[i].c2, p.pts[(i + 1) % p.pts.length]);
const wf = solveCap(arm(front, 2)), wb = solveCap(arm(back, 2));

// The 2D layout, a 2 x 2 grid: front and back above, each sleeve below one of them. (The 3D
// slots centre each piece on its own bounds, so this shift does not move them there.)
const moved = ({ pts, curves }, dx, dy) => {
    const t = ([x, y]) => [x + dx, y + dy];
    return { pts: pts.map(t), curves: curves.map((c) => c && { c1: t(c.c1), c2: t(c.c2) }) };
};
const GAP = 80, ROW = SLEEVE + GAP, COL = 2 * HALF + GAP;
// the left arm slot is on +x (the form's left); the back panel's own x runs to -x in the world
const pieces = [
    { label: "Front", slot: "front", ...moved(front, 0, ROW) },
    { label: "Back", slot: "back", ...moved(back, COL, ROW) },
    { label: "Left sleeve", slot: "left_arm", ...moved(sleeve(wf, wb, true), COL, 0) },
    { label: "Right sleeve", slot: "right_arm", ...moved(sleeve(wf, wb, false), 0, 0) },
];
const ids = {};
for (const p of pieces) {
    const r = m.addPattern(a.nodes(), { label: p.label, path: m.polyPath(p.pts, p.curves), fabric });
    a.apply(r.ops, `add ${p.label}`);
    ids[p.slot] = r.id;
}

// The dress form's bounds, read as the worker reads them (the scene's vertices plus its origin).
// (loadKernel has loaded the package: its open() reads STEP here as in the worker.)
const scene = pkg.open(new Uint8Array(readFileSync(join(root, "assets", "f-M.stp"))), "step", undefined, "native");
const avatarBounds = sceneBox(scene.vertices(), scene.origin());
scene.free?.();
// f-M's arms (tools/dressform.py, arm()): the shoulder ball's centre at (+-182, 1352, -8), the
// arm running down and out at 42 degrees from vertical, a little forward. Each sleeve wraps
// round its arm, 65 mm out (the shoulder ball is 50), its hem 240 mm down it: its cap reaches
// the shoulder, so the cloth sews the shirt shut before gravity drapes it (live drape, M4b).
const ARM = 42 * Math.PI / 180, ARM_RADIUS = 65, HEM_DOWN = 240;
const armOf = (s) => ({ shoulder: [s * 182, 1352, -8], dir: [s * Math.sin(ARM), -Math.cos(ARM), 0.08] });
{
    const nodes = a.nodes(), byId = m.byId(nodes), ops = [];
    for (const p of pieces) {
        const id = ids[p.slot], bounds = a.drawing(id).bounds;
        const fields = slotFields(byId.get(id), p.slot, avatarBounds, bounds);
        const side = { left_arm: 1, right_arm: -1 }[p.slot];
        if (side) { const { shoulder, dir } = armOf(side); Object.assign(fields, limbFields(shoulder, dir, ARM_RADIUS, HEM_DOWN, bounds)); }
        ops.push(...m.setPattern(nodes, id, fields));
    }
    a.apply(ops, "arrange");
}

// Seams, side to side: [a, sideA, b, sideB, reversed]. reversed = the two sides run opposite
// ways along their outlines (a's start meets b's end). Anchored as the Sew sides tool anchors.
const F = ids.front, B = ids.back, L = ids.left_arm, R = ids.right_arm;
const SEAMS = [
    ["left shoulder", F, 3, B, 5, true], ["right shoulder", F, 5, B, 3, true],
    ["left side", F, 1, B, 7, true], ["right side", F, 7, B, 1, true],
    ["left front armhole", F, 2, L, 2, false], ["left back armhole", B, 6, L, 3, false],
    ["right front armhole", F, 6, R, 2, true], ["right back armhole", B, 2, R, 3, true],
    ["left underarm", L, 1, L, 4, true], ["right underarm", R, 1, R, 4, true],
];
const table = [];
for (const [name, pa, sa, pb, sb, reversed] of SEAMS) {
    const A = a.sidesOf(pa), Bs = a.sidesOf(pb);
    const r = m.addSeam(a.nodes(), {
        a: pa, b: pb, a_from: A[sa], a_to: A[sa + 1], b_from: Bs[sb], b_to: Bs[sb + 1], reversed,
        anchor: { a: [sa, 0, 1], b: [sb, 0, 1] },
    });
    a.apply(r.ops, `sew ${name}`);
    table.push({ name, a: A[sa + 1] - A[sa], b: Bs[sb + 1] - Bs[sb] });
}

const issues = a.issues();
// a seam-length issue carries the ratio of its two lengths ("seam 2 sews 380.0 to 420.0 (ratio 1.105)")
const mismatches = issues.filter((i) => Number.isFinite(i.ratio) && i.ratio > 0 && Math.abs(Math.log(i.ratio)) > Math.log(1.02));
for (const t of table) console.log(`  ${t.name.padEnd(20)} ${t.a.toFixed(1).padStart(7)} ${t.b.toFixed(1).padStart(7)} mm  ${((t.b / t.a - 1) * 100).toFixed(2)} %`);
for (const i of issues) console.log(`  issue: ${i.message}`);
const worst = Math.max(...table.map((t) => Math.abs(t.b / t.a - 1)));
if (mismatches.length || worst > 0.02) { console.error(`seam length mismatch above 2 %: ${worst * 100} %`); process.exit(1); }

// One commit in the saved file: the nodes copied into a fresh document in one batch (the
// garment last, after what it names), so opening the sample has no build steps to undo.
const clean = new Atelier(k);
const all = a.nodes();
clean.apply([...all.filter((n) => n.id !== "garment"), ...all.filter((n) => n.id === "garment")].map((node) => ({ op: "add", node })), "T-shirt sample");
if (clean.issues().length) { console.error("the copied document has issues"); process.exit(1); }
const text = clean.save();
clean.free();
writeFileSync(join(root, "assets", "tshirt.json"), text);
const g = m.byId(a.nodes()).get("garment");
console.log(`${g.patterns.length} patterns, ${g.seams.length} seams, ${mismatches.length} length mismatches`);
a.free();
