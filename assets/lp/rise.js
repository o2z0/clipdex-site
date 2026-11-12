export function riseState(progress) {
  const p = Math.min(1, Math.max(0, progress));
  const eased = p * p * (3 - 2 * p);
  return {
    tilt: 21 * (1 - eased),
    scale: 0.78 + 0.46 * eased,
    wallFade: eased,
  };
}

export function fitScale(size, area) {
  return Math.min(area.width * 0.94 / size.width, (area.height - 32) / size.height);
}

export function createRise(section, { reduced = false } = {}) {
  const windowEl = section.querySelector("[data-window]");
  const wallEl = section.querySelector("[data-wall]");
  const sticky = section.querySelector(".entry__sticky");
  let frame = null;
  let destroyed = false;

  const apply = () => {
    frame = null;
    if (destroyed) return;
    const travel = Math.max(1, section.offsetHeight - window.innerHeight);
    const progress = Math.min(1, Math.max(0, -section.getBoundingClientRect().top / travel));
    const state = reduced ? { tilt: 0, scale: 1, wallFade: 0 } : riseState(progress);
    const fit = fitScale(
      { width: windowEl.offsetWidth, height: windowEl.offsetHeight },
      { width: sticky.clientWidth, height: sticky.clientHeight },
    );
    const eased = (state.scale - 0.78) / 0.46;
    const scale = reduced ? 1 : 0.78 + (fit - 0.78) * eased;
    const naturalCenter = windowEl.offsetTop + windowEl.offsetHeight / 2;
    const targetShift = sticky.clientHeight / 2 - naturalCenter;
    windowEl.style.setProperty("--entry-tilt", `${reduced || innerWidth <= 767 ? 0 : state.tilt}deg`);
    windowEl.style.setProperty("--entry-scale", scale);
    windowEl.style.setProperty("--entry-shift", `${reduced ? 0 : targetShift * eased}px`);
    section.style.setProperty("--intro-opacity", reduced ? 1 : Math.max(0, 1 - progress * 2));
    wallEl.style.opacity = 1 - state.wallFade;
    section.dataset.riseProgress = String(Math.round(progress * 1000) / 1000);
  };
  const schedule = () => {
    if (!destroyed && frame === null) frame = requestAnimationFrame(apply);
  };
  apply();
  if (!reduced) {
    addEventListener("scroll", schedule, { passive: true });
    addEventListener("resize", schedule);
    addEventListener("hashchange", schedule);
    addEventListener("pageshow", schedule);
    addEventListener("load", schedule, { once: true });
  }

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (frame !== null) cancelAnimationFrame(frame);
      removeEventListener("scroll", schedule);
      removeEventListener("resize", schedule);
      removeEventListener("hashchange", schedule);
      removeEventListener("pageshow", schedule);
      removeEventListener("load", schedule);
    },
  };
}
