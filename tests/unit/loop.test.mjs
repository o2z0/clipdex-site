import test from "node:test";
import assert from "node:assert/strict";
import { createLoop } from "../../assets/lp/loop.js";

function harness() {
  let next = 0;
  const frames = new Map();
  const listeners = new Map();
  const document = {
    hidden: false,
    addEventListener(name, fn) { listeners.set(name, fn); },
    removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
  };
  let observer;
  class IntersectionObserver {
    constructor(fn) { this.callback = fn; observer = this; }
    observe() {}
    disconnect() { this.disconnected = true; }
  }
  const env = {
    document,
    IntersectionObserver,
    requestAnimationFrame(fn) { frames.set(++next, fn); return next; },
    cancelAnimationFrame(id) { frames.delete(id); },
  };
  return {
    env, document, frames,
    flush(time = 16) {
      const [id, fn] = frames.entries().next().value ?? [];
      if (fn) { frames.delete(id); fn(time); }
    },
    visibility() { listeners.get("visibilitychange")?.(); },
    intersect(value) { observer.callback([{ isIntersecting: value }]); },
    get observer() { return observer; },
  };
}

test("tick が false なら次の rAF を予約しない", () => {
  const h = harness();
  let calls = 0;
  const loop = createLoop(() => { calls++; return false; }, { env: h.env });
  loop.wake();
  assert.equal(h.frames.size, 1);
  h.flush();
  assert.equal(calls, 1);
  assert.equal(h.frames.size, 0);
  assert.equal(loop.running, false);
  loop.destroy();
});

test("hidden で止まり、visible で wake すると再開する", () => {
  const h = harness();
  const loop = createLoop(() => true, { env: h.env });
  loop.wake();
  h.flush();
  assert.equal(h.frames.size, 1);
  h.document.hidden = true;
  h.visibility();
  assert.equal(h.frames.size, 0);
  h.document.hidden = false;
  loop.wake();
  assert.equal(h.frames.size, 1);
  loop.destroy();
});

test("root が画面外なら止まり、戻ると再開する", () => {
  const h = harness();
  const loop = createLoop(() => true, { root: {}, env: h.env });
  loop.wake();
  h.intersect(true);
  assert.equal(h.frames.size, 1);
  h.intersect(false);
  assert.equal(h.frames.size, 0);
  h.intersect(true);
  assert.equal(h.frames.size, 1);
  loop.destroy();
  assert.equal(h.observer.disconnected, true);
});

test("destroy 後の wake は無効で、destroy は繰り返せる", () => {
  const h = harness();
  const loop = createLoop(() => true, { env: h.env });
  loop.wake();
  loop.destroy();
  loop.destroy();
  loop.wake();
  assert.equal(h.frames.size, 0);
  assert.equal(loop.running, false);
});
