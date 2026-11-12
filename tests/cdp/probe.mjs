import { openPage, sleep } from "./kit.mjs";
import { riseState } from "../../assets/lp/rise.js";

const usage = "Usage: node tests/cdp/probe.mjs <base-url> [--only <name>] [--pages / /full/ …]";
const expectedEdition = new Map([
  ["/", "store"],
  ["/full/", "full"],
  ["/en/full/", "full"],
]);
const RAF_COUNT = `(() => {
  let count = 0;
  const original = requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) => original((time) => { count++; callback(time); });
  window.__rafCount = () => count;
})();`;
const FRAME_TIMES = `(() => {
  window.__rafTimes = [];
  const original = requestAnimationFrame.bind(window);
  let last = -1;
  window.requestAnimationFrame = (callback) => original((time) => {
    if (time !== last) { window.__rafTimes.push(time); last = time; }
    callback(time);
  });
})();`;

async function visit(base, path, options, inspect) {
  const page = await openPage({ url: new URL(path, base).href, ...options });
  try {
    await page.idle();
    return await inspect(page);
  } finally {
    page.close();
  }
}

const errorsOf = (page) => page.errors.length ? `console error ${page.errors.length}: ${page.errors.join(" | ")}` : "";

function parseArgs(args) {
  const [base, ...rest] = args;
  if (!base) throw new Error(usage);
  let only = null;
  let pages = null;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--only") {
      only = rest[++i];
      if (!only || only.startsWith("--")) throw new Error("--only に検査名が必要");
    } else if (arg === "--pages") {
      pages = [];
      while (rest[i + 1] && !rest[i + 1].startsWith("--")) pages.push(rest[++i]);
      if (!pages.length) throw new Error("--pages にパスが必要");
    } else {
      throw new Error(`不明な引数: ${arg}`);
    }
  }
  return { base: new URL(base), only, pages: pages ?? ["/"] };
}

async function boot(base, path) {
  const expected = expectedEdition.get(path);
  if (!expected) throw new Error(`edition の期待値が未定義: ${path}`);
  const page = await openPage({ url: new URL(path, base).href });
  try {
    await page.idle();
    const edition = await page.ev("document.documentElement.dataset.edition");
    const reasons = [];
    if (page.errors.length) reasons.push(`console error ${page.errors.length}: ${page.errors.join(" | ")}`);
    if (edition !== expected) reasons.push(`edition=${JSON.stringify(edition)} expected=${expected}`);
    return reasons.join("; ");
  } finally {
    page.close();
  }
}

async function widths(base, path) {
  const failures = [];
  for (const width of [1280, 900, 375]) {
    const result = await visit(base, path, { width, height: 900 }, async (page) => ({
      overflow: await page.ev("document.documentElement.scrollWidth - document.documentElement.clientWidth"),
      errors: errorsOf(page),
    }));
    if (result.overflow !== 0) failures.push(`${width}px overflow=${result.overflow}`);
    if (result.errors) failures.push(`${width}px ${result.errors}`);
  }
  return failures.join("; ");
}

async function reduced(base, path) {
  return visit(base, path, { reduced: true, initScript: RAF_COUNT }, async (page) => {
    const before = await page.ev(`({
      wall: document.querySelector('.wall__track')?.style.transform ?? '',
      count: window.__rafCount(),
    })`);
    await sleep(3000);
    const after = await page.ev(`(() => {
      const windowEl = document.querySelector('[data-window]');
      return {
        wall: document.querySelector('.wall__track')?.style.transform ?? '',
        tilt: parseFloat(windowEl?.style.getPropertyValue('--entry-tilt')),
        transform: windowEl ? getComputedStyle(windowEl).transform : '',
        videos: [...document.querySelectorAll('video')].map(v => ({ paused: v.paused, time: v.currentTime })),
        headings: [...document.querySelectorAll('section h1, section h2')].map(h => ({ text: h.textContent.trim().slice(0, 30), height: h.getBoundingClientRect().height, opacity: getComputedStyle(h).opacity })),
        count: window.__rafCount(),
      };
    })()`);
    const failures = [];
    if (before.wall !== after.wall) failures.push("壁の transform が変化");
    if (after.tilt !== 0 || after.transform !== "none") failures.push(`窓が静止しない tilt=${after.tilt} transform=${after.transform}`);
    if (after.videos.some((v) => !v.paused || v.time !== 0)) failures.push(`video=${JSON.stringify(after.videos)}`);
    if (after.count !== before.count) failures.push(`rAF=${after.count - before.count}/3s`);
    if (after.headings.some((h) => h.height <= 0 || h.opacity !== "1")) failures.push(`見出し=${JSON.stringify(after.headings.filter((h) => h.height <= 0 || h.opacity !== "1"))}`);
    if (page.errors.length) failures.push(errorsOf(page));
    return failures.join("; ");
  });
}

