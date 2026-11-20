// The worker's 2D event chain with a View whose pick (or snap) never answers: the event is
// answered after the timeout as no hit at the unsnapped point, with a status, and the events
// after it are answered too. The timeout runs on a fake timer the test fires: no wall clock.
import assert from "node:assert/strict";
import { Pointer2d, PICK_MS, within, TIMED_OUT } from "../pointer2d.js";
import { pxToWorld } from "../view2d.js";

const report = {
    rect: [500, 0, 800, 600], kind: "ortho", eye: [50, 25, 100],
    view: Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -50, -25, -100, 1),
    projection: Float32Array.of(1 / (100 * 800 / 600), 0, 0, 0, 0, 1 / 100, 0, 0, 0, 0, -0.001, 0, 0, 0, 0.5, 1),
};
const never = () => new Promise(() => {});
function harness() {
    const timers = { pending: new Map(), next: 0,
        setTimeout(fn, ms) { const id = ++this.next; this.pending.set(id, { fn, ms }); return id; },
        clearTimeout(id) { this.pending.delete(id); },
        fire() { const all = [...this.pending.values()]; this.pending.clear(); all.forEach((t) => t.fn()); return all.map((t) => t.ms); } };
    const viewer = { pick: never, snap: never, frameReport: () => [null, report] };
    const posts = [], hovers = [];
    const items = { gen: 0, what: () => ({ kind: "fill", id: "p1" }) };
    let snapOn = false;
    const p = new Pointer2d({
        viewer: () => viewer, items: () => items, drawings: () => new Map(),
        pieceAt: () => null, snapping: () => snapOn, hovered: (id) => hovers.push(id), post: (m) => posts.push(m), timers,
    });
    return { p, viewer, items, timers, posts, hovers, snap: (on) => { snapOn = on; } };
}
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
const at2d = (posts) => posts.filter((m) => m.kind === "at2d");

{
    const h = harness();
    h.p.event({ seq: 1, phase: "hover", x: 900, y: 300, snap: false });
    await settle();
    assert.equal(at2d(h.posts).length, 0, "the pick is out: no answer yet");
    assert.deepEqual(h.timers.fire(), [PICK_MS], "one pick timeout");
    await settle();
    const [a] = at2d(h.posts);
    assert.ok(a, "the hung pick answered after its timeout");
    assert.equal(a.seq, 1); assert.equal(a.hit, null); assert.equal(a.snap, null);
    assert.deepEqual(a.world, pxToWorld(report, [400, 300]), "the unsnapped point under the pointer");
    assert.ok(a.mmPerPx > 0);
    assert.ok(h.posts.some((m) => m.kind === "status" && /did not answer a pick/.test(m.text)), "a word on the status line");
    assert.deepEqual(h.hovers, [null], "the hover drops");
    // the chain goes on: a later event whose pick answers is answered at once
    h.viewer.pick = async () => ({ item: 3, point: [50, 25, 0], node: 0 });
    h.p.event({ seq: 2, phase: "down", x: 900, y: 300, snap: false });
    await settle();
    assert.deepEqual(at2d(h.posts).map((m) => [m.seq, m.hit?.id]), [[1, undefined], [2, "p1"]]);
    assert.equal(h.timers.pending.size, 0, "an answered pick clears its timer");
    // after(): a leave queued behind a hung pick still runs once it times out
    h.viewer.pick = never;
    h.p.event({ seq: 3, phase: "hover", x: 900, y: 300, snap: false });
    let left = false;
    h.p.after(() => { left = true; });
    await settle();
    assert.equal(left, false);
    h.timers.fire();
    await settle();
    assert.ok(left, "the leave ran after the timed-out pick");
}
{   // a snap that never answers: the unsnapped point, a status
    const h = harness();
    h.snap(true);
    h.viewer.pick = async () => null;
    h.p.event({ seq: 7, phase: "move", x: 900, y: 300, snap: true });
    await settle();
    assert.equal(at2d(h.posts).length, 0);
    h.timers.fire();
    await settle();
    const [a] = at2d(h.posts);
    assert.ok(a, "the hung snap answered after its timeout");
    assert.deepEqual(a.world, pxToWorld(report, [400, 300]));
    assert.equal(a.snap, null);
    assert.ok(h.posts.some((m) => m.kind === "status" && /did not answer a snap/.test(m.text)));
}
{   // a pick answered across a change of the items names an item that is gone: picked again, once
    const h = harness();
    const live = new Map([[4, { kind: "sew", id: "p2" }]]);
    h.items.what = (item) => live.get(item) ?? null;
    let picks = 0;
    h.viewer.pick = async () => { picks++; if (picks === 1) { h.items.gen++; return { item: 3, point: [0, 0, 0] }; } return { item: 4, point: [0, 0, 0] }; };
    h.p.event({ seq: 1, phase: "down", x: 900, y: 300, snap: false });
    await settle();
    assert.equal(picks, 2, "picked again after the items changed");
    assert.equal(at2d(h.posts)[0].hit?.id, "p2");
    // the items unchanged: an unknown item is no hit, not asked again
    picks = 0;
    h.viewer.pick = async () => { picks++; return { item: 9, point: [0, 0, 0] }; };
    h.p.event({ seq: 2, phase: "down", x: 900, y: 300, snap: false });
    await settle();
    assert.equal(picks, 1);
    assert.equal(at2d(h.posts)[1].hit, null);
}
{   // within(): the value when it comes first; TIMED_OUT when the timer does
    const t = { setTimeout: (fn) => { t.fn = fn; return 1; }, clearTimeout: () => { t.cleared = true; } };
    assert.equal(await within(Promise.resolve(4), 10, t), 4);
    assert.ok(t.cleared);
    const w = within(never(), 10, t);
    t.fn();
    assert.equal(await w, TIMED_OUT);
}
console.log("pointer2d: ok");
