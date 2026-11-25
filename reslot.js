// Re-slot (spec §5, slot frames refresh): placed pieces put back on their slots around the
// avatar. kernel.js runs it inside every batch for the pieces whose outline the batch changed
// (Atelier.slotOps), and for every placed piece when a new avatar loads (Atelier.reslot, the
// worker's setAvatar: one undo step). Pure (no kernel), so Node tests it.
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

// A slot the refresh leaves alone: none, or a custom (gizmo) placement, which keeps its frame.
export const fixedSlot = (slot) => !slot || slot === "none" || slot === "custom";

/**
 * The ops that put every piece with a slot (meta.atelier.slot) back on it for `avatar`
 * ({bounds, landmarks}); drawings: id -> {bounds} (anything with get). Pieces on a named slot
 * first, then the "on:<id>" ones after their hosts, from the hosts' new frames. A piece whose
 * frame and wrap are already there (to 1e-9) gives no op, so a re-slot on the same form changes
 * nothing. `only` (a Set of ids) re-places just those pieces, and the "on:" pieces whose host
 * (or its host, and so on) was re-placed; null re-places every placed piece. A custom slot is
 * never re-placed (fixedSlot).
 * -> {ops, moved: [ids], skipped: [{id, reason}]} (a hood slot on a form without a head, say).
 */
export function reslotOps(nodes, drawings, avatar, only = null) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const patterns = (byId.get("garment")?.patterns ?? []).map((id) => byId.get(id)).filter(Boolean);
    const now = new Map(patterns.map((n) => [n.id, n]));        // each piece as it will stand
    const ops = [], moved = [], skipped = [], placed = new Set();
    const place = (n, slot, host = null) => {
        placed.add(n.id);
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
        if (fixedSlot(slot)) continue;
        if (slot.startsWith("on:")) onSlot.push(n); else if (!only || only.has(n.id)) place(n, slot);
    }
    // "on:" pieces once their host stands: a host may itself sit on another piece
    for (let pass = 0; onSlot.length && pass <= patterns.length; pass++) {
        for (let i = 0; i < onSlot.length; i++) {
            const n = onSlot[i], hostId = n.meta.atelier.slot.slice(3);
            const host = now.get(hostId);
            if (host && onSlot.some((x) => x.id === hostId)) continue;     // its host is not placed yet
            onSlot.splice(i--, 1);
            if (only && !only.has(n.id) && !placed.has(hostId)) continue;    // neither it nor its host moved
            if (!host) { skipped.push({ id: n.id, reason: `no piece ${hostId}` }); continue; }
            place(n, n.meta.atelier.slot, host);
        }
    }
    for (const n of onSlot) skipped.push({ id: n.id, reason: "its host is on it" });
    return { ops, moved, skipped };
}
