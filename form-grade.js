// Dress-form grading from body measurements: a port of tools/dressform.py's Grade, generalised
// from a chart size to any measurements. Pure (no kernel), so Node tests it against a golden
// fixture written by the script itself (tools/dressform-golden.py).

// ---- copied verbatim from tools/dressform.py (keep in step with the script) ----
// Base torso sections (y, half-width a along x, half-depth b along z, z offset of the centre),
// and what each section follows when graded: a mix of the chart's girths (weights sum to 1).
export const HIP = "hip", WAIST = "waist", BUST = "bust", SHOULDER = "shoulder", NECK = "neck";
export const FEMALE = [
    [[700, 60, 46, -8], { hip: 1 }], [[750, 130, 96, -8], { hip: 1 }], [[800, 168, 120, -9], { hip: 1 }],
    [[880, 177, 126, -10], { hip: 1 }], [[960, 160, 112, -6], { hip: .5, waist: .5 }],
    [[1060, 126, 90, 0], { waist: 1 }], [[1170, 136, 102, 6], { waist: .45, bust: .55 }],
    [[1235, 158, 124, 14], { bust: 1 }], [[1295, 163, 110, 4], { bust: .6, shoulder: .4 }],
    [[1350, 168, 92, -6], { shoulder: 1 }], [[1395, 140, 70, -10], { shoulder: .7, neck: .3 }],
    [[1425, 62, 56, -8], { neck: 1 }], [[1480, 52, 52, -4], { neck: 1 }],
];
export const MALE = [
    [[700, 60, 46, -6], { hip: 1 }], [[750, 132, 96, -6], { hip: 1 }], [[800, 170, 114, -6], { hip: 1 }],
    [[880, 178, 120, -6], { hip: 1 }], [[960, 166, 114, -4], { hip: .5, waist: .5 }],
    [[1060, 150, 110, 0], { waist: 1 }], [[1170, 160, 118, 4], { waist: .45, bust: .55 }],
    [[1250, 175, 128, 6], { bust: 1 }], [[1300, 180, 120, 2], { bust: .6, shoulder: .4 }],
    [[1360, 186, 100, -4], { shoulder: 1 }], [[1405, 152, 76, -8], { shoulder: .7, neck: .3 }],
    [[1440, 70, 64, -6], { neck: 1 }], [[1490, 60, 58, -4], { neck: 1 }],
];
export const LANDMARK = { hip: 3, waist: 5, bust: 7, neck: 12 };   // the section whose girth is the chart's
export const SIZES = ["XS", "S", "M", "L", "XL"];
// Body measurements in cm (girths; shoulder = across the back, point to point; height in cm).
export const CHART = {
    female: {
        bust: [80, 86, 92, 100, 108],
        waist: [62, 68, 74, 82, 91],
        hip: [88, 94, 100, 107, 114],
        neck: [32, 33.5, 35, 36.5, 38],
        shoulder: [37, 38.5, 40, 41.5, 43],
        height: [160, 164, 168, 171, 174],
    },
    male: {
        bust: [86, 94, 102, 110, 119],
        waist: [72, 80, 88, 97, 107],
        hip: [88, 95, 102, 109, 116],
        neck: [36, 38, 40, 42, 44],
        shoulder: [43, 45, 47, 49, 51],
        height: [170, 175, 180, 184, 188],
    },
};
export const THIGH_CUT = 640;
// The head over the neck: (dy above the neck's top section, half-width a, half-depth b, z centre).
export const HEAD = [
    [-12, 46, 46, -4], [22, 52, 58, 0], [40, 62, 82, 16], [85, 72, 94, 12],
    [150, 75, 95, 4], [205, 70, 90, -2], [245, 50, 66, -6], [265, 17, 22, -8],
];
// ---- end of the copy ----

const KEYS = ["bust", "waist", "hip", "neck", "shoulder", "height"];
const M = SIZES.indexOf("M");

/** Ramanujan's ellipse perimeter. */
export function ellipseGirth(a, b) {
    return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
}

export const baseOf = (body) => {
    if (body !== "female" && body !== "male") throw new Error(`no body ${body}: female or male`);
    return body === "female" ? FEMALE : MALE;
};

/** A chart size's measurements in cm, as the script reads them (height is the script's chart
 * height, the ratio `h`'s numerator, not the form's stature). */
export function chartMeasurements(body, size) {
    baseOf(body);
    const i = SIZES.indexOf(size);
    if (i < 0) throw new Error(`no size ${size}: ${SIZES.join(", ")}`);
    const c = CHART[body];
    return Object.fromEntries(KEYS.map((k) => [k, c[k][i]]));
}

/**
 * The script's Grade for any measurements `m` (cm): {body, f, h, belly, sections: [[y, a, b, zc]],
 * y(y), mRef}. `h` is `m.height / chart M height` unless `opts.h` gives it (the stature solve).
 * `mRef` (the chart M grade, which the arms, thighs and head scale against) is made on first read.
 */
