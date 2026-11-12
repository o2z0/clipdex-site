import { openPage, sleep } from "./kit.mjs";
import { riseState } from "../../assets/lp/rise.js";
import { focusTransform } from "../../assets/lp/stage.js";

const usage = "Usage: node tests/cdp/probe.mjs <base-url> [--only <name>] [--pages / /full/ …]";
const expectedEdition = new Map([
  ["/", "store"],
  ["/en/", "store"],
  ["/full/", "full"],
  ["/en/full/", "full"],
]);
const expectedFeatures = new Map([["/", 5], ["/en/", 5], ["/full/", 8], ["/en/full/", 8]]);
const firstFeature = new Map([["/", "history"], ["/en/", "history"], ["/full/", "autopaste"], ["/en/full/", "autopaste"]]);
const STORE_PAGES = new Set(["/", "/en/"]);
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
      header: width === 375 ? await page.ev(`(() => {
        const row = document.querySelector('header .navrow');
        const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, mid: r.top + r.height / 2, height: r.height }; };
        return { row: box(row), items: [row.querySelector('.brand'), ...row.querySelectorAll('.navlinks > :not(.navlink--wide):not(.nav-sep)')].map(box), wideHidden: [...row.querySelectorAll('.navlink--wide')].every((el) => el.getBoundingClientRect().height === 0) };
      })()`) : null,
      errors: errorsOf(page),
    }));
    if (result.overflow !== 0) failures.push(`${width}px overflow=${result.overflow}`);
    if (result.header) {
      const { row, items, wideHidden } = result.header;
      // 狭幅では「価格」「購入」(.navlink--wide) を出さない (縦に折れるのを避ける、Masa 2026-11-12)。それ以外は全部 1 行に見えていること
      if (!wideHidden) failures.push(`${width}px 価格・購入が狭幅で出ている`);
      if (items.some((item) => item.height > 40 || Math.abs(item.mid - row.mid) > 3 || item.left < row.left - 1 || item.right > row.right + 1)) failures.push(`${width}px header=${JSON.stringify(result.header)}`);
    }
    if (result.errors) failures.push(`${width}px ${result.errors}`);
  }
  return failures.join("; ");
}

async function fit(base, path) {
  const failures = [];
  for (const [width, height] of [[1280, 800], [1440, 900], [900, 800]]) {
    const result = await visit(base, path, { width, height }, async (page) => {
      const end = await page.ev(`(() => {
        const entry = document.querySelector('[data-rise]');
        return entry.getBoundingClientRect().top + scrollY + entry.offsetHeight - innerHeight;
      })()`);
      await page.scrollTo(end, { io: false });
      await sleep(100);
      return {
        state: await page.ev(`(() => {
          const el = document.querySelector('[data-window]');
          const rect = el.getBoundingClientRect();
          const header = document.querySelector('header').getBoundingClientRect().height;
          const style = getComputedStyle(el);
          return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom,
            width: rect.width, height: rect.height, header,
            progress: Number(document.querySelector('[data-rise]').dataset.riseProgress),
            border: style.borderTopColor, shadow: style.boxShadow };
        })()`),
        errors: errorsOf(page),
      };
    });
    const s = result.state;
    const tolerance = 1;
    if (s.progress < 0.99 || s.x < -tolerance || s.right > width + tolerance ||
        s.y < s.header - tolerance || s.bottom > height + tolerance ||
        s.width > width * 0.94 + tolerance || s.height > height - s.header - 32 + tolerance) {
      failures.push(`${width}x${height} 窓=${JSON.stringify(s)}`);
    }
    if (result.errors) failures.push(`${width}x${height} ${result.errors}`);
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
    const featureCount = expectedFeatures.get(path);
    if (featureCount === undefined) failures.push(`機能数の期待値が未定義: ${path}`);
    else {
      const bodies = await page.ev(`[...document.querySelectorAll('.stage .pill-body')].map(el => el.getBoundingClientRect().height)`);
      if (bodies.length !== featureCount || bodies.some((height) => height <= 0)) failures.push(`説明文=${JSON.stringify(bodies)} expected=${featureCount}`);
      const images = await page.ev(`[...document.querySelectorAll('.stage .scene img')].length`);
      for (let i = 0; i < images; i++) {
        await page.ev(`document.querySelectorAll('.stage .scene img')[${i}].scrollIntoView({ block: 'center', behavior: 'instant' })`);
        await sleep(100);
        await page.idle();
      }
      const media = await page.ev(`({
        images: [...document.querySelectorAll('.stage .scene img')].map(el => ({ complete: el.complete, width: el.naturalWidth })),
        videos: [...document.querySelectorAll('.stage .scene video')].map(el => ({ poster: el.poster, time: el.currentTime }))
      })`);
      if (media.images.some((image) => !image.complete || image.width <= 0)) failures.push(`画像未読込=${JSON.stringify(media.images)}`);
      if (media.videos.some((video) => !video.poster || video.time !== 0)) failures.push(`動画 poster=${JSON.stringify(media.videos)}`);
    }
    if (page.errors.length) failures.push(errorsOf(page));
    return failures.join("; ");
  } finally {
    page.close();
  }
}

