// Fabric presets from published KES-F measurements, converted to the kernel's (CLO's)
// units by our own formula -- docs/fabric-sources.md has the sources and the derivation.
// Never CLO's library values.
import { FABRIC_FIELDS } from "./model.js";

const GF_PER_CM = 980.665;            // 1 gf/cm in g/s²
const BEND = 9.80665e4;               // 1 gf·cm²/cm in g·mm²/s²
const PER_DEG = 180 / Math.PI;
const BUCKLING_RATIO = 0.5;           // no KES measure: our default
const BUCKLING_STIFFNESS = 0.5;       // no KES measure: our default, a fraction of the bending
const BUCKLING_STIFFNESS_MAX = 1;     // a buckled hinge is never stiffer than an unbuckled one
const DAMPING = 0.1;                  // no KES measure: our default
// Our defaults (not measured) for values a source did not publish (null in PRESETS).
const DEFAULT_G = 0.8;                // gf/(cm·deg)
const DEFAULT_T = 0.5;                // mm
const DEFAULT_MIU = 0.2;

export function fromKes({ EMT, G, B, W, T, MIU }) {
    const [bw, bf] = B, bias = (bw + bf) / 2;
    const g = G ?? DEFAULT_G;
    const p = {
        stretch_warp: (500 / (EMT[0] / 100)) * GF_PER_CM,
        stretch_weft: (500 / (EMT[1] / 100)) * GF_PER_CM,
        shear_left: g * PER_DEG * GF_PER_CM,
        shear_right: g * PER_DEG * GF_PER_CM,
        bending_warp: bw * BEND, bending_weft: bf * BEND,
        bending_bias_left: bias * BEND, bending_bias_right: bias * BEND,
        density: W * 1e-5, thickness: T ?? DEFAULT_T, friction: MIU ?? DEFAULT_MIU, internal_damping: DAMPING,
    };
    for (const d of ["warp", "weft", "bias_left", "bias_right"]) {
        p[`buckling_ratio_${d}`] = BUCKLING_RATIO;
        p[`buckling_stiffness_${d}`] = BUCKLING_STIFFNESS;
    }
    return p;
}

// One row per researched fabric: { slug, label, kes: {EMT:[warp,weft], G, B:[warp,weft], W, T, MIU}, source }.
// null = not published by the source (fromKes applies our default). `source` is the short
// citation; docs/fabric-sources.md has the full one. A row with `estimated: true` is NOT
// measured: it is a measured row scaled by stated factors (its `source` says which and why),
// and its label ends in "(estimated)".
export const PRESETS = [
    { slug: "cotton_poplin", label: "Cotton plain weave (poplin/shirting)", kes: { EMT: [9.14, 9.14], G: 2.81, B: [0.103, 0.103], W: 17.5, T: 0.975, MIU: 0.20 }, source: "Kan & Lam 2013, Materials, Table 4 (control; EMT/B not directional)" },
    { slug: "wool_suiting", label: "Wool plain weave (suiting weight)", kes: { EMT: [3.02, 9.58], G: 0.744, B: [0.0330, 0.0164], W: 16.18, T: 0.439, MIU: null }, source: "Petrak et al. 2021, Materials, Tables 1-2 (F4); B/G converted from cN x1.019716; MIU not published" },
    { slug: "polyester_plain", label: "Polyester plain weave (lightweight)", kes: { EMT: [3.90, 31.28], G: 0.469, B: [0.00867, 0.00337], W: 8.37, T: 0.356, MIU: null }, source: "Petrak et al. 2021, Materials, Tables 1-2 (F2); B/G converted from cN x1.019716; not stated to be taffeta; MIU not published" },
    { slug: "cotton_jersey", label: "Cotton single jersey (T-shirt)", kes: { EMT: [9.365, 9.365], G: 0.79, B: [0.027, 0.027], W: 16.2, T: null, MIU: 0.208 }, source: "Narasimhan et al. 2024, Tekstil ve Muhendis 31(136), Tables 1-2 (F1; not wale/course split; T method not stated)" },
    { slug: "cotton_lycra_jersey", label: "Cotton/elastane single jersey (stretch)", kes: { EMT: [17.07, 17.07], G: 0.58, B: [0.010, 0.010], W: 14.5, T: null, MIU: 0.223 }, source: "Narasimhan et al. 2024, Tekstil ve Muhendis 31(136), Tables 1-2 (F2; not wale/course split; T method not stated)" },
    { slug: "silk_twill", label: "Silk twill (mulberry, medium weight)", kes: { EMT: [11.29, 11.29], G: 0.369, B: [0.0428, 0.0428], W: 18.0, T: null, MIU: null }, source: "Singh 2021, J Fashion Technol Textile Eng 9(4), Tables 1 & 5 (F2); B/G converted from cN x1.019716; not directional; T/MIU not published" },
    { slug: "denim", label: "Cotton denim (mid-weight)", kes: { EMT: [5.515, 5.515], G: 2.18, B: [0.172, 0.172], W: 24.6, T: 1.066, MIU: null }, source: "Kumari & Khurana 2016, J. Textiles 4614168, Tables 2 & 5 (A); W from GSM (Table 5 W inconsistent); MIU printed 1.765, not used" },
    { slug: "polyester_lycra_woven", label: "Polyester/elastane stretch plain weave", kes: { EMT: [1.84, 79.20], G: 0.77, B: [0.0665, 0.0134], W: 10.539, T: null, MIU: 0.300 }, source: "Varghese & Thilagavathi 2014, JTATM 8(4), Tables 1-5 (T5); G/MIU = printed warp/weft averages; T method not stated" },
    { slug: "cotton_fleece", label: "Cotton fleece (estimated)", estimated: true, kes: { EMT: [6.882, 6.882], G: 1.463, B: [0.1230, 0.1230], W: 30, T: 1.5, MIU: 0.208 }, source: "Estimated, not measured: cotton_jersey (Narasimhan 2024 F1) scaled to a 300 g/m2, 1.5 mm cotton fleece (w = 30/16.2 = 1.852, t = 1.5/0.61 = 2.459, 0.61 mm = the jersey's printed T). B x4.554 = w*t: geometric mean of more-yarn scaling (x w) and solid-plate scaling (x w*t^2 = x11.2), because the raised loop pile adds thickness but little bending stiffness; G x1.852 = w: shear resistance grows with the yarn per area; EMT x0.735 = w^-1/2: geometric mean of unchanged loop geometry (x1) and pure yarn-count scaling (x1/w), because the tucked backing yarn restricts the loops but knit stretch is loop geometry, not yarn strain; W 30, T 1.5 typical fleece; MIU kept" },
    { slug: "cotton_fleece_heavy", label: "Heavyweight cotton fleece (estimated)", estimated: true, kes: { EMT: [5.619, 5.619], G: 2.194, B: [0.3074, 0.3074], W: 45, T: 2.5, MIU: 0.208 }, source: "Estimated, not measured: a winter-weight 450 g/m2, 2.5 mm brushed cotton fleece (2.5 mm: the kernel keeps a fabric thinner than the 3 mm weld distance), scaled from cotton_jersey (Narasimhan 2024 F1) by the same rules as the cotton fleece above: w = 45/16.2 = 2.778, t = 2.5/0.61 = 4.098; B x11.38 = w*t, G x2.778 = w, EMT x0.600 = w^-1/2; W 45, T 2.5; MIU kept" },
];

