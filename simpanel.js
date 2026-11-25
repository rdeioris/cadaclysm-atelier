// The Simulation panel (spec S1 §6): the cloth's 20 options (the ABI's names, cloth_default_options'
// order), each shown in a friendly unit, saved in the garment's `sim_options` ({name: value} in
// the kernel's units, only those set away from the default) and applied to a live cloth by the
// drape when the document changes (cloth.js). A new particle distance needs a new mesh: the live
// cloth goes stale and Simulate rebuilds it. The table and the ops are pure (Node tests them);
// SimPanel draws them in the dock.

// name, label, unit shown, the default (the kernel's: test/sim-kernel.test.mjs checks them against
// cloth_default_options), the shown value per kernel unit, and the kind of number.
export const OPTIONS = [
    { name: "particle_distance", label: "Particle distance", unit: "mm", def: 20, tip: "The cloth's mesh spacing (a piece's own Mesh overrides it). A change rebuilds a live cloth." },
    { name: "frame_dt", label: "Frame time", unit: "ms", def: 1 / 30, scale: 1000, tip: "Simulated time per frame." },
    { name: "substeps", label: "Substeps", unit: "", def: 30, whole: true, tip: "Solver substeps per frame: more is stiffer and steadier, and slower." },
    { name: "iterations", label: "Iterations", unit: "", def: 1, whole: true, tip: "Constraint iterations per substep." },
    { name: "gravity.x", label: "Gravity x", unit: "m/s²", def: 0, scale: 1e-3 },
    { name: "gravity.y", label: "Gravity y", unit: "m/s²", def: -9800, scale: 1e-3, tip: "y is up: -9.8 is the Earth's. Sewing runs with gravity off, then the drape turns it on." },
    { name: "gravity.z", label: "Gravity z", unit: "m/s²", def: 0, scale: 1e-3 },
    { name: "damping", label: "Damping", unit: "", def: 0.01, positive: true, tip: "Global velocity damping." },
    { name: "local_damping", label: "Local damping", unit: "", def: 0, positive: true },
    { name: "air_drag", label: "Air drag", unit: "", def: 0.035, positive: true },
    { name: "air_lift", label: "Air lift", unit: "", def: 0.035, positive: true },
    { name: "air_density", label: "Air density", unit: "kg/m³", def: 1.225e-6, scale: 1e6, positive: true },
    { name: "sewing_stiffness", label: "Sewing stiffness", unit: "N/m", def: 1e5, scale: 1e-3, positive: true, tip: "How hard a seam pulls its two sides together while sewing." },
    { name: "sewing_speed", label: "Sewing speed", unit: "mm/s", def: 400, positive: true, tip: "The fastest a seam closes." },
    { name: "weld_distance", label: "Weld distance", unit: "mm", def: 3, positive: true, tip: "Sewn points nearer than this merge. Above the self thickness." },
    { name: "avatar_thickness", label: "Avatar thickness", unit: "mm", def: 3, positive: true, tip: "The gap the cloth keeps from the avatar." },
    { name: "self_thickness", label: "Self thickness", unit: "mm", def: 2.5, positive: true, tip: "The least gap between two layers of cloth. Below the weld distance." },
    { name: "self_stiffness", label: "Self stiffness", unit: "", def: 0.5, range: [0, 1], tip: "How hard the cloth pushes itself apart, 0 to 1." },
    { name: "self_collision", label: "Self collision", unit: "", def: 1, flag: true, tip: "Whether the cloth collides with itself." },
    { name: "drag_stiffness", label: "Drag stiffness", unit: "N/m", def: 2e4, scale: 1e-3, positive: true, tip: "How hard the Drag tool pulls." },
];
export const OPTION_NAMES = OPTIONS.map((o) => o.name);
const byName = new Map(OPTIONS.map((o) => [o.name, o]));

// Seven significant digits, as the property panel shows numbers.
const tidy = (v) => Number(v.toPrecision(7));
export const toShown = (o, v) => tidy(v * (o.scale ?? 1));
export const fromShown = (o, s) => (o.scale ? s / o.scale : s);

// The garment's saved options ({name: value}, kernel units).
export const savedOptions = (nodes) => nodes.find((n) => n.id === "garment")?.sim_options ?? {};
// Every option as the cloth takes it: the saved ones over the defaults, in the ABI's order.
export function optionValues(nodes) {
    const saved = savedOptions(nodes);
    return OPTIONS.map((o) => (typeof saved[o.name] === "number" ? saved[o.name] : o.def));
}

// The panel's rows: {name, label, unit, value (shown), set (saved away from the default), tip}.
export function optionFields(nodes) {
    const saved = savedOptions(nodes);
    return OPTIONS.map((o) => {
        const v = typeof saved[o.name] === "number" ? saved[o.name] : o.def;
        return { name: o.name, label: o.label, unit: o.unit, value: o.flag ? (v ? "yes" : "no") : toShown(o, v), set: o.name in saved, flag: !!o.flag, tip: o.tip ?? "" };
    });
}

