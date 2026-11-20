// Keys for the 2D tool wait for the clicks made before them (plan ruling A). A click's release is
// a round trip to the worker; a key goes to the tool at once. So each key is held until every
// release sent before it is answered, and no longer: "click, Enter, click" gives the tool the
// first click, then Enter, then the second click, as the user made them. Pure: the page feeds it.
export class KeyHold {
    // onError(e): a held key that threw (the keys after it still run)
    constructor(onError = () => {}) {
        this.ups = new Set();    // the releases sent and not yet answered, by 2D event seq
        this.held = [];          // [{upto, fn}] in the order typed: fn waits for the releases <= upto
        this.onError = onError;
    }
    get busy() { return this.ups.size > 0; }
    // a release sent as 2D event `seq`
    sent(seq) { this.ups.add(seq); }
    // its answer (the tool has heard it); flush() then runs what waited on it
    answered(seq) { this.ups.delete(seq); }
    // `fn` once the releases sent up to 2D event `upto` are answered: now, when none is out
    key(upto, fn) { this.held.push({ upto, fn }); this.flush(); }
    flush() {
        while (this.held.length) {
            const { upto } = this.held[0];
            for (const s of this.ups) if (s <= upto) return;
            const { fn } = this.held.shift();
            try { fn(); } catch (e) { this.onError(e); }
        }
    }
    // the worker failed: no answer will come, nothing waits for one
    reset() { this.ups.clear(); this.held.length = 0; }
}