async function showStage(page) {
  const top = await page.ev(`(() => {
    const stage = document.querySelector('[data-stage]');
    return stage.getBoundingClientRect().top + scrollY + 72;
  })()`);
  await page.scrollTo(top, { io: false });
  await sleep(100);
}

async function stageState(page) {
  return page.ev(`(() => ({
    expanded: [...document.querySelectorAll('.stage .pill')].map(el => el.getAttribute('aria-expanded')),
    active: document.querySelector('[data-stage]').dataset.activeFeature,
    scenes: [...document.querySelectorAll('.stage .scene')].map(el => ({ id: el.dataset.scene, opacity: getComputedStyle(el).opacity })),
    focus: document.activeElement?.dataset.feature ?? document.activeElement?.className ?? ''
  }))()`);
}

async function stageKey(page, name) {
  const keys = {
    Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
    Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
    Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
    Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  };
  const key = keys[name];
  const down = await page.send("Input.dispatchKeyEvent", { type: "keyDown", ...key });
  const up = await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...key, text: undefined });
  if (down.error || up.error) throw new Error(`key ${name}: ${down.error?.message ?? up.error?.message}`);
}

async function keyboard(base, path) {
  return visit(base, path, {}, async (page) => {
    const failures = [];
    await showStage(page);
    for (let i = 0; i < 20; i++) {
      const focused = await page.ev("document.activeElement?.matches('.stage .pill') ?? false");
      if (focused) break;
      await stageKey(page, "Tab");
    }
    const first = await page.ev("document.activeElement?.dataset.feature");
    if (first !== firstFeature.get(path)) failures.push(`Tab の最初=${first}`);
    const checkOpen = async (label) => {
      // 切り替えの完了を最大 600ms 待つ (動画の scene は再生開始の処理で数十 ms 遅れることがある)
      let state;
      for (let waited = 0; waited <= 600; waited += 50) {
        await sleep(50);
        state = await stageState(page);
        if (state.scenes.find((scene) => scene.id === first)?.opacity === "1" &&
            state.scenes.every((scene) => scene.id === first || scene.opacity === "0")) break;
      }
      if (state.active !== first || state.expanded.filter((value) => value === "true").length !== 1 ||
          state.scenes.find((scene) => scene.id === first)?.opacity !== "1" ||
          state.scenes.some((scene) => scene.id !== first && scene.opacity !== "0")) failures.push(`${label} 開く=${JSON.stringify(state)}`);
    };
    const checkClosed = async (label) => {
      await sleep(250);
      const state = await stageState(page);
      if (state.active !== "overview" || state.expanded.some((value) => value !== "false") ||
          state.focus !== first || state.scenes.find((scene) => scene.id === "overview")?.opacity !== "1" ||
          state.scenes.some((scene) => scene.id !== "overview" && scene.opacity !== "0")) failures.push(`${label} 閉じる=${JSON.stringify(state)}`);
    };
    await stageKey(page, "Enter");
    await checkOpen("Enter");
    await stageKey(page, "Escape");
    await checkClosed("Esc");
    await stageKey(page, "Space");
    await checkOpen("Space");
    await stageKey(page, "Escape");
    await checkClosed("Space→Esc");
    await stageKey(page, "Enter");
    await checkOpen("閉じるボタン前");
    for (let i = 0; i < 10; i++) {
      if (await page.ev("document.activeElement?.matches('.stage-close') ?? false")) break;
      await stageKey(page, "Tab");
    }
    if (!(await page.ev("document.activeElement?.matches('.stage-close') ?? false"))) failures.push("Tab で閉じるボタンに到達しない");
    else { await stageKey(page, "Enter"); await checkClosed("閉じるボタン"); }
    await stageKey(page, "Enter");
    await sleep(100);
    await stageKey(page, "Escape");
    await checkClosed("寄り途中の Esc");
    if (page.errors.length) failures.push(errorsOf(page));
    return failures.join("; ");
  });
}

