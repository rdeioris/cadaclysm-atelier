// Re-slot: every placed piece put back on its named slot around the avatar now shown, after the
// avatar changed (a built form, a new pose, another shipped form). V3's minimal stand-in for lane
// A's A2 slot refresh: one entry point, reslotOps, called once from the worker's setAvatar tail,
// so A2 can replace it there. Pure (no kernel), so Node tests it.
import { slotFields } from "./arrange.js";
import { setPattern } from "./model.js";

const EPS = 1e-9;
function same(a, b) {
    if (a === b) return true;
    if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= EPS;
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => same(v, b[i]));
    if (a && b && typeof a === "object" && typeof b === "object") {
        const ka = Object.keys(a), kb = Object.keys(b);
        return ka.length === kb.length && ka.every((k) => same(a[k], b[k]));
    }
    return false;
}

/**
 * The ops that put every piece with a slot (meta.atelier.slot) back on it for `avatar`
 * ({bounds, landmarks}); drawings: id -> {bounds}. Pieces on a named slot first, then the
 * "on:<id>" ones after their hosts, from the hosts' new frames. A piece whose frame and wrap are
 * already there (to 1e-9) gives no op, so a re-slot on the same form changes nothing.
 * -> {ops, moved: [ids], skipped: [{id, reason}]} (a hood slot on a form without a head, say).
 */
export function reslotOps(nodes, drawings, avatar) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const patterns = (byId.get("garment")?.patterns ?? []).map((id) => byId.get(id)).filter(Boolean);
    const now = new Map(patterns.map((n) => [n.id, n]));        // each piece as it will stand
    const ops = [], moved = [], skipped = [];
    const place = (n, slot, host = null) => {
        const d = drawings.get(n.id);
        if (!d?.bounds) { skipped.push({ id: n.id, reason: "no outline" }); return; }
        let f;
        try { f = slotFields(n, slot, avatar.bounds, d.bounds, { landmarks: avatar.landmarks ?? null, host }); }
        catch (e) { skipped.push({ id: n.id, reason: e.message ?? String(e) }); return; }
        now.set(n.id, { ...n, ...f });
        if (same(f.frame, n.frame) && same(f.wrap ?? null, n.wrap ?? null)) return;
        ops.push(...setPattern(nodes, n.id, { frame: f.frame, wrap: f.wrap ?? null }));
        moved.push(n.id);
    };
    const onSlot = [];
    for (const n of patterns) {
        const slot = n.meta?.atelier?.slot;
        if (!slot || slot === "none") continue;
        if (slot.startsWith("on:")) onSlot.push(n); else place(n, slot);
    }
    // "on:" pieces once their host stands: a host may itself sit on another piece
    for (let pass = 0; onSlot.length && pass <= patterns.length; pass++) {
        for (let i = 0; i < onSlot.length; i++) {
            const n = onSlot[i], hostId = n.meta.atelier.slot.slice(3);
            const host = now.get(hostId);
            if (host && onSlot.some((x) => x.id === hostId)) continue;     // its host is not placed yet
            onSlot.splice(i--, 1);
            if (!host) { skipped.push({ id: n.id, reason: `no piece ${hostId}` }); continue; }
            place(n, n.meta.atelier.slot, host);
        }
    }
    for (const n of onSlot) skipped.push({ id: n.id, reason: "its host is on it" });
    return { ops, moved, skipped };
}
