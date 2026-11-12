import test from "node:test";
import assert from "node:assert/strict";
import { focusTransform } from "../../assets/lp/stage.js";

const scene = { w: 900, h: 600 };
const view = { w: 900, h: 600 };

test("zoom 1 の中央 focus は全景のまま", () => {
  const result = focusTransform(scene, view, { x: 0.5, y: 0.5, zoom: 1 });
  assert.ok(Math.abs(result.x) < 1e-6);
  assert.ok(Math.abs(result.y) < 1e-6);
  assert.equal(result.scale, 1);
});

test("寄りの倍率は指定した zoom と一致", () => {
  assert.equal(focusTransform(scene, view, { x: 0.7, y: 0.4, zoom: 1.4 }).scale, 1.4);
});

test("端の focus でも画面の左上に隙間を作らない", () => {
  const result = focusTransform(scene, view, { x: 0, y: 0, zoom: 1.5 });
  assert.ok(result.x <= 0 && result.y <= 0);
  assert.ok(result.x + scene.w * result.scale >= view.w);
  assert.ok(result.y + scene.h * result.scale >= view.h);
});