async function rapid(base, path) {
  return visit(base, path, {}, async (page) => {
    await showStage(page);
    const buttons = await page.ev("[...document.querySelectorAll('.stage .pill')].map(el => el.dataset.feature)");
    for (let i = 0; i < buttons.length; i++) {
      await page.click(".stage .pill", i);
      if (i < buttons.length - 1) await sleep(50);
    }
    await sleep(1000);
    const state = await page.ev(`(() => {
      const view = document.querySelector('.stage-view');
      const scene = document.querySelector('.scene.is-active');
      const matrix = new DOMMatrixReadOnly(getComputedStyle(scene).transform);
      return { active: document.querySelector('[data-stage]').dataset.activeFeature,
        scenes: [...document.querySelectorAll('.stage .scene')].map(el => ({ id: el.dataset.scene, opacity: getComputedStyle(el).opacity })),
        scene: { w: scene.offsetWidth, h: scene.offsetHeight, left: scene.offsetLeft, top: scene.offsetTop },
        naturalWidth: scene.querySelector('img, video').naturalWidth || scene.querySelector('video')?.videoWidth,
        dpr: devicePixelRatio, view: { w: view.clientWidth, h: view.clientHeight },
        x: matrix.m41, y: matrix.m42, scale: matrix.m11 };
    })()`);
    const last = buttons.at(-1);
    const focus = await page.ev(`document.querySelector('.pill[data-feature=${JSON.stringify(last)}]').dataset.focus`);
    const [x, y, zoom] = focus.split(",").map(Number);
    const expected = focusTransform(state.scene, state.view, { x, y, zoom, maxZoom: state.naturalWidth / (state.scene.w * state.dpr) });
    const failures = [];
    if (state.active !== last || state.scenes.find((scene) => scene.id === last)?.opacity !== "1" ||
        state.scenes.some((scene) => scene.id !== last && scene.opacity !== "0")) failures.push(`最後の scene=${JSON.stringify(state)}`);
    if (Math.abs(state.x - expected.x) > 2 || Math.abs(state.y - expected.y) > 2 || Math.abs(state.scale - expected.scale) > 0.02) failures.push(`寄り=${JSON.stringify(state)} expected=${JSON.stringify(expected)}`);
    if (page.errors.length) failures.push(errorsOf(page));
    return failures.join("; ");
  });
}