export function grade(body, m, opts = {}) {
    const base = baseOf(body), chart = CHART[body];
    const f = {};
    for (const [k, idx] of Object.entries(LANDMARK)) {
        const [, a, b] = base[idx][0];
        f[k] = m[k] * 10 / ellipseGirth(a, b);
    }
    // Shoulder width has no girth; grade it against the chart's M.
    const [, ba, bb] = base[LANDMARK.bust][0];
    f.shoulder = m.shoulder / chart.shoulder[M] * f.bust / (chart.bust[M] * 10 / ellipseGirth(ba, bb));
    const h = opts.h ?? m.height / chart.height[M];
    // The waist's share of growth goes to depth: b more than a, girth kept.
    const [, wa, wb0] = base[LANDMARK.waist][0];
    const wm = chart.waist[M] * 10 / ellipseGirth(wa, wb0);
    const belly = (f.waist / wm) ** 0.35;
    const y = (v) => THIGH_CUT + (v - THIGH_CUT) * h;
    const sections = base.map(([[sy, a, b, zc], w]) => {
        let fa = 0;
        for (const [k, v] of Object.entries(w)) fa += f[k] * v;   // the script's sum(), in dict order
        let fb = fa;
        const ww = w.waist ?? 0;
        const wb = ww * belly + (1 - ww);
        fa = fa / Math.sqrt(wb); fb = fb * Math.sqrt(wb);
        return [y(sy), a * fa, b * fb, zc * fb];
    });
    const g = { body, measurements: { ...m }, f, h, belly, sections, y };
    let ref = null;
    Object.defineProperty(g, "mRef", {
        get: () => ref ??= (isChartM(body, m, h) ? g : grade(body, chartMeasurements(body, "M"))),
    });
    return g;
}
const isChartM = (body, m, h) => {
    const c = chartMeasurements(body, "M");
    return h === 1 && KEYS.every((k) => k === "height" || m[k] === c[k]);
};

/** cm at the 4 landmark sections. */
export function girths(g) {
    return Object.fromEntries(Object.entries(LANDMARK).map(([k, idx]) => [k, ellipseGirth(g.sections[idx][1], g.sections[idx][2]) / 10]));
}

// ---- stature (the panel's Height: floor to crown, cm) ----
// The crown is the head loft's top section, y0 + HEAD[-1].dy * h, where y0 is the neck's top
// section; with the head off it is where the head would reach. Only h moves it.

/** The crown's height in mm for the height ratio h. */
export function crownMm(body, h) {
    const base = baseOf(body);
    const y0 = THIGH_CUT + (base[base.length - 1][0][0] - THIGH_CUT) * h;
    return y0 + HEAD[HEAD.length - 1][0] * h;
}

/** The ratio h whose crown is `statureCm`: a 1-D search (bisection to adjacent doubles, then the
 * nearer of the two), so a stature made by crownMm(h) gives h back. */
export function solveH(body, statureCm) {
    const want = statureCm * 10, err = (h) => crownMm(body, h) - want;
    let lo = 0.25, hi = 4;
    if (!(err(lo) < 0 && err(hi) > 0)) throw new Error(`no form reaches a height of ${statureCm} cm`);
    for (let i = 0; i < 200; i++) {
        const mid = (lo + hi) / 2;
        if (mid === lo || mid === hi) break;
        if (err(mid) < 0) lo = mid; else hi = mid;
    }
    return Math.abs(err(lo)) <= Math.abs(err(hi)) ? lo : hi;
}

/** The stature (cm, floor to crown) a chart size's form has. */
export function chartStature(body, size) {
    const i = SIZES.indexOf(size);
    return crownMm(body, CHART[body].height[i] / CHART[body].height[M]) / 10;
}

/** "Start from": a chart size's measurements with height as the stature its form has. */
export function startFrom(body, size) {
    return { ...chartMeasurements(body, size), height: chartStature(body, size) };
}

/** The grade for the panel's measurements: height is the stature, solved for h. A chart size's
 * stature (startFrom) gives the script's own h, so its sections are the shipped form's. */
export function gradeForm(body, m) {
    const s = SIZES.find((z) => startFrom(body, z).height === m.height);
    const h = s ? CHART[body].height[SIZES.indexOf(s)] / CHART[body].height[M] : solveH(body, m.height);
    return grade(body, m, { h });
}

// ---- validation (ranges estimated: an adult range, generous both ways) ----
export const RANGES = {
    bust: [60, 160], waist: [45, 150], hip: [70, 170], neck: [25, 55], shoulder: [30, 60], height: [140, 210],
};

/** A message such as "bust must be from 60 to 160 cm", or null. */
export function validateMeasurements(m) {
    for (const [k, [lo, hi]] of Object.entries(RANGES)) {
        const v = m?.[k];
        if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) return `${k} must be from ${lo} to ${hi} cm`;
    }
    return null;
}
