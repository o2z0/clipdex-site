import { createLoop, reducedMotion } from "./loop.js";
import { isSettled, SPRING_DEFAULT, stepSpring } from "./spring.js";

export function focusTransform(scene, view, focus) {
  const scale = focus.zoom;
  const width = scene.w * scale;
  const height = scene.h * scale;
  const desiredX = view.w * 0.58 - scene.w * focus.x * scale;
  const desiredY = view.h * 0.5 - scene.h * focus.y * scale;
  const x = width < view.w ? (view.w - width) / 2 : Math.max(view.w - width, Math.min(0, desiredX));
  const y = height < view.h ? (view.h - height) / 2 : Math.max(view.h - height, Math.min(0, desiredY));
  return { x, y, scale };
}

export function createStage(section) {
  const view = section.querySelector(".stage-view");
  const close = section.querySelector(".stage-close");
  const info = section.querySelector(".stage-info");
  const panels = [...info.querySelectorAll(".pill-body")];
  const buttons = [...section.querySelectorAll(".pill[data-feature]")];
  const scenes = [...section.querySelectorAll(".scene[data-scene]")];
  const byScene = new Map(scenes.map((scene) => [scene.dataset.scene, scene]));
  let active = null;
  let lastButton = null;
  let current = { x: 0, y: 0, scale: 1 };
  let velocities = { x: 0, y: 0, scale: 0 };
  let target = { ...current };

  const selectedScene = () => byScene.get(active ?? "overview");
  const computeTarget = () => {
    if (!active) return { x: 0, y: 0, scale: 1 };
    const button = buttons.find((item) => item.dataset.feature === active);
    const [x, y, zoom] = button.dataset.focus.split(",").map(Number);
    const scene = selectedScene();
    return focusTransform(
      { w: scene.offsetWidth, h: scene.offsetHeight },
      { w: view.clientWidth, h: view.clientHeight },
      { x, y, zoom },
    );
  };
  const render = () => {
    const scene = selectedScene();
    scene.style.transform = `translate3d(${current.x}px, ${current.y}px, 0) scale(${current.scale})`;
  };
  const loop = createLoop((dt) => {
    if (reducedMotion.matches) return false;
    const x = stepSpring({ x: current.x, v: velocities.x }, target.x, dt, SPRING_DEFAULT);
    const y = stepSpring({ x: current.y, v: velocities.y }, target.y, dt, SPRING_DEFAULT);
    const scale = stepSpring({ x: current.scale, v: velocities.scale }, target.scale, dt, SPRING_DEFAULT);
    current = {
      x: x.x,
      y: y.x,
      scale: scale.x,
    };
    velocities = { x: x.v, y: y.v, scale: scale.v };
    render();
    if (isSettled(x, target.x, 0.01) && isSettled(y, target.y, 0.01) && isSettled(scale, target.scale)) {
      current = { ...target };
      velocities = { x: 0, y: 0, scale: 0 };
      render();
      return false;
    }
    return true;
  }, { root: section });

  const listeners = [];
  function open(id) {
    if (id !== null && !byScene.has(id)) return;
    active = id;
    section.dataset.activeFeature = id ?? "overview";
    section.classList.toggle("stage--open", id !== null);
    for (const button of buttons) {
      const selected = button.dataset.feature === id;
      button.setAttribute("aria-expanded", String(selected));
      button.closest("li").classList.toggle("is-active", selected);
      if (selected) lastButton = button;
    }
    for (const panel of panels) {
      const selected = panel.id === `feat-${id}`;
      panel.classList.toggle("is-active", selected);
      panel.setAttribute("aria-hidden", String(!selected));
    }
    for (const scene of scenes) {
      const selected = scene.dataset.scene === (id ?? "overview");
      scene.classList.toggle("is-active", selected);
      scene.setAttribute("aria-hidden", String(!selected));
    }
    target = computeTarget();
    if (reducedMotion.matches) { current = { ...target }; velocities = { x: 0, y: 0, scale: 0 }; }
    render();
    if (!reducedMotion.matches) loop.wake();
    if (id === null && lastButton) lastButton.focus();
  }

  for (const button of buttons) {
    const handler = () => open(active === button.dataset.feature ? null : button.dataset.feature);
    button.addEventListener("click", handler);
    listeners.push([button, handler]);
  }
  const onClose = () => open(null);
  close.addEventListener("click", onClose);
  const onKey = (event) => {
    if (event.key === "Escape" && active !== null) { event.preventDefault(); open(null); }
  };
  section.addEventListener("keydown", onKey);
  const onResize = () => { target = computeTarget(); current = { ...target }; velocities = { x: 0, y: 0, scale: 0 }; render(); };
  addEventListener("resize", onResize);
  const offMotion = reducedMotion.on(() => {
    if (reducedMotion.matches) { current = { ...target }; velocities = { x: 0, y: 0, scale: 0 }; render(); }
    else if (active !== null) loop.wake();
  });
  open(null);

  return {
    open,
    destroy() {
      loop.destroy();
      offMotion();
      removeEventListener("resize", onResize);
      section.removeEventListener("keydown", onKey);
      close.removeEventListener("click", onClose);
      for (const [button, handler] of listeners) button.removeEventListener("click", handler);
    },
  };
}