// The error for option `name` shown as `shown` (a number, or "yes"/"no" for a flag), else null.
export function validateOption(nodes, name, shown) {
    const o = byName.get(name);
    if (!o) return `no option ${name}`;
    if (o.flag) return shown === "yes" || shown === "no" ? null : "yes or no";
    if (typeof shown !== "number" || !Number.isFinite(shown)) return `${o.label}: not a number`;
    if (o.whole && !(Number.isInteger(shown) && shown >= 1 && shown <= 10000)) return `${o.label} is a whole number from 1 to 10000`;
    if (o.name === "particle_distance" && !(shown >= 5 && shown <= 100)) return "particle distance is from 5 to 100 mm";
    if (o.name === "frame_dt" && !(shown > 0)) return "frame time is above 0";
    if (o.positive && shown < 0) return `${o.label} is not negative`;
    if (o.range && !(shown >= o.range[0] && shown <= o.range[1])) return `${o.label} is from ${o.range[0]} to ${o.range[1]}`;
    const values = optionValues(nodes), v = fromShown(o, shown);
    const weld = name === "weld_distance" ? v : values[OPTION_NAMES.indexOf("weld_distance")];
    const self = name === "self_thickness" ? v : values[OPTION_NAMES.indexOf("self_thickness")];
    if (!(weld > self)) return "the weld distance must be above the self thickness";
    return null;
}

const setOptions = (opts) => [{ op: "set", id: "garment", fields: { sim_options: Object.keys(opts).length ? opts : null } }];
// The ops saving option `name` = `shown`: back at its default (to the shown digits) it is
// dropped, so a garment at the defaults has no `sim_options` at all.
export function optionOps(nodes, name, shown) {
    const o = byName.get(name);
    if (!o) throw new Error(`no option ${name}`);
    if (!nodes.some((n) => n.id === "garment")) throw new Error("no garment");
    const opts = { ...savedOptions(nodes) };
    const v = o.flag ? (shown === "yes" ? 1 : 0) : fromShown(o, shown);
    if (o.flag ? v === o.def : tidy(shown) === toShown(o, o.def)) delete opts[name];
    else opts[name] = v;
    return setOptions(opts);
}
// Every option back to its default.
export const resetOptionsOps = (nodes) => (Object.keys(savedOptions(nodes)).length ? setOptions({}) : []);

// The panel in the dock: a collapsible list of the options, each change one commit. `commit(ops,
// message)` posts the ops; `status(text, error)` speaks on the status line.
export class SimPanel {
    constructor(el, { commit, status }) {
        this.el = el; this.commit = commit; this.status = status;
        this.nodes = []; this.sig = null;
        const details = document.createElement("details");
        details.id = "simpanel-details";
        const summary = document.createElement("summary");
        summary.textContent = "Simulation";
        summary.title = "The cloth's settings, saved with the garment";
        this.dl = document.createElement("dl");
        const reset = document.createElement("button");
        reset.id = "sim-defaults";
        reset.textContent = "Reset to defaults";
        reset.addEventListener("click", () => {
            const ops = resetOptionsOps(this.nodes);
            if (ops.length) { this.commit(ops, "simulation defaults"); this.status("simulation: back to the defaults"); }
        });
        details.append(summary, this.dl, reset);
        el.replaceChildren(details);
    }
    // Drawn again when the saved options change (not on every document change: a field being
    // typed in keeps its text).
    render(nodes) {
        this.nodes = nodes;
        const sig = JSON.stringify(savedOptions(nodes));
        if (sig === this.sig) return;
        this.sig = sig;
        const focus = document.activeElement?.closest?.("#simpanel") ? document.activeElement.dataset.option : null;
        const rows = [];
        for (const f of optionFields(nodes)) {
            const dt = document.createElement("dt");
            dt.textContent = f.unit ? `${f.label} (${f.unit})` : f.label;
            if (f.tip) dt.title = f.tip;
            dt.classList.toggle("set", f.set);
            const dd = document.createElement("dd");
            let input;
            if (f.flag) {
                input = document.createElement("select");
                for (const v of ["yes", "no"]) { const o = document.createElement("option"); o.value = v; o.textContent = v; input.append(o); }
                input.value = f.value;
            } else {
                input = document.createElement("input");
                input.type = "text";
                input.value = String(f.value);
                input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
            }
            input.dataset.option = f.name;
            input.addEventListener("change", () => this.change(f, input.value));
            dd.append(input);
            rows.push(dt, dd);
        }
        this.dl.replaceChildren(...rows);
        if (focus) this.dl.querySelector(`[data-option="${focus}"]`)?.focus();
    }
    change(f, raw) {
        const shown = f.flag ? raw : raw.trim() === "" ? NaN : Number(raw);
        const err = validateOption(this.nodes, f.name, shown);
        if (err) { this.status(err, true); this.sig = null; this.render(this.nodes); return; }
        try {
            const ops = optionOps(this.nodes, f.name, shown);
            this.commit(ops, `set ${f.name}`);
            this.status(`${f.label}: set${f.name === "particle_distance" ? " (Simulate rebuilds the cloth)" : ""}`);
        } catch (e) { this.status(e.message ?? String(e), true); }
    }
}