async function resize(base, path) {
  const page = await openPage({ url: new URL(path, base).href, width: 1280, height: 800 });
  try {
    await page.idle();
    await showStage(page);
    await page.click(".stage .pill", 0);
    const failures = [];
    for (const width of [1280, 900, 375]) {
      await page.send("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 1, mobile: width < 768, screenWidth: width, screenHeight: 800 });
      await sleep(250);
      const state = await page.ev(`(() => {
        const stage = document.querySelector('[data-stage]').getBoundingClientRect();
        const view = document.querySelector('.stage-view').getBoundingClientRect();
        return { overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          stage: { left: stage.left, right: stage.right }, view: { left: view.left, right: view.right },
          active: document.querySelector('[data-stage]').dataset.activeFeature };
      })()`);
      if (state.overflow !== 0 || state.view.left < state.stage.left - 1 || state.view.right > state.stage.right + 1 || state.active !== firstFeature.get(path)) failures.push(`${width}px ${JSON.stringify(state)}`);
    }
    if (page.errors.length) failures.push(errorsOf(page));
    return failures.join("; ");
  } finally { page.close(); }
}

async function stable(base, path) {
  return visit(base, path, { width: 1280, height: 800 }, async (page) => {
    await showStage(page);
    const snapshot = () => page.ev(`(() => {
      const rect = (el) => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
      return { heading: rect(document.querySelector('.stage h2')),
        pills: [...document.querySelectorAll('.stage .pill')].map(rect),
        panel: rect(document.querySelector('.stage-info')) };
    })()`);
    const baseline = await snapshot();
    const failures = [];
    const compare = async (label) => {
      const current = await snapshot();
      for (const key of ["heading", "panel"]) {
        if (current[key].some((value, index) => Math.abs(value - baseline[key][index]) > 0.5)) failures.push(`${label} ${key} moved ${JSON.stringify(current[key])}`);
      }
      current.pills.forEach((rect, index) => {
        if (rect.some((value, axis) => Math.abs(value - baseline.pills[index][axis]) > 0.5)) failures.push(`${label} pill ${index} moved ${JSON.stringify(rect)}`);
      });
    };
    const buttons = await page.ev("document.querySelectorAll('.stage .pill').length");
    for (let i = 0; i < buttons; i++) {
      await page.click(".stage .pill", i);
      await sleep(250);
      await compare(`open ${i}`);
      const content = await page.ev(`(() => {
        const panel = document.querySelector('.stage-info .pill-body.is-active');
        return { client: panel?.clientHeight ?? 0, scroll: panel?.scrollHeight ?? 0 };
      })()`);
      if (content.scroll > content.client + 0.5) failures.push(`panel ${i} overflow=${JSON.stringify(content)}`);
      await page.click(".stage .pill", i);
      await compare(`close ${i}`);
    }
    if (page.errors.length) failures.push(errorsOf(page));
    return failures.join("; ");
  });
}

async function zoom(base, path) {
  const page = await openPage({ width: 1440, height: 900 });
  try {
    await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false, screenWidth: 1440, screenHeight: 900 });
    await page.send("Page.navigate", { url: new URL(path, base).href });
    await page.idle();
    await showStage(page);
    const buttons = await page.ev("[...document.querySelectorAll('.stage .pill')].map(el => el.dataset.feature)");
    const failures = [];
    for (let i = 0; i < buttons.length; i++) {
      await page.click(".stage .pill", i);
      await sleep(900);
      const state = await page.ev(`(() => {
        const view = document.querySelector('.stage-view');
        const scene = document.querySelector('.scene.is-active');
        const image = scene.querySelector('img, video');
        const matrix = new DOMMatrixReadOnly(getComputedStyle(scene).transform);
        const button = document.querySelector('.stage .pill[aria-expanded="true"]');
        return { id: scene.dataset.scene, focus: button.dataset.focus,
          scene: { w: scene.offsetWidth, h: scene.offsetHeight, left: scene.offsetLeft, top: scene.offsetTop },
          view: { w: view.clientWidth, h: view.clientHeight }, naturalWidth: image.naturalWidth || image.videoWidth || Number(image.getAttribute('width')),
          scale: matrix.m11, x: matrix.m41, y: matrix.m42, dpr: devicePixelRatio };
      })()`);
      const [x, y, requested] = state.focus.split(",").map(Number);
      const maxZoom = state.naturalWidth / (state.scene.w * state.dpr);
      const expected = focusTransform(state.scene, state.view, { x, y, zoom: requested, maxZoom });
      const pixelRatio = state.scene.w * state.scale * state.dpr / state.naturalWidth;
      console.log(`METRIC zoom ${path} ${state.id} focus=${x},${y} requested=${requested.toFixed(2)} effective=${state.scale.toFixed(3)} device/natural=${pixelRatio.toFixed(3)} clamped=${expected.clamped}`);
      if (!state.naturalWidth || pixelRatio > 1.001) failures.push(`${state.id} device/natural=${pixelRatio}`);
      if (expected.clamped) failures.push(`${state.id} focus clamped`);
      if (Math.abs(state.x - expected.x) > 2 || Math.abs(state.y - expected.y) > 2 || Math.abs(state.scale - expected.scale) > 0.02) failures.push(`${state.id} actual=${JSON.stringify(state)} expected=${JSON.stringify(expected)}`);
    }
    if (page.errors.length) failures.push(errorsOf(page));
    return failures.join("; ");
  } finally { page.close(); }
}

