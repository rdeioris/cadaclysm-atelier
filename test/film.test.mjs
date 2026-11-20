// The ?film=1 hook (film.js) against a fake worker: steps queue and resolve only after the stop
// and the View's draw, garment() calls settle in order, the Simulate button leaves a built film
// cloth alone, and nothing is the film's outside the film actions.
import assert from "node:assert/strict";
import { createFilm, filmCommand } from "../film.js";

const tick = () => new Promise((r) => setImmediate(r));
const settled = async (p) => { let done = false; p.then(() => { done = true; }, () => { done = true; }); for (let i = 0; i < 5; i++) await tick(); return done; };

// ---- filmCommand: the worker's half
{
    const sim = { film: true, live: true, running: false, stale: null, building: false };
    assert.deepEqual(filmCommand("step", sim, { frames: 3 }), { kind: "run", frames: 3 });
    assert.deepEqual(filmCommand("step", sim, { frames: 0 }), { kind: "run", frames: 1 }, "at least one frame");
    assert.deepEqual(filmCommand("run", sim), { kind: "run" });
    assert.deepEqual(filmCommand("pause", sim), { kind: "pause" });
    assert.equal(filmCommand("toggle", sim), null, "Simulate on a built film cloth does nothing");
    assert.equal(filmCommand("toggle", { ...sim, running: true }), undefined, "a free run: the toggle pauses as usual");
    assert.equal(filmCommand("toggle", { ...sim, live: false }), undefined, "no cloth: the toggle builds");
    assert.equal(filmCommand("toggle", { ...sim, stale: "the seams changed" }), undefined, "stale: the toggle rebuilds");
    assert.equal(filmCommand("toggle", { ...sim, film: false }), undefined, "without ?film=1 the toggle is untouched");
    assert.equal(filmCommand("reset", sim), undefined);
    assert.equal(filmCommand("step", { ...sim, live: false }), null, "no cloth: a step sends nothing");
}

// ---- createFilm: the page's half, against a fake worker
const posts = [];
let framesDrawn = 0, painted = 0, saves = 0;
const { film, onSim, onSaved } = createFilm({
    post: (m) => { posts.push(m); if (m.kind === "save") saves++; },
    request: async (kind) => { assert.equal(kind, "viewStats"); return { framesDrawn }; },
    nextPaint: async () => { painted++; },
    wait: () => tick(),
    now: () => 0,
});
let fps = "";
const sim = (m) => onSim({ live: true, ...m }, (t) => { fps = t; });

// no cloth yet: a step refuses clearly
await assert.rejects(film.step(1), /no cloth/);
sim({ stops: 1, frame: 0, stepMs: null });                      // the paused build

// a step resolves only after its stop and the View's draw
const s1 = film.step(2);
await tick();
assert.deepEqual(posts.at(-1), { kind: "sim", action: "step", frames: 2 });
sim({ stops: 1, frame: 1, stepMs: 5 });
assert.equal(await settled(s1), false, "not before the stop");
sim({ stops: 2, frame: 2, stepMs: 6, drawn: 7 });                // the stop; the worker drew to 7
assert.equal(await settled(s1), false, "not before the View has drawn the stepped frame");
framesDrawn = 7;
assert.equal(await s1, 2, "resolves with the frame reached");
assert.equal(painted, 1, "after the page painted it");
assert.deepEqual(film.log.map((e) => e[0]), [1, 2], "each frame logged once");

// steps queue: the second is posted only once the first has resolved
const nSteps = () => posts.filter((m) => m.action === "step").length;
const before = nSteps();
const a = film.step(1), b = film.step(1);
await tick(); await tick();
assert.equal(nSteps() - before, 1, "one step at a time");
sim({ stops: 3, frame: 3, stepMs: 6, drawn: 7 });
assert.equal(await a, 3);
await tick(); await tick();
assert.equal(nSteps() - before, 2, "the queued step goes after");
sim({ stops: 4, frame: 4, stepMs: 6, drawn: 7 });
assert.equal(await b, 4);

// the footer keeps fpsText
film.fpsText = "28.0 fps";
sim({ stops: 4 });
assert.equal(fps, "28.0 fps");

// garment(): two calls before an answer settle in order; no answer left for a download
const g1 = film.garment(), g2 = film.garment();
assert.equal(saves, 2);
assert.equal(onSaved("one"), true);
assert.equal(onSaved("two"), true);
assert.equal(await g1, "one");
assert.equal(await g2, "two");
assert.equal(onSaved("three"), false, "a Save from the menu still downloads");

// run and pause
film.run(); film.pause();
assert.deepEqual(posts.slice(-2), [{ kind: "sim", action: "run" }, { kind: "sim", action: "pause" }]);

console.log("film: ok");
