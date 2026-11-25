// The worker's 2D pointer events: each answered as `at2d` with its seq, one after another (the
// page's keys and saves wait on the answers). The pick under the pointer is decoded through the
// item map; the pattern point is snapped when the page asks and snapping is on. A pick or snap
// the View never answers (a lost device, a View bug) is given up after `ms`: the event answers
// as no hit at the unsnapped point, with a word on the status line, so the events after it, the
// held keys, Save and Undo go on. No View, no kernel: the worker hands both in.
import { pxToWorld, mmPerPx, hitOf } from "./view2d.js";

export const PICK_MS = 2000;
export const TIMED_OUT = Symbol("timed out");

/** `p`, or TIMED_OUT once `ms` pass first (timers: setTimeout/clearTimeout, a test's own). */
export function within(p, ms, timers = globalThis) {
    let t;
    const late = new Promise((r) => { t = timers.setTimeout(() => r(TIMED_OUT), ms); });
    return Promise.race([p, late]).finally(() => timers.clearTimeout(t));
}

export class Pointer2d {
    /** env: viewer() and items() (the View, the 2D item map; null before the windows exist),
     *  drawings() (id -> drawing), pieceAt([x, y]), snapping() (on?), hovered(id) (a hover's
     *  piece, or null), post(msg); optional timers and ms. */
    constructor(env) {
        this.env = { timers: globalThis, ms: PICK_MS, ...env };
        this.chain = Promise.resolve();
    }
    // queued after the events before it; a failure still answers the event (frees the page's moveBusy)
    event(data) {
        const { post } = this.env;
        this.chain = this.chain.then(() => this.at(data)).catch((e) => {
            post({ kind: "at2d", seq: data.seq, phase: data.phase, world: null, hit: null, snap: null, mmPerPx: 0 });
            post({ kind: "error", text: String(e?.message ?? e) });
        });
        return this.chain;
    }
    // `fn` once the events before it are answered
    after(fn) { this.chain = this.chain.then(fn).catch(() => {}); return this.chain; }

    async at({ seq, phase, x, y, snap }) {
        const { viewer, items, drawings, pieceAt, snapping, hovered, post, timers, ms } = this.env;
        const v = viewer();
        const none = () => post({ kind: "at2d", seq, phase, world: null, hit: null, snap: null, mmPerPx: 0 });
        // no 2D window (F3 hides it: an empty rect) maps nothing, and its mmPerPx would be Infinity
        const shown = (r) => r && items() && r.rect[2] > 0 && r.rect[3] > 0;
        const r0 = v.frameReport()[1];
        if (!shown(r0)) { none(); return; }
        const px = [x - r0.rect[0], y - r0.rect[1]];
        const pick = async () => {
            const got = await within(v.pick(1, px[0], px[1]), ms, timers);
            if (got !== TIMED_OUT) return got;
            post({ kind: "status", text: "the 2D window did not answer a pick: taken as no hit" });
            return null;
        };
        const gen = items().gen;
        let p = await pick();
        // the items changed while the pick was out (a commit re-showed them): an item it names
        // that is gone is asked again, once, of the items as they are now
        if (p && !items().what(p.item) && items().gen !== gen) p = await pick();
        // the camera the pick ran with (a zoom, a pan or a rects change may have landed meanwhile)
        const r = v.frameReport()[1];
        if (!shown(r)) { none(); return; }
        let world = pxToWorld(r, px), snapped = null;
        const hit = p ? hitOf(items().what(p.item), p, drawings(), pieceAt, world) : null;
        if (snapping() && snap) {
            const s = await within(v.snap(1, px[0], px[1]), ms, timers);
            if (s === TIMED_OUT) post({ kind: "status", text: "the 2D window did not answer a snap: the point is not snapped" });
            else if (s) { world = [s.point[0], s.point[1]]; snapped = { kind: s.kind, label: s.label, lockedAngle: s.lockedAngle }; }
        }
        if (phase === "hover") hovered(hit?.id ?? null);
        post({ kind: "at2d", seq, phase, world, hit, snap: snapped, mmPerPx: mmPerPx(r) });
    }
}
