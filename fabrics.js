// Fabric presets from published KES-F measurements, converted to the kernel's (CLO's)
// units by our own formula -- docs/fabric-sources.md has the sources and the derivation.
// Never CLO's library values.
import { FABRIC_FIELDS } from "./model.js";

const GF_PER_CM = 980.665;            // 1 gf/cm in g/s²
const BEND = 9.80665e4;               // 1 gf·cm²/cm in g·mm²/s²
const PER_DEG = 180 / Math.PI;
const BUCKLING_RATIO = 0.5;           // no KES measure: our default
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
        p[`buckling_stiffness_${d}`] = BUCKLING_RATIO * p[`bending_${d}`];
    }
    return p;
}

// One row per researched fabric: { slug, label, kes: {EMT:[warp,weft], G, B:[warp,weft], W, T, MIU}, source }.
// null = not published by the source (fromKes applies our default). `source` is the short
// citation; docs/fabric-sources.md has the full one.
export const PRESETS = [
    { slug: "cotton_poplin", label: "Cotton plain weave (poplin/shirting)", kes: { EMT: [9.14, 9.14], G: 2.81, B: [0.103, 0.103], W: 17.5, T: 0.975, MIU: 0.20 }, source: "Kan & Lam 2013, Materials, Table 4 (control; EMT/B not directional)" },
    { slug: "wool_suiting", label: "Wool plain weave (suiting weight)", kes: { EMT: [3.02, 9.58], G: 0.744, B: [0.0330, 0.0164], W: 16.18, T: 0.439, MIU: null }, source: "Petrak et al. 2021, Materials, Tables 1-2 (F4); B/G converted from cN x1.019716; MIU not published" },
    { slug: "polyester_plain", label: "Polyester plain weave (lightweight)", kes: { EMT: [3.90, 31.28], G: 0.469, B: [0.00867, 0.00337], W: 8.37, T: 0.356, MIU: null }, source: "Petrak et al. 2021, Materials, Tables 1-2 (F2); B/G converted from cN x1.019716; not stated to be taffeta; MIU not published" },
    { slug: "cotton_jersey", label: "Cotton single jersey (T-shirt)", kes: { EMT: [9.365, 9.365], G: 0.79, B: [0.027, 0.027], W: 16.2, T: null, MIU: 0.208 }, source: "Narasimhan et al. 2024, Tekstil ve Muhendis 31(136), Tables 1-2 (F1; not wale/course split; T method not stated)" },
    { slug: "cotton_lycra_jersey", label: "Cotton/elastane single jersey (stretch)", kes: { EMT: [17.07, 17.07], G: 0.58, B: [0.010, 0.010], W: 14.5, T: null, MIU: 0.223 }, source: "Narasimhan et al. 2024, Tekstil ve Muhendis 31(136), Tables 1-2 (F2; not wale/course split; T method not stated)" },
    { slug: "silk_twill", label: "Silk twill (mulberry, medium weight)", kes: { EMT: [11.29, 11.29], G: 0.369, B: [0.0428, 0.0428], W: 18.0, T: null, MIU: null }, source: "Singh 2021, J Fashion Technol Textile Eng 9(4), Tables 1 & 5 (F2); B/G converted from cN x1.019716; not directional; T/MIU not published" },
    { slug: "denim", label: "Cotton denim (mid-weight)", kes: { EMT: [5.515, 5.515], G: 2.18, B: [0.172, 0.172], W: 24.6, T: 1.066, MIU: null }, source: "Kumari & Khurana 2016, J. Textiles 4614168, Tables 2 & 5 (A); W from GSM (Table 5 W inconsistent); MIU printed 1.765, not used" },
    { slug: "polyester_lycra_woven", label: "Polyester/elastane stretch plain weave", kes: { EMT: [1.84, 79.20], G: 0.77, B: [0.0665, 0.0134], W: 10.539, T: null, MIU: 0.300 }, source: "Varghese & Thilagavathi 2014, JTATM 8(4), Tables 1-5 (T5); G/MIU = printed warp/weft averages; T method not stated" },
];

export const presetParams = (slug) => {
    const p = PRESETS.find((x) => x.slug === slug);
    if (!p) throw new Error(`no fabric preset ${slug}`);
    return fromKes(p.kes);
};

const same = (label, unit) => ({ label, unit, toShown: (v) => v, fromShown: (v) => v });
const title = (f) => f.split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
export const DISPLAY = Object.fromEntries(FABRIC_FIELDS.map((f) => {
    if (f === "density") return [f, { label: "Weight", unit: "g/m²", toShown: (v) => v * 1e6, fromShown: (v) => v / 1e6 }];
    if (f === "thickness") return [f, same("Thickness", "mm")];
    if (f.startsWith("stretch") || f.startsWith("shear")) return [f, same(title(f), "g/s²")];
    if (f.startsWith("bending") || f.startsWith("buckling_stiffness")) return [f, same(title(f), "g·mm²/s²")];
    return [f, same(title(f), "")];
}));