async function idle(base, path) {
  return visit(base, path, { initScript: RAF_COUNT }, async (page) => {
    const failures = [];
    const end = await page.ev("document.querySelector('[data-rise]').offsetHeight + 100");
    await page.scrollTo(end);
    const offscreen = await page.ev("window.__rafCount()");
    await sleep(1000);
    const offscreenAfter = await page.ev("window.__rafCount()");
    if (offscreenAfter !== offscreen) failures.push(`画面外 rAF=${offscreenAfter - offscreen}`);

    await page.scrollTo(0);
    await sleep(100);
    await page.ev(`Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__probeHidden || false }); window.__probeHidden = true; document.dispatchEvent(new Event('visibilitychange'));`);
    const hidden = await page.ev("window.__rafCount()");
    await sleep(1000);
    const hiddenAfter = await page.ev("window.__rafCount()");
    if (hiddenAfter !== hidden) failures.push(`hidden rAF=${hiddenAfter - hidden}`);
    await page.ev(`window.__probeHidden = false; document.dispatchEvent(new Event('visibilitychange'));`);
    const visible = await page.ev("window.__rafCount()");
    await sleep(1000);
    const visibleAfter = await page.ev("window.__rafCount()");
    if (visibleAfter <= visible) failures.push("visible で rAF が再開しない");
    if (page.errors.length) failures.push(errorsOf(page));
    return failures.join("; ");
  });
}

async function reloadMid(base, path) {
  const failures = [];
  const url = new URL(path, base);
  const page = await openPage({ url: url.href });
  let hashes;
  try {
    await page.idle();
    hashes = await page.ev(`(() => {
      const ids = new Set([...document.querySelectorAll('section[id]')].map(el => el.id));
      for (const a of document.querySelectorAll('a[href^="#"]')) {
        const id = decodeURIComponent(a.getAttribute('href').slice(1));
        if (id && id !== 'top' && document.getElementById(id)) ids.add(id);
      }
      return [...ids];
    })()`);
    // 入口はヘッダーの下から始まるので、文書の先頭ではなく入口の先頭から測った 60% の位置へ
    const target = await page.ev(`(() => {
      const entry = document.querySelector('[data-rise]');
      const top = entry.getBoundingClientRect().top + scrollY;
      return top + (entry.offsetHeight - innerHeight) * 0.6;
    })()`);
    await page.scrollTo(target, { io: false });
    await sleep(100);
    await page.send("Page.reload", { ignoreCache: true });
    await sleep(150);
    await page.idle();
    await page.run(`await until(() => {
      const p = Number(document.querySelector('[data-rise]')?.dataset.riseProgress);
      return p > 0.55 && p < 0.65;
    }, 3000, 'reload 中間位置'); return true;`);
    const mid = await page.ev(`(() => ({
      progress: Number(document.querySelector('[data-rise]').dataset.riseProgress),
      tilt: parseFloat(document.querySelector('[data-window]').style.getPropertyValue('--entry-tilt')),
    }))()`);
    const expected = riseState(0.6).tilt;
    if (Math.abs(mid.progress - 0.6) > 0.05) failures.push(`reload progress=${mid.progress}`);
    if (Math.abs(mid.tilt - expected) > 1) failures.push(`reload tilt=${mid.tilt} expected=${expected.toFixed(2)}`);
    if (page.errors.length) failures.push(errorsOf(page));
  } finally {
    page.close();
  }
  for (const id of hashes) {
    const hashUrl = new URL(url);
    hashUrl.hash = id;
    const result = await visit(base, hashUrl.pathname + hashUrl.hash, {}, async (hashPage) => ({
      ready: await hashPage.run(`await until(() => {
        const target = document.getElementById(${JSON.stringify(id)});
        const rect = target?.getBoundingClientRect();
        return !!rect && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight &&
          Number(document.querySelector('[data-rise]')?.dataset.riseProgress) >= 0.99;
      }, 4000, 'hash 着地'); return true;`),
      state: await hashPage.ev(`(() => {
        const target = document.getElementById(${JSON.stringify(id)});
        const rect = target?.getBoundingClientRect();
        return { height: rect?.height ?? 0, inView: !!rect && rect.bottom > 0 && rect.top < innerHeight,
          progress: Number(document.querySelector('[data-rise]').dataset.riseProgress),
          tilt: parseFloat(document.querySelector('[data-window]').style.getPropertyValue('--entry-tilt')) };
      })()`),
      errors: errorsOf(hashPage),
    }));
    if (!result.state.inView || result.state.height <= 0) failures.push(`#${id} 着地先が不可視`);
    if (result.state.progress < 0.99 || Math.abs(result.state.tilt) > 1) failures.push(`#${id} 入口が終端でない ${JSON.stringify(result.state)}`);
    if (result.errors) failures.push(`#${id} ${result.errors}`);
  }
  return failures.join("; ");
}

