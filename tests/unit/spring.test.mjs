import test from "node:test";
import assert from "node:assert/strict";
import { isSettled, SPRING_DEFAULT, stepSpring } from "../../assets/lp/spring.js";

const start = () => ({ x: 0, v: 0 });

function advance(hz, seconds, tune = SPRING_DEFAULT) {
  let state = start();
  const steps = Math.round(seconds * hz);
  for (let i = 0; i < steps; i++) state = stepSpring(state, 1, seconds / steps, tune);
  return state;
}

test("30Hz と 120Hz で 1 秒後の位置が揃う", () => {
  assert.ok(Math.abs(advance(30, 1).x - advance(120, 1).x) < 0.01);
});

test("response 秒で 90% 以上、3 倍で収束する", () => {
  assert.ok(advance(120, SPRING_DEFAULT.response).x >= 0.9);
  assert.ok(isSettled(advance(120, SPRING_DEFAULT.response * 3), 1));
});

test("bounce 0 は目標を超えない", () => {
  let state = start();
  for (let i = 0; i < 240; i++) {
    state = stepSpring(state, 1, 1 / 120, { ...SPRING_DEFAULT, bounce: 0 });
    assert.ok(state.x <= 1 + 1e-12, `step ${i}: ${state.x}`);
  }
});

test("タブ復帰に相当する大きな dt でも発散しない", () => {
  const state = stepSpring(start(), 1, 0.5, SPRING_DEFAULT);
  assert.ok(Number.isFinite(state.x) && Math.abs(state.x) < 2);
  assert.ok(Number.isFinite(state.v));
});
