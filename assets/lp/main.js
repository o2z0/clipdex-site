import { reducedMotion } from "./loop.js";
import { createRise } from "./rise.js";
import { createFullNudge } from "./nudge.js";
import { createStage } from "./stage.js";
import { createWall } from "./wall.js";
import { CARDS } from "./wall-cards.js";

document.documentElement.classList.add("js");

let wall = null;
let rise = null;
let stageHandle = null;
let nudgeHandle = null;

// どこか 1 つでも初期化に失敗したら、作ったものを外して JS なしの組み方 (検証済み) に戻す。
// html.js のまま残すと、舞台の場面が全部 opacity 0 の空の舞台になる
function fallBackToStatic(error) {
  try { wall?.destroy(); rise?.destroy(); stageHandle?.destroy(); nudgeHandle?.destroy(); } catch {}
  document.documentElement.classList.remove("js");
  console.warn("ClipDex LP: 動きの初期化に失敗したので静的な表示にしました", error);
}

try {
  for (const frame of document.querySelectorAll(".cmp-frame")) {
    const scroller = frame.querySelector(".cmp-scroll");
    const table = scroller?.querySelector("table");
    if (!scroller) continue;
    const syncOverflow = () => frame.classList.toggle("has-overflow", scroller.scrollWidth > scroller.clientWidth + 1);
    const observer = new ResizeObserver(syncOverflow);
    observer.observe(scroller);
    if (table) observer.observe(table);
    syncOverflow();
  }

  const entry = document.querySelector("[data-rise]");
  const wallEl = entry?.querySelector("[data-wall]");
  const noWall = new URLSearchParams(location.search).has("nowall");
  if (noWall) document.documentElement.classList.add("no-wall");

  // Safari は muted の自動再生でも、読み込みや表示の都合で止まったままになることがある。
  // 再生できる状態になったとき・画面に入ったときにもう一度 play() する (止まっている間だけ)
  const autoplayWatch = new IntersectionObserver((entries) => {
    for (const entry of entries) if (entry.isIntersecting && !reducedMotion.matches) resume(entry.target);
  });
  const resume = (video) => { if (video.paused && !reducedMotion.matches) video.play().catch(() => {}); };
  const startAutoplay = (video) => {
    resume(video);
    if (!video.dataset.autoplayWatched) {
      video.dataset.autoplayWatched = "1";
      video.addEventListener("canplay", () => resume(video));
      autoplayWatch.observe(video);
    }
  };

  const syncVideos = (reduced) => {
    for (const video of document.querySelectorAll("video")) {
      if (reduced) {
        video.pause();
        try { video.currentTime = 0; } catch {}
        video.addEventListener("loadedmetadata", () => {
          if (reducedMotion.matches) { video.pause(); video.currentTime = 0; }
        }, { once: true });
      } else if (video.autoplay) {
        startAutoplay(video);
      }
    }
  };

  const start = (reduced) => {
    try {
      wall?.destroy();
      rise?.destroy();
      if (entry && wallEl) {
        if (!noWall) wall = createWall(wallEl, { cards: CARDS[wallEl.dataset.wallLang] ?? CARDS.ja, reduced });
        rise = createRise(entry, { reduced });
      }
      syncVideos(reduced);
    } catch (error) {
      fallBackToStatic(error);
    }
  };

  start(reducedMotion.matches);
  reducedMotion.on(start);
  const stage = document.querySelector("[data-stage]");
  if (stage) stageHandle = createStage(stage);
  const nudge = document.getElementById("full-nudge");
  if (nudge) nudgeHandle = createFullNudge(nudge);
} catch (error) {
  fallBackToStatic(error);
}