async function nojs(base, path) {
  const page = await openPage();
  try {
    await page.send("Emulation.setScriptExecutionDisabled", { value: true });
    await page.send("Page.navigate", { url: new URL(path, base).href });
    await sleep(150);
    await page.idle();
    const state = await page.ev(`(() => {
      const h = document.querySelector('.entry h1');
      const lede = document.querySelector('.entry .lede');
      const image = document.querySelector('.window__fallback');
      return { js: document.documentElement.classList.contains('js'),
        h: h?.getBoundingClientRect().height ?? 0,
        lede: lede?.getBoundingClientRect().height ?? 0,
        image: !!image && image.complete && image.naturalWidth > 0 && image.getBoundingClientRect().height > 0 && getComputedStyle(image).display !== 'none' };
    })()`);
    const failures = [];
    if (state.js || state.h <= 0 || state.lede <= 0 || !state.image) failures.push(JSON.stringify(state));
    if (page.errors.length) failures.push(errorsOf(page));
    return failures.join("; ");
  } finally {
    page.close();
  }
}

function frameStats(times) {
  const intervals = times.slice(1).map((time, index) => time - times[index]).sort((a, b) => a - b);
  return {
    frames: times.length,
    p95: intervals.length ? intervals[Math.ceil(intervals.length * 0.95) - 1] : Infinity,
    over25: intervals.filter((ms) => ms > 25).length,
  };
}

async function traceEvents(page, stream) {
  let data = "";
  for (;;) {
    const reply = await page.send("IO.read", { handle: stream, size: 1024 * 1024 });
    if (reply.error) throw new Error(`trace read: ${reply.error.message}`);
    const part = reply.result;
    data += part.base64Encoded ? Buffer.from(part.data, "base64").toString("utf8") : part.data;
    if (part.eof) break;
  }
  await page.send("IO.close", { handle: stream });
  return JSON.parse(data).traceEvents ?? [];
}

