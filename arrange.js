// Where a flat pattern stands around the avatar, and the pure helpers the worker draws with.
// No kernel and no View in here, so Node can test it.

// Slot origins are fractions of the avatar's bounds (min xyz, max xyz); x and y are the
// pattern's 2D axes in world space (y up, the avatar facing +z, the panel facing outward).
export const SLOTS = {
    front:      { label: "Front",      origin: [0.5, 0.72, 1.6],  x: [1, 0, 0],  y: [0, 1, 0] },
    back:       { label: "Back",       origin: [0.5, 0.72, -0.6], x: [-1, 0, 0], y: [0, 1, 0] },
    left_side:  { label: "Left side",  origin: [1.8, 0.62, 0.5],  x: [0, 0, -1], y: [0, 1, 0] },
    right_side: { label: "Right side", origin: [-0.8, 0.62, 0.5], x: [0, 0, 1],  y: [0, 1, 0] },
    left_arm:   { label: "Left arm",   origin: [2.4, 0.8, 0.5],   x: [0, 0, -1], y: [0, 1, 0] },
    right_arm:  { label: "Right arm",  origin: [-1.4, 0.8, 0.5],  x: [0, 0, 1],  y: [0, 1, 0] },
};

// The `garment.pattern` frame field for `slot`: the piece's 2D bounds centre lands on the slot point.
export function slotFrame(slot, avatarBounds, patternBounds) {
    const s = SLOTS[slot];
    if (!s) throw new Error(`no slot ${slot}`);
    const point = [0, 1, 2].map((i) => avatarBounds[i] + s.origin[i] * (avatarBounds[i + 3] - avatarBounds[i]));
    const cx = (patternBounds[0] + patternBounds[2]) / 2, cy = (patternBounds[1] + patternBounds[3]) / 2;
    return {
        origin: point.map((v, i) => v - cx * s.x[i] - cy * s.y[i]),
        x: [...s.x], y: [...s.y],
    };
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// A frame as the extrude call takes it: origin, x, y, z (z = x cross y), twelve doubles.
// `frame` is {origin,x,y}, twelve numbers already, or absent / "xy" (the floor plane).
export function frame12(frame) {
    if (Array.isArray(frame) && frame.length === 12) return Float64Array.from(frame);
    if (frame && typeof frame === "object" && frame.origin) return Float64Array.from([...frame.origin, ...frame.x, ...frame.y, ...cross(frame.x, frame.y)]);
    return Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
}

// An unarranged pattern lies on the floor (the world x-z plane, y up) beside the avatar,
// shifted by its 2D position: CLO's look before arrangement. 2D x -> world x, 2D y -> world -z.
export function floorFrame(avatarBounds, patternBounds) {
    const gap = 150;
    return {
        origin: [avatarBounds[3] + gap - patternBounds[0], avatarBounds[1], avatarBounds[5] + patternBounds[1]],
        x: [1, 0, 0], y: [0, 0, -1],
    };
}

// A frame for drawing: the node's own, or the floor one.
export function drawFrame(node, avatarBounds, patternBounds) {
    return node.frame && node.frame !== "xy" ? node.frame : floorFrame(avatarBounds, patternBounds);
}

// 2D points (x, y pairs) through a frame, as 3D segments for showLines: consecutive points
// join, x0,y0,z0,x1,y1,z1 per segment. Display only.
export function polylineSegments(pts, frame) {
    const f = frame12(frame), out = [];
    const at = (i) => { const x = pts[2 * i], y = pts[2 * i + 1]; return [0, 1, 2].map((k) => f[k] + x * f[3 + k] + y * f[6 + k]); };
    for (let i = 0; i + 1 < pts.length / 2; i++) out.push(...at(i), ...at(i + 1));
    return out;
}

// One seam as the segments joining its two placed ranges: the i-th point of one to the
// i-th of the other (the second walked backwards when the seam is reversed), plus both
// ranges themselves.
export function seamSegments(seam, frameA, frameB) {
    const fa = frame12(frameA), fb = frame12(frameB);
    const map = (pts, f) => Array.from({ length: pts.length / 2 }, (_, i) => [0, 1, 2].map((k) => f[k] + pts[2 * i] * f[3 + k] + pts[2 * i + 1] * f[6 + k]));
    const a = map(seam.points_a, fa);
    let b = map(seam.points_b, fb);
    // the two ranges run in the sewn direction already (the kernel orders them by `reversed`)
    const n = Math.min(a.length, b.length), out = [];
    if (!n) return out;
    const steps = Math.min(n, 6);
    for (let s = 0; s < steps; s++) {
        const i = Math.round((s * (a.length - 1)) / Math.max(steps - 1, 1));
        const j = Math.round((s * (b.length - 1)) / Math.max(steps - 1, 1));
        out.push(...a[i], ...b[j]);
    }
    return out;
}

// View item ids -> what they are, for pick3d.
export class ItemMap {
    constructor() { this.items = new Map(); }
    set(item, what) { this.items.set(item, what); }
    clear() { this.items.clear(); }
    resolve(item) { return this.items.get(item) ?? null; }
}

const PALETTE = ["#d96c5a", "#5aa0d9", "#d9c05a", "#7fbf7a", "#b07fd9", "#d98fb4"];
export function fabricColours(nodes) {
    const m = new Map();
    for (const n of nodes) if (n.kind === "garment.fabric") m.set(n.id, n.colour ?? PALETTE[m.size % PALETTE.length]);
    return m;
}
export const ACCENT = "#ffb347";