export const presetParams = (slug) => {
    const p = PRESETS.find((x) => x.slug === slug);
    if (!p) throw new Error(`no fabric preset ${slug}`);
    return fromKes(p.kes);
};

// The source line the UI shows for a preset: an estimate says so first.
export const presetNote = (p) => (p.estimated ? `ESTIMATE, not measured. ${p.source}` : `Measured (KES-F): ${p.source}`);

// The preset whose parameters a fabric node still carries (added from the library or applied, not edited since), else undefined.
export function matchingPreset(node) {
    return PRESETS.find((p) => {
        const q = fromKes(p.kes);
        return FABRIC_FIELDS.every((f) => Math.abs(node[f] - q[f]) <= 1e-9 * Math.max(1, Math.abs(q[f])));
    });
}

// Documents saved before buckling_stiffness became a ratio carry it as an absolute stiffness
// (0.5 x that direction's bending, g·mm²/s²): the kernel reads it as a factor of the bending,
// so a buckled hinge was ~1000-6000 times stiffer than an unbuckled one and the cloth never
// settled. A value above 1 is that old form: -> old / bending (0.5 for the app's own fabrics),
// kept in [0, 1]; 0.5 where the bending is 0 (the buckled stiffness is 0 either way). One-way and
// idempotent: a migrated fabric has no value above 1. -> the set ops for `nodes` (none when current).
export function bucklingMigration(nodes) {
    const ops = [];
    for (const n of nodes) {
        if (n.kind !== "garment.fabric") continue;
        const fields = {};
        for (const d of ["warp", "weft", "bias_left", "bias_right"]) {
            const v = n[`buckling_stiffness_${d}`], b = n[`bending_${d}`];
            if (!(typeof v === "number" && v > BUCKLING_STIFFNESS_MAX)) continue;
            fields[`buckling_stiffness_${d}`] = b > 0 ? Math.min(BUCKLING_STIFFNESS_MAX, v / b) : BUCKLING_STIFFNESS;
        }
        if (Object.keys(fields).length) ops.push({ op: "set", id: n.id, fields });
    }
    return ops;
}

// How the props panel shows each field: label, unit, the shown value both ways, and for some a
// range `[min, max]` it accepts and a tooltip `tip`.
const same = (label, unit, extra = {}) => ({ label, unit, toShown: (v) => v, fromShown: (v) => v, ...extra });
const title = (f) => f.split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
export const DISPLAY = Object.fromEntries(FABRIC_FIELDS.map((f) => {
    if (f === "density") return [f, { label: "Weight", unit: "g/m²", toShown: (v) => v * 1e6, fromShown: (v) => v / 1e6 }];
    if (f === "thickness") return [f, same("Thickness", "mm")];
    if (f.startsWith("stretch") || f.startsWith("shear")) return [f, same(title(f), "g/s²")];
    if (f.startsWith("bending")) return [f, same(title(f), "g·mm²/s²")];
    if (f.startsWith("buckling_stiffness")) return [f, same(title(f), "× bending", { range: [0, BUCKLING_STIFFNESS_MAX],
        tip: "A buckled hinge's bending stiffness as a fraction of the bending stiffness (0 to 1): past the buckling ratio the cloth bends with bending × this" })];
    if (f.startsWith("buckling_ratio")) return [f, same(title(f), "", { range: [0, 1],
        tip: "How far a hinge folds before it buckles (0 to 1): buckled once π − |angle| < ratio × (π − |rest angle|)" })];
    return [f, same(title(f), "")];
}));
