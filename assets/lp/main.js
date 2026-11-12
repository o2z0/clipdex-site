import { reducedMotion } from "./loop.js";
import { createRise } from "./rise.js";
import { createStage } from "./stage.js";
import { createWall } from "./wall.js";
import { CARDS } from "./wall-cards.js";

document.documentElement.classList.add("js");

for (const frame of document.querySelectorAll(".cmp-frame")) {
  const scroller = frame.querySelector(".cmp-scroll");
  const syncOverflow = () => frame.classList.toggle("has-overflow", scroller.scrollWidth > scroller.clientWidth + 1);
  const observer = new ResizeObserver(syncOverflow);
  observer.observe(scroller);
  observer.observe(scroller.querySelector("table"));
  syncOverflow();
}

const entry = document.querySelector("[data-rise]");
const wallEl = entry?.querySelector("[data-wall]");
const noWall = new URLSearchParams(location.search).has("nowall");
if (noWall) document.documentElement.classList.add("no-wall");

let wall = null;
let rise = null;

function syncVideos(reduced) {
  for (const video of document.querySelectorAll("video")) {
    if (reduced) {
      video.pause();
      try { video.currentTime = 0; } catch {}
      video.addEventListener("loadedmetadata", () => {
        if (reducedMotion.matches) { video.pause(); video.currentTime = 0; }
      }, { once: true });
    } else if (video.autoplay) {
      video.play().catch(() => {});
    }
  }
}

function start(reduced) {
  wall?.destroy();
  rise?.destroy();
  if (entry && wallEl) {
    if (!noWall) wall = createWall(wallEl, { cards: CARDS[wallEl.dataset.wallLang] ?? CARDS.ja, reduced });
    rise = createRise(entry, { reduced });
  }
  syncVideos(reduced);
}

start(reducedMotion.matches);
reducedMotion.on(start);
const stage = document.querySelector("[data-stage]");
if (stage) createStage(stage);