async function measureFrames(base, path, withoutWall) {
  let traceStream = null;
  const url = new URL(path, base);
  if (withoutWall) url.searchParams.set("nowall", "");
  const page = await openPage({
    width: 1440,
    height: 900,
    initScript: FRAME_TIMES,
    onEvent(event) { if (event.method === "Tracing.tracingComplete") traceStream = event.params.stream; },
  });
  try {
    await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false, screenWidth: 1440, screenHeight: 900 });
    await page.send("Page.navigate", { url: url.href });
    await sleep(150);
    await page.idle();
    const entry = await page.ev(`(() => {
      const root = document.querySelector('[data-rise]');
      return { travel: root.offsetHeight - innerHeight,
        wallElements: document.querySelectorAll('.wall *').length,
        cards: document.querySelectorAll('.wall__set:first-child .wall__card').length };
    })()`);
    await page.send("Tracing.start", { categories: "devtools.timeline", transferMode: "ReturnAsStream" });
    await page.ev("window.__rafTimes = []");
    await page.run(`await new Promise((resolve) => {
      const travel = document.querySelector('[data-rise]').offsetHeight - innerHeight;
      const start = performance.now();
      const advance = (time) => {
        const p = Math.min(1, (time - start) / 3000);
        window.scrollTo({ top: travel * p, behavior: 'instant' });
        if (p < 1) requestAnimationFrame(advance); else resolve();
      };
      requestAnimationFrame(advance);
    }); return true;`);
    const scroll = frameStats(await page.ev("window.__rafTimes"));
    await page.scrollTo(0);
    await sleep(100);
    await page.ev("window.__rafTimes = []");
    await sleep(4000);
    const wall = frameStats(await page.ev("window.__rafTimes"));
    await page.send("Tracing.end");
    for (let i = 0; i < 100 && !traceStream; i++) await sleep(50);
    if (!traceStream) throw new Error("trace 完了イベントが届かない");
    const events = await traceEvents(page, traceStream);
    const longTasks = events.filter((event) => /^(RunTask|Task)$/.test(event.name) && event.dur > 50000).length;
    return { scroll, wall, longTasks, wallElements: entry.wallElements, cards: entry.cards, errors: errorsOf(page) };
  } finally {
    page.close();
  }
}

async function frames(base, path) {
  const measured = await measureFrames(base, path, false);
  const comparison = await measureFrames(base, path, true);
  for (const [label, result] of [["wall", measured], ["nowall", comparison]]) {
    console.log(`METRIC frames ${path} ${label} scroll=${result.scroll.frames} p95=${result.scroll.p95.toFixed(2)}ms over25=${result.scroll.over25} wall=${result.wall.frames} p95=${result.wall.p95.toFixed(2)}ms over25=${result.wall.over25} longTasks=${result.longTasks} elements=${result.wallElements} cards=${result.cards}`);
  }
  const failures = [];
  for (const [label, segment] of [["scroll", measured.scroll], ["wall", measured.wall]]) {
    if (segment.frames < 10) failures.push(`${label} frames=${segment.frames}`);
    // 60Hz の 1 フレームは rAF の刻みで 16.7〜16.8ms に揺れる (壁なしでも 16.8 が出る) ので、その揺れ分を許す
    if (segment.p95 > 17.0) failures.push(`${label} p95=${segment.p95.toFixed(2)}ms`);
    if (segment.over25 > 3) failures.push(`${label} over25=${segment.over25}`);
  }
  if (measured.longTasks > 0) failures.push(`longTasks=${measured.longTasks}`);
  if (measured.errors) failures.push(measured.errors);
  if (comparison.errors) failures.push(`nowall ${comparison.errors}`);
  return failures.join("; ");
}

const checks = { boot, widths, reduced, idle, "reload-mid": reloadMid, nojs, frames };

async function main() {
  const { base, only, pages } = parseArgs(process.argv.slice(2));
  if (only && !checks[only]) throw new Error(`不明な検査: ${only}`);
  let failures = 0;
  for (const [name, check] of Object.entries(checks)) {
    if (only && name !== only) continue;
    for (const path of pages) {
      try {
        const reason = await check(base, path);
        if (reason) { console.log(`NG ${name} ${path} ${reason}`); failures++; }
        else console.log(`OK ${name} ${path}`);
      } catch (error) {
        console.log(`NG ${name} ${path} ${error.message}`);
        failures++;
      }
    }
  }
  if (failures) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`NG probe ${error.message}`);
  process.exitCode = 1;
});
