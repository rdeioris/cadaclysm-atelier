// Keys for the 2D tool wait only for the clicks made before them (plan ruling A, fix round 2).
import assert from "node:assert/strict";
import { KeyHold } from "../keyhold.js";

// nothing out: a key runs at once
{
    const h = new KeyHold(), log = [];
    h.key(0, () => log.push("Enter"));
    assert.deepEqual(log, ["Enter"]);
}
// click, Enter, click within one round trip: Enter between the two clicks, not after both
{
    const errors = [], h = new KeyHold((e) => errors.push(e.message)), log = [];
    const answer = (seq, what) => { h.answered(seq); log.push(what); h.flush(); };
    h.sent(5);                                  // click 1's release
    h.key(5, () => log.push("Enter"));          // Enter, typed after it
    h.sent(8);                                  // click 2's release, after Enter
    assert.equal(h.busy, true);
    assert.deepEqual(log, [], "Enter waits for click 1");
    answer(5, "click 1");
    assert.deepEqual(log, ["click 1", "Enter"], "Enter runs once click 1 is in, before click 2's answer");
    answer(8, "click 2");
    assert.deepEqual(log, ["click 1", "Enter", "click 2"]);
    assert.equal(h.busy, false);
    // keys keep their order: one held, a later one waits behind it even with its own clicks in
    h.sent(10);
    h.key(10, () => log.push("Escape"));
    h.key(9, () => log.push("Backspace"));
    assert.deepEqual(log.slice(3), [], "a key never overtakes one typed before it");
    answer(10, "click 3");
    assert.deepEqual(log.slice(3), ["click 3", "Escape", "Backspace"]);
    assert.deepEqual(errors, []);
}
// a key that throws: reported, and the keys after it still run
{
    const errors = [], h = new KeyHold((e) => errors.push(e.message)), log = [];
    h.sent(1);
    h.key(1, () => { throw new Error("boom"); });
    h.key(1, () => log.push("Enter"));
    h.answered(1); h.flush();
    assert.deepEqual(errors, ["boom"]);
    assert.deepEqual(log, ["Enter"]);
}
// the worker failed: its answers never come; the held keys are dropped and later keys run at once
{
    const h = new KeyHold(), log = [];
    h.sent(3);
    h.key(3, () => log.push("held"));
    h.reset();
    assert.equal(h.busy, false);
    h.key(3, () => log.push("Escape"));
    assert.deepEqual(log, ["Escape"], "Escape works after a failure; the held key is gone");
}
console.log("keyhold: ok");
