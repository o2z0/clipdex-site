export function createLoop(tick, { root, env = globalThis } = {}) {
  const doc = env.document;
  let wanted = false;
  let destroyed = false;
  let inView = !root;
  let frame = null;
  let previous = null;

  const canRun = () => wanted && !destroyed && !doc.hidden && inView;
  const stop = () => {
    if (frame !== null) env.cancelAnimationFrame(frame);
    frame = null;
    previous = null;
  };
  const next = () => {
    if (frame === null && canRun()) frame = env.requestAnimationFrame(draw);
  };
  function draw(time) {
    frame = null;
    if (!canRun()) { previous = null; return; }
    const dt = previous === null ? 0 : Math.max(0, (time - previous) / 1000);
    previous = time;
    if (tick(dt) === false) {
      wanted = false;
      stop();
      return;
    }
    next();
  }

  const onVisibility = () => { if (doc.hidden) stop(); else next(); };
  doc.addEventListener("visibilitychange", onVisibility);
  const observer = root ? new env.IntersectionObserver((entries) => {
    inView = entries.some((entry) => entry.isIntersecting);
    if (inView) next(); else stop();
  }) : null;
  observer?.observe(root);

  return {
    wake() { if (destroyed) return; wanted = true; next(); },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      wanted = false;
      stop();
      observer?.disconnect();
      doc.removeEventListener("visibilitychange", onVisibility);
    },
    get running() { return frame !== null; },
  };
}

export const reducedMotion = {
  get matches() { return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false; },
  on(fn) {
    const query = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return () => {};
    const listener = (event) => fn(event.matches);
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  },
};
