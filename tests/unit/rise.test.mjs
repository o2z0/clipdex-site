import test from "node:test";
import assert from "node:assert/strict";
import { fitScale, riseState } from "../../assets/lp/rise.js";

test("入口では窓が傾き、終端では正面に来て壁が消える", () => {
  assert.ok(riseState(0).tilt > 15);
  const end = riseState(1);
  assert.equal(end.tilt, 0);
  assert.ok(end.scale >= 1);
  assert.equal(end.wallFade, 1);
});

test("進捗につれて tilt は減り scale は増える", () => {
  let previous = riseState(0);
  for (let i = 1; i <= 20; i++) {
    const state = riseState(i / 20);
    assert.ok(state.tilt <= previous.tilt);
    assert.ok(state.scale >= previous.scale);
    previous = state;
  }
});

test("範囲外の進捗は両端へ丸める", () => {
  assert.deepEqual(riseState(-0.2), riseState(0));
  assert.deepEqual(riseState(1.3), riseState(1));
});

test("終端 scale は幅 94vw と上下余白 16px に収まる", () => {
  for (const [width, height, boxWidth, boxHeight] of [
    [1280, 744, 1180, 664],
    [1440, 844, 1180, 664],
    [900, 744, 852, 479],
  ]) {
    const scale = fitScale({ width: boxWidth, height: boxHeight }, { width, height });
    assert.ok(boxWidth * scale <= width * 0.94 + 1e-9);
    assert.ok(boxHeight * scale <= height - 32 + 1e-9);
    assert.ok(Math.abs(Math.max(boxWidth * scale / (width * 0.94), boxHeight * scale / (height - 32)) - 1) < 1e-9);
  }
});
