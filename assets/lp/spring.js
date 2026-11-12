export const SPRING_DEFAULT = Object.freeze({ response: 0.42, bounce: 0.08 });

// 目標までの距離を減衰振動として解く。解析解なので刻み幅に依存しない。
export function stepSpring(state, target, dt, tune = SPRING_DEFAULT) {
  if (dt <= 0) return { ...state };
  const response = Math.max(0.001, tune.response);
  const bounce = Math.min(1, Math.max(0, tune.bounce));
  const frequency = 4.5 / response;
  const decay = 1 - 0.45 * bounce;
  const distance = state.x - target;
  const speed = state.v;

  if (bounce === 0) {
    const factor = Math.exp(-frequency * dt);
    const slope = speed + frequency * distance;
    return {
      x: target + factor * (distance + slope * dt),
      v: factor * (speed - frequency * slope * dt),
    };
  }

  const swing = frequency * Math.sqrt(1 - decay * decay);
  const factor = Math.exp(-decay * frequency * dt);
  const a = distance;
  const b = (speed + decay * frequency * distance) / swing;
  const cos = Math.cos(swing * dt);
  const sin = Math.sin(swing * dt);
  const displacement = a * cos + b * sin;
  return {
    x: target + factor * displacement,
    v: factor * (-decay * frequency * displacement + swing * (b * cos - a * sin)),
  };
}

export function isSettled(state, target, eps = 1e-3) {
  return Math.abs(state.x - target) < eps && Math.abs(state.v) < eps;
}
