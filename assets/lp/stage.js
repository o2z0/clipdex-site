import { createLoop, reducedMotion } from "./loop.js";
import { isSettled, SPRING_DEFAULT, stepSpring } from "./spring.js";

export function focusTransform(scene, view, focus) {
  const scale = Math.min(focus.zoom, Math.max(1, focus.maxZoom ?? Infinity));
  const width = scene.w * scale;
  const height = scene.h * scale;
  const left = scene.left ?? (view.w - scene.w) / 2;
  const top = scene.top ?? (view.h - scene.h) / 2;
  const desiredX = view.w * 0.5 - left - scene.w * focus.x * scale;
  const desiredY = view.h * 0.5 - top - scene.h * focus.y * scale;
  // Keep at least 70% of the image visible on each axis. A contained image
  // needs some freedom to move without forcing its focus back to an edge.
  const visibleX = Math.min(view.w, width * 0.7);
  const visibleY = Math.min(view.h, height * 0.7);
  const x = Math.max(visibleX - width - left, Math.min(view.w - visibleX - left, desiredX));
  const y = Math.max(visibleY - height - top, Math.min(view.h - visibleY - top, desiredY));
  return { x, y, scale, clamped: Math.abs(x - desiredX) > 0.01 || Math.abs(y - desiredY) > 0.01 };
}

export function containScene(image, view) {
  const scale = Math.min(view.w / image.w, view.h / image.h);
  const w = image.w * scale;
  const h = image.h * scale;
  return { w, h, left: (view.w - w) / 2, top: (view.h - h) / 2 };
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
  let playingVideo = null;

  const selectedScene = () => byScene.get(active ?? "overview");
  const syncSceneVideos = () => {
    const next = active !== null && !reducedMotion.matches ? selectedScene().querySelector("video") : null;
    if (playingVideo && playingVideo !== next) {
      playingVideo.pause();
      playingVideo.load();
      playingVideo = null;
    }
    if (next && next !== playingVideo) {
      playingVideo = next;
      next.play().catch(() => {});
    }
  };
  const layoutScenes = () => {
    const box = { w: view.clientWidth, h: view.clientHeight };
    for (const scene of scenes) {
      const media = scene.querySelector("img, video");
      const natural = {
        w: media.naturalWidth || media.videoWidth || Number(media.getAttribute("width")) || box.w,
        h: media.naturalHeight || media.videoHeight || Number(media.getAttribute("height")) || box.h,
      };
      const fitted = containScene(natural, box);
      Object.assign(scene.style, {
        width: `${fitted.w}px`, height: `${fitted.h}px`,
        left: `${fitted.left}px`, top: `${fitted.top}px`,
      });
    }
  };
  const computeTarget = () => {
    if (!active) return { x: 0, y: 0, scale: 1 };
    const button = buttons.find((item) => item.dataset.feature === active);
    const [x, y, zoom] = button.dataset.focus.split(",").map(Number);
    const scene = selectedScene();
    const image = scene.querySelector("img, video");
    const sceneWidth = scene.offsetWidth;
    const maxZoom = (image.naturalWidth || image.videoWidth || Number(image.getAttribute("width"))) / (sceneWidth * devicePixelRatio);
    return focusTransform(
      { w: sceneWidth, h: scene.offsetHeight, left: scene.offsetLeft, top: scene.offsetTop },
      { w: view.clientWidth, h: view.clientHeight },
      { x, y, zoom, maxZoom },
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
    syncSceneVideos();
    layoutScenes();
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
  const onResize = () => { layoutScenes(); target = computeTarget(); current = { ...target }; velocities = { x: 0, y: 0, scale: 0 }; render(); };
  addEventListener("resize", onResize);
  for (const scene of scenes) {
    const media = scene.querySelector("img, video");
    const event = media.tagName === "VIDEO" ? "loadedmetadata" : "load";
    media.addEventListener(event, onResize);
    listeners.push([media, onResize, event]);
  }
  const offMotion = reducedMotion.on(() => {
    syncSceneVideos();
    if (reducedMotion.matches) { current = { ...target }; velocities = { x: 0, y: 0, scale: 0 }; render(); }
    else if (active !== null) loop.wake();
  });
  open(null);

  return {
    open,
    destroy() {
      if (playingVideo) { playingVideo.pause(); playingVideo.load(); playingVideo = null; }
      loop.destroy();
      offMotion();
      removeEventListener("resize", onResize);
      section.removeEventListener("keydown", onKey);
      close.removeEventListener("click", onClose);
      for (const [element, handler, event = "click"] of listeners) element.removeEventListener(event, handler);
    },
  };
}
