// The ?film=1 hook for the tutorial video's driver (scripts/atelier-hoodie in the cadaclysm repo):
// Simulate builds the cloth paused, and the driver steps it a frame at a time, capturing each.
// Nothing here runs without ?film=1. The page half is `createFilm` (window.atelierFilm), the
// worker half `filmCommand` (what a sim action sends the cloth under film).

// The cloth port message for a sim `action` from the film hook: undefined when the action is not
// the film's (the normal toggle/reset path handles it), null when it does nothing, else the message.
// `sim` is the worker's sim state: {film, live, running, stale, building}.
export function filmCommand(action, sim, data = {}) {
    switch (action) {
        case "step": return sim.live ? { kind: "run", frames: Math.max(1, data.frames | 0) } : null;
        case "run": return sim.live ? { kind: "run" } : null;
        case "pause": return sim.live ? { kind: "pause" } : null;
        case "toggle":
            // a built film cloth is the driver's: the button (labelled Pause) leaves it alone
            if (sim.film && sim.live && !sim.stale && !sim.building && !sim.running) return null;
            return undefined;
        default: return undefined;
    }
}

// window.atelierFilm. `post` sends to the View's worker, `request(kind)` asks it and resolves
// with the answer, `nextPaint()` resolves once the page has painted what the worker drew
// (two animation frames), `wait(ms)` a timer.
//   step(n)    steps n frames; resolves (with the frame reached) once they are stepped and the View
//              has drawn the last; calls queue, each starting when the one before has resolved
//   run()      runs free; pause() stops it (the Simulate button does nothing to a built film cloth)
//   garment()  the document's text, no download; calls settle in order
//   viewStats() View::stats: framesDrawn, lastFrameMs, lastGpuMs, ...
//   clothPositions() the GPU cloth's sim vertex positions (xyz, mm, in cloth_vertex_patterns'
//              order), read back; null on the CPU path
//   stops      rises each time the cloth says it has stopped
//   fpsText    the footer's text, kept when set (the driver sets the measured one)
//   log        [cloth frame, page ms, step ms] for every frame reported
export function createFilm({ post, request, nextPaint, wait = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => performance.now() }) {
    let live = false;
    let queue = Promise.resolve();
    const stopWaiters = [];                 // {after, resolve, reject}: resolved by a sim message with stops > after
    const saved = [];                       // garment() resolvers, oldest first

    async function stepNow(n) {
        if (!live) throw new Error("atelierFilm.step: no cloth; click Simulate first");
        const stop = new Promise((resolve, reject) => stopWaiters.push({ after: film.stops, resolve, reject }));
        post({ kind: "sim", action: "step", frames: n });
        const m = await stop;
        // the worker drew the stepped frame on the stop (m.drawn = framesDrawn after it); wait
        // until the View says so, then for the page to paint it
        if (m.drawn != null) while ((await request("viewStats")).framesDrawn < m.drawn) await wait(16);
        await nextPaint();
        return m.frame;
    }

    const film = {
        log: [],
        stops: 0,
        fpsText: null,
        viewStats: () => request("viewStats"),
        clothPositions: () => request("clothPositions"),
        step(n = 1) {
            const go = queue.then(() => stepNow(n));
            queue = go.catch(() => {});
            return go;
        },
        run() { post({ kind: "sim", action: "run" }); },
        pause() { post({ kind: "sim", action: "pause" }); },
        garment() { return new Promise((resolve) => { saved.push(resolve); post({ kind: "save" }); }); },
    };

    return {
        film,
        // a `sim` message from the worker; `setFps(text)` writes the footer
        onSim(m, setFps) {
            live = !!m.live;
            film.stops = m.stops ?? film.stops;
            if (film.fpsText) setFps(film.fpsText);       // the step's own state message must not blank it
            if (m.frame != null && m.stepMs != null && (!film.log.length || film.log.at(-1)[0] !== m.frame)) film.log.push([m.frame, now(), m.stepMs]);
            for (let i = 0; i < stopWaiters.length;) {
                if (film.stops > stopWaiters[i].after) stopWaiters.splice(i, 1)[0].resolve(m);
                else i++;
            }
        },
        // a `saved` message: true when garment() took it (no download then)
        onSaved(text) {
            const resolve = saved.shift();
            if (!resolve) return false;
            resolve(text);
            return true;
        },
    };
}