async function video(base, path) {
  if (STORE_PAGES.has(path)) return "";
  const failures = [];
  await visit(base, path, {}, async (page) => {
    await showStage(page);
    await page.click('.stage .pill[data-feature="autopaste"]');
    await sleep(700);
    const playing = await page.ev(`(() => {
      const v = document.querySelector('.scene[data-scene="autopaste"] video');
      return { paused: v.paused, time: v.currentTime, ready: v.readyState };
    })()`);
    if (playing.paused || playing.time <= 0) failures.push(`autopaste 再生=${JSON.stringify(playing)}`);
    await page.click('.stage .pill[data-feature="autopaste"]');
    const closed = await page.ev(`(() => {
      const v = document.querySelector('.scene[data-scene="autopaste"] video');
      return { paused: v.paused, time: v.currentTime };
    })()`);
    if (!closed.paused || closed.time !== 0) failures.push(`autopaste 停止=${JSON.stringify(closed)}`);
    if (page.errors.length) failures.push(errorsOf(page));
  });
  await visit(base, path, { reduced: true }, async (page) => {
    await showStage(page);
    await page.click('.stage .pill[data-feature="autopaste"]');
    const state = await page.ev(`(() => {
      const v = document.querySelector('.scene[data-scene="autopaste"] video');
      return { paused: v.paused, time: v.currentTime, poster: v.poster };
    })()`);
    if (!state.paused || state.time !== 0 || !state.poster) failures.push(`reduced poster=${JSON.stringify(state)}`);
    if (page.errors.length) failures.push(errorsOf(page));
  });
  return failures.join("; ");
}

async function storeFacts(base, path) {
  if (!STORE_PAGES.has(path)) return "";
  return visit(base, path, {}, async (page) => {
    const text = await page.ev("document.querySelector('.entry').textContent + document.querySelector('.stage').textContent");
    const forbidden = ["自動ペースト", "Paste Stack", "ペースト記録", "アクセシビリティ", "貼り付けます", "Auto-paste", "Paste Records", "Accessibility", "it’s pasted", "it's pasted"];
    const found = forbidden.filter((word) => text.includes(word));
    return found.length ? `App Store 版に ${found.join(" / ")} が混入` : errorsOf(page);
  });
}

// トップだけ: 浮かぶ「フル版」案内が、入口では出ず・入口を過ぎると出て・帯 / 最後の CTA で引っ込み・× で閉じたら出ない
async function nudge(base, path) {
  if (!STORE_PAGES.has(path)) return "";
  return visit(base, path, {}, async (page) => {
    const failures = [];
    const at = async (label, expr, want) => {
      const y = await page.ev(expr);
      await page.scrollTo(y, { io: false });
      await sleep(600);
      const on = await page.ev("document.getElementById('full-nudge').classList.contains('is-on')");
      if (on !== want) failures.push(`${label} is-on=${on} 期待=${want}`);
    };
    await at("入口", "0", false);
    await at("プライバシー", "document.getElementById('privacy').getBoundingClientRect().top + scrollY + 300", true);
    await at("帯", "document.getElementById('full-band').getBoundingClientRect().top + scrollY - 200", false);
    await at("最後の CTA", "document.getElementById('download').getBoundingClientRect().top + scrollY - 200", false);
    await at("プライバシー (戻り)", "document.getElementById('privacy').getBoundingClientRect().top + scrollY + 300", true);
    await page.ev("document.querySelector('#full-nudge button').click()");
    await sleep(300);
    if (await page.ev("document.getElementById('full-nudge').classList.contains('is-on')")) failures.push("× のあとも出ている");
    const errors = errorsOf(page);
    if (errors) failures.push(errors);
    return failures.join("; ");
  });
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

const checks = { boot, widths, fit, reduced, idle, "reload-mid": reloadMid, nojs, keyboard, rapid, resize, stable, zoom, video, "store-facts": storeFacts, nudge, frames };

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
