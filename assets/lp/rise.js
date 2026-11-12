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
  const introEl = section.querySelector(".entry__intro");
  let frame = null;
  let destroyed = false;
  let geo = null;
  let lastProgress = -1;

  // 大きさはスクロールでは変わらないので、読むのは最初と resize のときだけ (毎フレーム読むとレイアウトの確定を強制する)。
  // 進み具合の分母は sticky の高さから取る: iPhone ではスクロール中にバーが出入りして innerHeight が動く
  const measure = () => {
    const area = { width: sticky.clientWidth, height: sticky.clientHeight };
    const size = { width: windowEl.offsetWidth, height: windowEl.offsetHeight };
    geo = {
      travel: Math.max(1, section.offsetHeight - sticky.offsetHeight - (parseFloat(getComputedStyle(sticky).top) || 0)),
      fit: fitScale(size, area),
      targetShift: area.height / 2 - (windowEl.offsetTop + size.height / 2),
      narrow: innerWidth <= 767,
    };
    lastProgress = -1;
  };
  const apply = () => {
    frame = null;
    if (destroyed) return;
    if (!geo) measure();
    const progress = Math.min(1, Math.max(0, -section.getBoundingClientRect().top / geo.travel));
    if (progress === lastProgress) return;
    lastProgress = progress;
    const state = reduced ? { tilt: 0, scale: 1, wallFade: 0 } : riseState(progress);
    const eased = (state.scale - 0.78) / 0.46;
    const scale = reduced ? 1 : 0.78 + (geo.fit - 0.78) * eased;
    windowEl.style.setProperty("--entry-tilt", `${reduced || geo.narrow ? 0 : state.tilt}deg`);
    windowEl.style.setProperty("--entry-scale", scale);
    windowEl.style.setProperty("--entry-shift", `${reduced ? 0 : geo.targetShift * eased}px`);
    // section に変数を書くと配下 (壁のカード約 500 要素) のスタイルを毎フレーム計算し直すので、当の要素に直接書く
    if (introEl) introEl.style.opacity = reduced ? 1 : Math.max(0, 1 - progress * 2);
    wallEl.style.opacity = 1 - state.wallFade;
    windowEl.classList.toggle("is-risen", progress === 1);
    section.dataset.riseProgress = String(Math.round(progress * 1000) / 1000);
  };
  const schedule = () => {
    if (!destroyed && frame === null) frame = requestAnimationFrame(apply);
  };
  const remeasure = () => { geo = null; schedule(); };
  apply();
  if (!reduced) {
    addEventListener("scroll", schedule, { passive: true });
    addEventListener("resize", remeasure);
    addEventListener("hashchange", schedule);
    addEventListener("pageshow", remeasure);
    addEventListener("load", remeasure, { once: true });
  }

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (frame !== null) cancelAnimationFrame(frame);
      removeEventListener("scroll", schedule);
      removeEventListener("resize", remeasure);
      removeEventListener("hashchange", schedule);
      removeEventListener("pageshow", remeasure);
      removeEventListener("load", remeasure);
    },
  };
}
