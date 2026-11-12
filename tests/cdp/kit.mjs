// cdp-kit: 照合の probe 用の headless Chrome + CDP ラッパー。依存ゼロ、Node 22+。
// 使い方は同じディレクトリの README.md。**import させずにコピーして使う**（sites/<name>/tests/cdp/kit.mjs に丸ごと、書き換えない）。
// サイト固有の設定（BLOCK・参照コピー・固定応答・patch）は横に置く lib.mjs（site.example.mjs の写し）に書く。
//
// 各サイトの tests/cdp/lib*.mjs（loops の lib-det・exoape・oho・bravis ほか 49 本）から共通部分を集め、
// 照合の最中に踏み直した作法を判定として入れた（site-study 7 回目の見直し、2026-11-10）:
//   - クリックの後にマウスを画面の外へ退避する（止まったマウスの下で中身が動くと Chrome が合成 mousemove を出す）
//   - 入力（wheel / touch / mouse / key）と IntersectionObserver の到着を期限内に確かめ、届かなければ NG で止める
//   - ページの中の待ちは実時間のタイマーで（DET の下でページの setTimeout を待つと誰も進めずハングする）
//   - headless を並列に開かない（同じプロセスの 2 枚目は例外、別プロセスとはロックで順番待ち）
//   - プロセス全体の上限時間（既定 10 分）。終了時に所要時間を出し、上限の 8 割を超えたら WARN
//   - until() は期限切れで例外（戻り値を捨てて素通りしない）。真偽で受けたいときは poll()
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const KIT = "cdp-kit 2026-11-11";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const UA = {
  PC: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  TB: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  SP: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
};
// 計測・広告（どのサイトでも本家の挙動に関係しない）。サイトの BLOCK はこれに足す
export const BLOCK_COMMON = /googletagmanager\.com|google-analytics\.com|doubleclick\.net|facebook\.(net|com)\/tr|connect\.facebook\.net|hotjar|clarity\.ms|ads-twitter\.com|analytics\.twitter\.com|static\.cloudflareinsights/;
// 通信の空きを待つときに数えない要求（終わらないことがある）
export const IDLE_IGNORE = /^data:|fonts\.(googleapis|gstatic)\.com|youtube|ytimg|googlevideo/;

// ---------------------------------------------------------------- プロセスの後始末・上限時間・直列のロック

// Chrome と一時プロファイルの組。exit 待ちで消し、途中で落ちても process の exit で消す（1 回 50MB ほど残る）
const CHILDREN = new Map();
const dropProfile = (chrome) => { const prof = CHILDREN.get(chrome); CHILDREN.delete(chrome); if (prof) try { rmSync(prof, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {} };
let LIMIT = null; let LOCKWAIT = 0; let TIMEDOUT = false;
process.on("exit", () => {
  for (const c of [...CHILDREN.keys()]) { try { c.kill("SIGKILL"); } catch {} dropProfile(c); }
  if (lockHeld > 0) { lockHeld = 1; releaseLock(); }
  // 所要はロック待ちを除いて数える（別の probe を待った分は上限の見直しに関係しない）
  if (LIMIT && !TIMEDOUT) { const s = (Date.now() - LIMIT.t0 - LOCKWAIT) / 1000; if (s > LIMIT.ms / 1000 * 0.8) console.error(`WARN 所要 ${s.toFixed(0)} 秒が上限 ${LIMIT.ms / 1000} 秒の 8 割を超えた（${LIMIT.label}）。上限を見直す`); }
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(1));

// プロセス全体の上限時間。超えたら TIMEOUT を出して終了コード 2。openPage が既定（10 分）で張るので、普段の所要時間を測ってから明示する
// タイマーはページが開いている間だけ ref（Chrome が落ちて WebSocket が閉じても、黙って終わらず TIMEOUT か例外になる）
const arm = (rest) => { if (LIMIT.timer) clearTimeout(LIMIT.timer); LIMIT.timer = setTimeout(() => { TIMEDOUT = true; console.error(`TIMEOUT ${LIMIT.label} ${LIMIT.ms / 1000} 秒`); process.exit(2); }, rest); if (!openCount) LIMIT.timer.unref(); };
export function deadline(ms, label = "probe") {
  LIMIT = { ms, label, t0: Date.now(), auto: false, timer: null }; arm(ms);
  return LIMIT;
}
const refLimit = () => { if (LIMIT && LIMIT.timer) { if (openCount) LIMIT.timer.ref(); else LIMIT.timer.unref(); } };

// 別プロセスの headless と並ばないためのロック（mkdir は原子的）。持ち主の pid が死んでいれば奪う
const LOCK = join(tmpdir(), "websketch-cdp-kit.lock");
let lockHeld = 0;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
async function acquireLock(ms) {
  if (lockHeld++) return;
  const t0 = Date.now(); let told = false;
  // 待った分だけ上限を延ばす（別の probe を 5 分待って自分の上限が切れないように）
  const got = () => { const w = Date.now() - t0; if (w > 50) { LOCKWAIT += w; if (LIMIT) arm(LIMIT.ms - (Date.now() - LIMIT.t0 - LOCKWAIT)); } };
  for (;;) {
    try { mkdirSync(LOCK); writeFileSync(join(LOCK, "pid"), String(process.pid)); got(); return; } catch (e) { if (e.code !== "EEXIST") throw e; }
    let pid = 0; try { pid = Number(readFileSync(join(LOCK, "pid"), "utf8")); } catch {}
    if (pid && !alive(pid)) { try { rmSync(LOCK, { recursive: true, force: true }); } catch {} continue; }
    if (!pid && Date.now() - t0 > 2000) { try { rmSync(LOCK, { recursive: true, force: true }); } catch {} continue; } // pid を書く前に落ちた残骸
    if (!told) { console.error(`cdp-kit: 別の probe（pid ${pid || "?"}）が headless を使用中。終わるまで待つ`); told = true; }
    if (Date.now() - t0 > ms) { lockHeld--; throw new Error(`NG lock: ${ms / 1000} 秒待っても別の probe（pid ${pid}）が終わらない`); }
    await sleep(200);
  }
}
function releaseLock() {
  if (lockHeld <= 0) return;
  if (--lockHeld === 0) { try { if (Number(readFileSync(join(LOCK, "pid"), "utf8")) === process.pid) rmSync(LOCK, { recursive: true, force: true }); } catch {} }
}

// ---------------------------------------------------------------- ページに差す script

// 乱数・時計（Date も new Date() も）・rAF・setTimeout / setInterval を仮想化する。__step(n) で 1/60 秒ずつ進め、
// 時刻の来たタイマーを登録順に → rAF の順に呼ぶ。video の play は解決済みの Promise にする（再生の進みは実時間なので止める）。
// probe の待ちは __rt（実時間）で回す（HELPERS の wait / until はそちらを使う）。
// timeStamp: Event.timeStamp も仮想の時計で読む（Vue 2 の invoker は「付けた flush の時刻より古いイベント」を捨てる）
// waapi: WAAPI（el.animate・CSS animation・CSS transition）も手送りにする（WAAPI_SCRIPT）。既定は false = WAAPI は実時間で進む
export const DET_SCRIPT = (seed = 1, { epoch = Date.UTC(2026, 10, 8, 3, 0, 0), timeStamp = true, waapi = false, waapiCatch = 8 } = {}) => `(() => {
  window.__rt = { setTimeout: setTimeout.bind(window), clearTimeout: clearTimeout.bind(window), now: performance.now.bind(performance) };
  let s = ${seed} >>> 0;
  Math.random = () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; window.__rnd = (window.__rnd || 0) + 1; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const base = ${Number(epoch)}; let now = base;
  const RD = Date;
  class VD extends RD { constructor(...a) { super(...(a.length ? a : [Math.floor(now)])); } static now() { return Math.floor(now); } }
  window.Date = VD;
  performance.now = () => now - base + 500;
  let q = [], id = 0;
  window.requestAnimationFrame = (cb) => { q.push([++id, cb]); return id; };
  window.cancelAnimationFrame = (i) => { q = q.filter((x) => x[0] !== i); };
  window.__frames = 0;
  let timers = [], tid = 0;
  const addT = (fn, ms, args, every) => { const id = ++tid; timers.push({ id, due: now + Math.max(0, +ms || 0), fn, args, every }); return id; };
  window.setTimeout = (fn, ms, ...args) => addT(fn, ms, args, 0);
  window.setInterval = (fn, ms, ...args) => addT(fn, ms, args, Math.max(1, +ms || 0));
  window.clearTimeout = window.clearInterval = (id) => { timers = timers.filter((t) => t.id !== id); };
  const runTimers = () => { for (let guard = 0; guard < 10000; guard++) { let best = null; for (const t of timers) if (t.due <= now && (!best || t.due < best.due || (t.due === best.due && t.id < best.id))) best = t; if (!best) return; if (best.every) best.due += best.every; else timers = timers.filter((t) => t !== best); typeof best.fn === "function" ? best.fn(...best.args) : (0, eval)(best.fn); } };
  window.__timers = () => timers.length;
  // ブラウザのフレームと同じ順: タイマー → アニメの更新（WAAPI）→ rAF。rAF の中で作ったアニメは次のフレームから進む
  window.__step = (n = 1) => { for (let k = 0; k < n; k++) { now += 1000 / 60; window.__frames++; runTimers(); if (window.__waapiStep) window.__waapiStep(1000 / 60); const cbs = q; q = []; for (const [, cb] of cbs) cb(performance.now()); } return window.__frames; };
  HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
  ${timeStamp ? `Object.defineProperty(Event.prototype, "timeStamp", { configurable: true, get() { return performance.now(); } });` : ""}
  ${waapi ? WAAPI_SCRIPT + (waapiCatch > 0 ? WAAPI_CATCH(waapiCatch) : "") : ""}
})();`;

// WAAPI の手送り（DET_SCRIPT の waapi: true で中に入る）。DET の時計は JS の関数を差し替えるだけなので、WAAPI と CSS のアニメは
// 実時間で進み、dump は「止まるまで実時間で待つ」しかなかった（contentarchitecture、照合の待ち ≈2 時間）。
//   - 走っているアニメは全部 pause で止めておき、__step のたびに currentTime を 1 フレーム分（× playbackRate）進める
//   - 終わりに届いたら finish()（finish イベント・finished の Promise・transitionend は本物どおり出る）。無限の繰り返しは進め続ける
//   - サイトが pause() したものは進めない。play() / reverse() は止めたまま「走っている」扱いに戻す。playState は「走っている」を返す
//   - CSS animation は animation-play-state: paused の間は進めない（CSSAnimation の pause は CSS の切り替えより強いので、毎フレーム読む）
//   - 初めて見つけた CSS animation / transition は 0 から数える（作られてから見つかるまでの実時間を入れない）
//   - startTime・document.timeline.currentTime も仮想の時計で読み書きする（Motion は startTime に自分の時刻を書いて同期する）
//   - ScrollTimeline / ViewTimeline のアニメは触らない（スクロールで進む）
// 入らないもの: iframe の中
export const WAAPI_SCRIPT = `(() => {
  const A = Animation.prototype;
  const P = { play: A.play, pause: A.pause, finish: A.finish, cancel: A.cancel, reverse: A.reverse };
  const realState = Object.getOwnPropertyDescriptor(A, "playState").get;
  const intent = new WeakMap(); // "run" | "pause"。無い = 終わった・取り消した・まだ見ていない
  const seen = new WeakSet();
  // 手送りするのは document.timeline のアニメだけ（ScrollTimeline / ViewTimeline はスクロールで進む。Motion の useScroll はこれを使う）
  const ours = (a) => a.timeline === document.timeline;
  const hold = (a) => { if (!ours(a)) return; intent.set(a, "run"); seen.add(a); P.pause.call(a); };
  A.play = function () { P.play.call(this); hold(this); };
  A.reverse = function () { P.reverse.call(this); hold(this); };
  A.pause = function () { intent.set(this, "pause"); seen.add(this); P.pause.call(this); };
  A.finish = function () { intent.delete(this); seen.add(this); P.finish.call(this); };
  A.cancel = function () { intent.delete(this); seen.add(this); P.cancel.call(this); };
  Object.defineProperty(A, "playState", { configurable: true, get() { return intent.get(this) === "run" ? "running" : realState.call(this); } });
  // startTime と document.timeline は仮想の時計（performance.now）で読み書きする。Motion は frameloop の時刻（= 仮想の performance.now）を
  // startTime に書いて同期する。素のままだと実時間の timeline で解釈され、DET が実時間より先に進むと開始が未来になって止まる（contentarchitecture）
  const startDesc = Object.getOwnPropertyDescriptor(A, "startTime");
  Object.defineProperty(A, "startTime", { configurable: true,
    get() { if (intent.get(this) !== "run") return startDesc.get.call(this); const ct = this.currentTime; return ct == null ? null : performance.now() - ct / (this.playbackRate || 1); },
    set(v) { if (v == null || !ours(this)) return startDesc.set.call(this, v); hold(this); this.currentTime = (performance.now() - v) * this.playbackRate; } });
  Object.defineProperty(DocumentTimeline.prototype, "currentTime", { configurable: true, get() { return performance.now(); } });
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (...args) { const a = animate.apply(this, args); hold(a); return a; };
  const cssPaused = (a) => {
    if (typeof CSSAnimation === "undefined" || !(a instanceof CSSAnimation) || !a.effect || !a.effect.target) return false;
    const cs = getComputedStyle(a.effect.target, a.effect.pseudoElement || null);
    const names = cs.animationName.split(","), states = cs.animationPlayState.split(",");
    const i = Math.max(0, names.findIndex((n) => n.trim() === a.animationName));
    return (states[i % states.length] || "running").trim() === "paused";
  };
  window.__waapi = { stepped: 0, finished: 0 };
  window.__waapiStep = (dt) => {
    for (const a of document.getAnimations()) {
      if (!ours(a)) continue;
      let s = intent.get(a);
      if (s === undefined) {
        if (realState.call(a) !== "running") { seen.add(a); continue; }
        const first = !seen.has(a); hold(a); if (first) a.currentTime = 0; s = "run";
      }
      if (s !== "run") continue;
      if (realState.call(a) === "running") P.pause.call(a); // updatePlaybackRate などで走り出したら止め直す
      if (cssPaused(a)) continue;
      const rate = a.playbackRate, t = (a.currentTime || 0) + dt * rate;
      const end = a.effect ? a.effect.getComputedTiming().endTime : 0;
      if (dt > 0) window.__waapi.stepped++;
      if ((rate > 0 && Number.isFinite(end) && t >= end) || (rate < 0 && t <= 0)) { intent.delete(a); P.finish.call(a); window.__waapi.finished++; }
      else a.currentTime = t;
    }
  };
})();`;

// DET を使わない回の乱数だけの固定（mulberry32）。呼び出し元のファイル別に数える（window.__rnd.by。回数のずれを探すとき）
// 拾い遅れの見回り（waapi: true のとき既定でオン、waapiCatch: ms の間隔、0 で外す。mystaticself、2026-11-11）。
// WAAPI_SCRIPT は新しい CSS transition / animation を次の __step で初めて見つけて 0 から数える。見つける前に probe が通信待ち
// （step の idle など）で実時間を使うと、その間にアニメが実時間で走り終わり、「終わった」状態で見つかって手送りされない
// （move.js の 0.5 秒の transition でパネルが飛び、本家どうしでも 2 通りに分かれた）。実時間の __rt.setTimeout で ms ごとに
// style を確定して __waapiStep(0) を呼び、生まれた直後に拾って止める（仮想時間は進めない）。回数と例外は window.__waapi に数え、
// 例外は openPage の step が errors に「NG waapi catch」で積む
export const WAAPI_CATCH = (ms = 8) => `
  window.__waapi.caught = 0; window.__waapi.catchErr = 0; window.__waapi.catchMsg = "";
  (function loop() {
    try { if (document.documentElement) { document.documentElement.getBoundingClientRect(); window.__waapiStep(0); window.__waapi.caught++; } }
    catch (e) { window.__waapi.catchErr++; window.__waapi.catchMsg = String((e && e.message) || e); }
    window.__rt.setTimeout(loop, ${Number(ms)});
  })();
`;

export const SEED = (seed = 12345) => `(() => {
  let a = ${seed} >>> 0; const R = (window.__rnd = { n: 0, by: {} });
  Math.random = function () { R.n++; try { const l = (new Error().stack || "").split("\\n")[2] || ""; const f = (l.match(/\\/([^\\/?:]+)(?:\\?[^:]*)?:\\d+:\\d+\\)?$/) || [])[1] || "?"; R.by[f] = (R.by[f] || 0) + 1; } catch {}
    a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
})();`;

// gsap の to / from / fromTo / set と timeline の子を、生成時刻・対象の名前・vars で window.__tw に積む。
// keys: gsap を受ける global の名前（本家が webpack の中に持つなら、bundle に差した出口の名前も足す）
export const TRACE_GSAP = (keys = ["gsap"]) => `(() => {
  const T = (window.__tw = []);
  const name = (t) => { const a = t && t.jquery ? [...t] : Array.isArray(t) || t instanceof NodeList ? [...t] : [t];
    return a.slice(0, 3).map((el) => typeof el === "string" ? el : typeof el === "function" ? "fn" : el && el.nodeType === 1 ? el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.classList.length ? "." + [...el.classList].slice(0, 2).join(".") : "") : String(el)).join(",") + (a.length > 3 ? "+" + (a.length - 3) : ""); };
  const leaf = (x) => typeof x === "function" ? "fn" : x && typeof x === "object" ? (x.nodeType || x.jquery ? name(x) : Array.isArray(x) ? x.slice(0, 6).map(leaf) : "obj") : x;
  const clean = (v, d = 0) => { if (!v || typeof v !== "object") return v; const o = {}; for (const k in v) { const x = v[k]; o[k] = x && typeof x === "object" && !x.nodeType && !x.jquery && !Array.isArray(x) && d < 1 ? clean(x, d + 1) : leaf(x); } return o; };
  const wrap = (obj, label) => { for (const m of ["to", "from", "fromTo", "set"]) { const f = obj[m]; if (typeof f !== "function" || f.__w) continue;
    const g = function (t, a, b, c) { try { T.push({ t: Math.round(performance.now()), via: label, m, el: name(t), v: clean(m === "fromTo" ? b : a), from: m === "fromTo" ? clean(a) : undefined, pos: m === "fromTo" ? c : b }); } catch {} return f.apply(this, arguments); };
    g.__w = 1; obj[m] = g; } };
  for (const key of ${JSON.stringify(keys)}) { let G;
    Object.defineProperty(window, key, { configurable: true, get: () => G, set: (v) => { G = v; try { wrap(v, "gsap@" + v.version);
      const tl = v.core && v.core.Timeline; if (tl && tl.prototype) wrap(tl.prototype, "gsap-tl"); } catch {} } }); }
})();`;

// font-display: optional の自前フォントを block で足し直す（最初の約 100ms に間に合わないとページが代替フォントのままになり、回によって字幅が変わる）
export const FONTS_BLOCK = `(() => {
  const fix = () => { for (const sh of document.styleSheets) { let rules; try { rules = sh.cssRules; } catch { continue; }
    for (const r of [...rules]) if (r.type === CSSRule.FONT_FACE_RULE && /font-display:\\s*optional/.test(r.cssText)) {
      try { sh.insertRule(r.cssText.replace(/font-display:\\s*optional/, "font-display: block"), sh.cssRules.length); window.__fontsFixed = (window.__fontsFixed || 0) + 1; } catch {} } } };
  document.addEventListener("DOMContentLoaded", fix, { once: true });
})();`;

// 入力と IntersectionObserver の到着を数える（window.__in）。CDP の入力も IO のコールバックも実時間で非同期に届くので、
// probe は数が増えたのを確かめてから次へ進む（p.wheel / p.swipe / p.settleIO が使う）。
// IO は observe() ごとに初回のコールバックが来るまでを pending として数える（pending が 0 = 全部の初回が届いた）
export const INPUTS = `(() => {
  const I = (window.__in = { io: 0, ioLast: 0 });
  const PEND = new Set();
  for (const t of ["wheel", "touchstart", "touchmove", "touchend", "mousemove", "mousedown", "mouseup", "click", "pointerdown", "pointerup", "keydown", "keyup", "scroll", "resize", "popstate", "hashchange"])
    addEventListener(t, () => { I[t] = (I[t] || 0) + 1; }, { capture: true, passive: true });
  const N = window.IntersectionObserver; if (!N) return;
  const RTnow = () => (window.__rt ? window.__rt.now() : performance.now());
  // pending は [observer の Set, 要素] の組。文書から外れた要素は初回が来ないことがあるので数えない（__ioPending()）
  class IO extends N {
    constructor(cb, opts) { const pend = new Set(); super((entries, obs) => { I.io += entries.length; I.ioLast = RTnow(); for (const e of entries) pend.delete(e.target); return cb(entries, obs); }, opts); this.__pend = pend; PEND.add(pend); }
    observe(el) { if (el) this.__pend.add(el); return super.observe(el); }
    unobserve(el) { this.__pend.delete(el); return super.unobserve(el); }
    disconnect() { this.__pend.clear(); return super.disconnect(); }
  }
  window.__ioPending = () => { let n = 0; for (const p of PEND) for (const el of p) if (el.isConnected) n++; return n; };
  window.IntersectionObserver = IO;
})();`;

// 外部プロトコル（mailto: / tel: など）のリンクの既定の動作を止める。headless でも Chrome は OS に渡すので、probe が押すたびに
// macOS のメールの作成ウィンドウが開いた（loops、2026-11-08）。window の bubble 側で止めるので、ページの capture 側の判定
// （defaultPrevented を見る閉じ方など）は変わらない。initScript の後に足す
export const GUARD = `addEventListener("click", (e) => { const a = e.target && e.target.closest && e.target.closest("a[href]"); if (a && /^(mailto|tel|sms|facetime|itms[a-z-]*):/i.test(a.getAttribute("href") || "")) e.preventDefault(); });`;

// run() の本文の前に差す。wait / until / sample は実時間（DET の下でも進む）。until は期限切れで例外、poll は真偽を返す
// （注意: run() に渡す文字列の中に // コメントを書かない。改行が詰まると後ろが黙って消える）
export const HELPERS = `
  const q = (s, r = document) => r.querySelector(s);
  const qa = (s, r = document) => [...r.querySelectorAll(s)];
  const cs = (el, p) => (el ? getComputedStyle(el)[p] : null);
  const num = (v, d = 1000) => (v == null ? null : Math.round(parseFloat(v) * d) / d);
  const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
  const RT = window.__rt || { setTimeout: setTimeout.bind(window), now: performance.now.bind(performance) };
  const wait = (ms) => new Promise((r) => RT.setTimeout(r, ms));
  const poll = async (fn, ms = 20000) => { const t0 = RT.now(); const ok = () => { const v = fn(); if (v && typeof v.then === "function") throw new Error("NG poll: fn が Promise を返した（同期の判定を渡す）"); return !!v; }; while (RT.now() - t0 < ms) { if (ok()) return true; await wait(50); } return ok(); };
  const until = async (fn, ms = 20000, label = "") => { if (await poll(fn, ms)) return true; throw new Error("NG until " + (ms / 1000) + "s: " + (label || String(fn).slice(0, 120))); };
  const sample = async (fn, ms, step = 50) => { const out = []; const t0 = RT.now(); while (RT.now() - t0 <= ms) { out.push({ t: Math.round(RT.now() - t0), ...fn() }); await wait(step); } return out; };
  const v3 = (v) => v && [num(v.x), num(v.y), num(v.z)];
`;

// ---------------------------------------------------------------- 合否の集計

// 合否を 1 行ずつ出し、done() で終了コードを決める（NG が 1 つでもあれば 1）。NG の行は「NG  名前  詳細」の形で、
// verify-all.sh が grep で拾える（tail -1 の要約だけだと、回によって出る NG の中身が残らない）
export function tally(label = "") {
  const ng = []; let n = 0;
  return {
    check(name, ok, detail = "") { n++; if (!ok) { ng.push(name); console.log(`NG  ${name}${detail ? "  " + (typeof detail === "string" ? detail : JSON.stringify(detail)) : ""}`); } return !!ok; },
    get ng() { return ng; },
    done() { console.log(`${label ? label + ": " : ""}${ng.length ? `NG ${ng.length} / ${n}` : `OK ${n}`}`); if (ng.length) process.exitCode = 1; return ng.length === 0; },
  };
}

// ---------------------------------------------------------------- openPage

let openCount = 0;

// opts:
//   url, width = 1440, height = 900
//   kind: "PC" | "TB" | "SP"（UA とタッチ。既定は width < spBelow なら SP）、spBelow = 768、ua（UA を直に）、touch（PC の UA のままタッチを足す）
//   det（DET_SCRIPT を差す）、seed、epoch、timeStamp、reduced（prefers-reduced-motion）
//   waapi = false（det と一緒に。WAAPI・CSS のアニメも step で進める = WAAPI_SCRIPT。止まるまで実時間で待つ dump の代わり）
//   waapiCatch = 8（waapi のとき、新しいアニメを実時間 ms ごとに拾う見回り = WAAPI_CATCH。0 で外す）
//   front = true（navigate の前に前面化とフォーカスの擬装。false で headless の hidden のまま）
//   initScript（DET の後・INPUTS と GUARD の前に差す）
//   block: RegExp（BLOCK_COMMON に足す）、blockCommon = true（false で BLOCK_COMMON を外す。GTM を落とすと止まる本家は false にして空の ga を initScript で置く。verification.md「決定的に撮る」11）、dropWrites = true（GET / HEAD / OPTIONS 以外を落とす）、detMedia = false（DET の回に video を読ませるか）
//   fulfill: [{ re, file, type, patch: [[re, to]], method = "GET" }]（参照コピー・固定応答で返す。file は URL かパス）
//   patch: [{ url, re, to: (m) => string, name }]（本家の応答を受けて書き換える。外れたら errors に PATCH MISS）
//   hold: [{ re, expr }]（ページで expr が真になるまで要求を止める）
//   park = { x: -1, y: -1 }（クリックの後にマウスを置く位置。null で退避しない）
//   parallel = false（同じプロセスで 2 枚目を開くと例外。並べて比べたいときだけ true）
//   timeout = 600000（プロセス全体の上限。deadline() を先に呼んでいればそちら）、lockMs = 600000
//   hideWebdriver = false（true で navigator.webdriver を false に。headless は UA を上書きしても webdriver が true のままで、
//     それで開幕しない本家がある。既存の lib はどれも true のままだったので既定は変えない。2026-11-10 実測）
//   chromeArgs: []（カメラの偽装など）、idleIgnore = IDLE_IGNORE、onEvent
export async function openPage(opts = {}) {
  let { url, width = 1440, height = 900, spBelow = 768, ua = null, touch = false, det = false, seed = 1, epoch, timeStamp = true, waapi = false, waapiCatch = 8, front = true, reduced = false,
    initScript = "", block = null, blockCommon = true, dropWrites = true, detMedia = false, fulfill = [], patch = [], hold = [], park = { x: -1, y: -1 },
    hideWebdriver = false, parallel = false, timeout = 600000, lockMs = 600000, chromeArgs = [], idleIgnore = IDLE_IGNORE, onEvent } = opts;
  if (!LIMIT) deadline(timeout, url);
  if (waapi && !det) throw new Error("NG waapi: det: true と一緒に使う（手送りの時計が無い）");
  if (openCount && !parallel) throw new Error("NG parallel: 同じプロセスで headless を 2 つ同時に開いている（verification.md「決定的に撮る」9。並べるなら parallel: true）");
  await acquireLock(lockMs);
  openCount++; refLimit();
  // g / y の付いた正規表現は test / match が lastIndex で揺れるので外す
  const once = (re) => (re && (re.global || re.sticky) ? new RegExp(re.source, re.flags.replace(/[gy]/g, "")) : re);
  fulfill = fulfill.map((x) => ({ ...x, re: once(x.re), patch: (x.patch || []).map(([re, to]) => [once(re), to]) }));
  patch = patch.map((x) => ({ ...x, url: once(x.url), re: once(x.re) }));
  hold = hold.map((x) => ({ ...x, re: once(x.re) }));
  const kind = opts.kind || (width < spBelow ? "SP" : "PC");
  const mobile = kind !== "PC";
  const prof = mkdtempSync(join(tmpdir(), "cdp-kit-"));
  const chrome = spawn(CHROME, [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${prof}`, `--window-size=${width},${height}`,
    "--no-first-run", "--hide-scrollbars", "--mute-audio",
    det ? "--autoplay-policy=document-user-activation-required" : "--autoplay-policy=no-user-gesture-required",
    "--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist", ...(hideWebdriver ? ["--disable-blink-features=AutomationControlled"] : []), ...chromeArgs, "about:blank",
  ], { stdio: "ignore" });
  CHILDREN.set(chrome, prof);
  chrome.once("exit", () => dropProfile(chrome));
  let ws; let id = 0; const pending = new Map();
  const errors = [], requests = [], blocked = [], held = [], fulfilled = [], stuck = []; const inflight = new Map();
  let port = null;
  for (let i = 0; i < 50 && !ws; i++) {
    try {
      port ??= Number(readFileSync(join(prof, "DevToolsActivePort"), "utf8").split("\n")[0]);
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
        ws.onmessage = (m) => {
          const d = JSON.parse(m.data);
          if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
          // 失敗しても要求を止めたままにしない（本家側だけ起動しない照合になる）。続けられないときは落として errors に積む
          else if (d.method === "Fetch.requestPaused") onPaused(d.params).catch((e) => { errors.push("NG kit onPaused " + d.params.request.url.slice(0, 100) + " " + e.message); send("Fetch.continueRequest", { requestId: d.params.requestId }); });
          else if (d.method === "Runtime.exceptionThrown") { const x = d.params.exceptionDetails; errors.push((x.exception?.description || x.text) + " @" + (x.url || x.stackTrace?.callFrames?.[0]?.url || "") + ":" + x.lineNumber); }
          else if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") errors.push(d.params.args.map((a) => a.value ?? a.description).join(" "));
          if (d.method === "Network.requestWillBeSent" && !["Media", "WebSocket", "EventSource"].includes(d.params.type) && !idleIgnore.test(d.params.request.url)) inflight.set(d.params.requestId, { url: d.params.request.url, t: Date.now() });
          else if (d.method === "Network.loadingFinished" || d.method === "Network.loadingFailed") inflight.delete(d.params.requestId);
          if (d.method === "Network.responseReceived") requests.push({ url: d.params.response.url, status: d.params.response.status, mime: d.params.response.mimeType, type: d.params.type });
          if (d.method && onEvent) onEvent(d);
        };
      }
    } catch {}
    if (!ws) await sleep(200);
  }
  if (!ws) { chrome.kill(); openCount--; refLimit(); releaseLock(); throw new Error("NG chrome: DevTools に繋がらない"); }
  // WebSocket が閉じたら（Chrome が落ちた・close した）待っている呼び出しを全部エラーで返す（黙って event loop が空になって終わらない）
  let wsClosed = false;
  ws.onclose = () => { wsClosed = true; for (const [, r] of pending) r({ error: { message: "NG chrome: DevTools の接続が閉じた" } }); pending.clear(); };
  const send = (m, p = {}) => new Promise((r) => { if (wsClosed) return r({ error: { message: "NG chrome: DevTools の接続が閉じた" } }); const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  const ev = async (e) => {
    const r = await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true });
    if (r.error) throw new Error(r.error.message);
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || JSON.stringify(r.result.exceptionDetails));
    return r.result?.result?.value;
  };
  const run = (body) => ev(`(async () => { ${HELPERS}\n${body}\n})()`);
  const BLOCK = new RegExp([blockCommon && BLOCK_COMMON.source, block && block.source].filter(Boolean).join("|") || "(?!)");
  const readFile = (f) => readFileSync(f, "utf8");
  // Fetch の応答が失敗したら（不正な errorReason など）errors に積んで続ける。止めたままにしない
  const reply = async (m, prm) => { const r = await send(m, prm); if (r.error) { errors.push("NG kit " + m + " " + r.error.message); if (m !== "Fetch.continueRequest") await send("Fetch.continueRequest", { requestId: prm.requestId }); } return r; };
  async function onPaused(pp) {
    const m = pp.request.method; const u = pp.request.url;
    if (pp.responseStatusCode != null || pp.responseErrorReason) { // Response 段（patch のときだけ来る）
      const ps = patch.filter((x) => x.url.test(u));
      // リダイレクト・204・304 は本文が無い（書き換えは転送先の応答で）
      if (!ps.length || pp.responseErrorReason || [204, 304].includes(pp.responseStatusCode) || (pp.responseStatusCode >= 300 && pp.responseStatusCode < 400)) return reply("Fetch.continueRequest", { requestId: pp.requestId });
      const b = await send("Fetch.getResponseBody", { requestId: pp.requestId });
      if (b.error || !b.result) { errors.push("PATCH MISS (本文が読めない) " + u.slice(0, 100)); return reply("Fetch.continueRequest", { requestId: pp.requestId }); }
      let body = b.result.base64Encoded ? Buffer.from(b.result.body, "base64").toString("utf8") : b.result.body;
      for (const x of ps) { const mm = x.re.exec(body); if (!mm) { errors.push("PATCH MISS " + (x.name || x.re)); continue; } body = body.slice(0, mm.index) + x.to(mm[0]) + body.slice(mm.index + mm[0].length); }
      return reply("Fetch.fulfillRequest", { requestId: pp.requestId, responseCode: pp.responseStatusCode,
        responseHeaders: (pp.responseHeaders || []).filter((h) => !/^content-(length|encoding)$/i.test(h.name)), body: Buffer.from(body).toString("base64") });
    }
    if (det && !detMedia && pp.resourceType === "Media") { blocked.push("media " + u.slice(0, 80)); return reply("Fetch.failRequest", { requestId: pp.requestId, errorReason: "BlockedByClient" }); }
    if (BLOCK.test(u)) { blocked.push("3rd " + u.slice(0, 100)); return reply("Fetch.failRequest", { requestId: pp.requestId, errorReason: "BlockedByClient" }); }
    const f = fulfill.find((x) => x.re.test(u) && m === (x.method || "GET"));
    if (f) {
      let body; try { body = readFile(f.file); } catch (e) { errors.push("NG fulfill: 参照コピーが読めない " + String(f.file) + " " + e.code); return reply("Fetch.failRequest", { requestId: pp.requestId, errorReason: "Failed" }); }
      for (const [re, to] of f.patch || []) { if (!re.test(body)) errors.push("PATCH MISS " + re); body = body.replace(re, to); }
      fulfilled.push(u.slice(0, 100));
      return reply("Fetch.fulfillRequest", { requestId: pp.requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: f.type || "text/html; charset=utf-8" }, { name: "Access-Control-Allow-Origin", value: "*" }], body: Buffer.from(body).toString("base64") });
    }
    const h = hold.find((x) => x.re.test(u));
    if (h) { const t0 = Date.now(); let ok = false; while (Date.now() - t0 < 30000) { const r = await send("Runtime.evaluate", { expression: h.expr, returnByValue: true }); if (r.result?.result?.value) { ok = true; break; } await sleep(30); }
      held.push({ url: u.split("/").pop(), ms: Date.now() - t0, ok }); if (!ok) errors.push("HOLD TIMEOUT " + u.slice(0, 100)); }
    if (dropWrites && m !== "GET" && m !== "HEAD" && m !== "OPTIONS") { blocked.push(m + " " + u.slice(0, 120)); return reply("Fetch.failRequest", { requestId: pp.requestId, errorReason: "BlockedByClient" }); }
    return reply("Fetch.continueRequest", { requestId: pp.requestId });
  }
  const patterns = [{ urlPattern: "*", requestStage: "Request" }];
  if (patch.length) patterns.push({ urlPattern: "*", requestStage: "Response" });
  await send("Fetch.enable", { patterns });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Network.setUserAgentOverride", { userAgent: ua || UA[kind] });
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile, screenWidth: width, screenHeight: height });
  if (mobile || touch) await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  if (reduced) await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: (det ? DET_SCRIPT(seed, { epoch, timeStamp, waapi, waapiCatch }) : "") + "\n" + (initScript || "") + "\n" + INPUTS + "\n" + GUARD });
  // 前面化（front: true が既定。mystaticself、2026-11-11）。headless のページは visibilityState: hidden のまま開き、クリックの無い間
  // （キー操作だけ・待つだけ）は描画の拍が回らず、CSS transition が currentTime 0 で止まって transitionend が来ない（本家が止まる
  // バグに見えた）。読み込みの前に済ませる（後だと初期の script と transition が hidden のうちに始まる）。visible にならなければ errors に積む
  if (front) {
    await send("Page.bringToFront");
    await send("Emulation.setFocusEmulationEnabled", { enabled: true });
    const vs = await ev("document.visibilityState").catch((e) => "error " + e.message);
    if (vs !== "visible") errors.push("NG front: visibilityState が " + vs);
  }
  if (url) await send("Page.navigate", { url });

  let closed = false;
  const close = () => { if (closed) return; closed = true; try { ws.close(); } catch {} chrome.kill(); openCount--; refLimit(); releaseLock(); };
  // 通信が空くまで実時間で待つ（ms を超えて終わらない要求は stuck に積んで数えない）
  const idle = async (ms = 20000) => { const t0 = Date.now(); for (;;) { while (inflight.size) { const n = Date.now(); for (const [k, v] of inflight) if (n - v.t > ms) { stuck.push(v.url.slice(0, 100)); inflight.delete(k); } if (!inflight.size) break; await sleep(10); } await ev("0"); await sleep(40); await ev("0"); if (!inflight.size) return Date.now() - t0; } };
  // DET の手送り。1 フレーム 16.7ms の実時間と歩調を合わせ（pace）、通信中なら空くのを待ってから進める（verification.md「決定的に撮る」11・15）
  // 拾い遅れの見回りの例外を errors に積む（1 回だけ）。waapiStats() で回数も読める
  let stepCalls = 0, catchErrSeen = 0;
  const waapiStats = () => ev("window.__waapi ? JSON.parse(JSON.stringify(window.__waapi)) : null");
  const checkCatch = async () => { let w = null; try { w = await waapiStats(); } catch { return; } if (w && w.catchErr > catchErrSeen) { catchErrSeen = w.catchErr; errors.push("NG waapi catch: " + w.catchMsg + "（" + w.catchErr + " 回）"); } };
  const step = async (n = 1, { pace = true, waitIdle = true } = {}) => {
    if (!det) throw new Error("NG step: det: true で開いていない");
    const t0 = Date.now();
    if (waapi && waapiCatch > 0 && (++stepCalls % 30 === 0 || catchErrSeen === 0 && stepCalls === 1)) await checkCatch();
    for (let i = 0; i < n; i++) { if (waitIdle && inflight.size) await idle(); await ev("__step(1)"); if (pace) { const lag = t0 + (i + 1) * (1000 / 60) - Date.now(); if (lag > 1) await sleep(lag); } }
  };
  const inputs = () => ev("window.__in ? JSON.parse(JSON.stringify(window.__in)) : null");
  // 入力の到着を待つ。name の数が before から増えるまで（実時間、期限切れで例外）
  // ページ遷移で文書が替わると数は 0 に戻る（数が減った・評価の文脈が消えた = 遷移した、として返す。戻り値 "navigated"）
  // 文書は performance.timeOrigin で見分ける（最初のクリックで遷移すると数は 0 → 0 で、数だけでは遷移が見えない。Sol のレビュー）
  const mark = (name) => ev(`[(window.__in && window.__in[${JSON.stringify(name)}]) || 0, performance.timeOrigin]`);
  const arrived = async (name, before, ms, what) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { let v; try { v = await mark(name); } catch (e) { if (/context|destroyed|navigat/i.test(e.message)) { await sleep(50); continue; } throw e; } if (v[1] !== before[1]) return "navigated"; if (v[0] > before[0]) return v[0]; await sleep(20); } throw new Error(`NG input ${what}: ${name} が ${ms}ms 以内に届かない`); };
  const count = (name) => ev(`(window.__in && window.__in[${JSON.stringify(name)}]) || 0`);
  // IntersectionObserver の初回のコールバックが全部届き、quiet ms 新しい到着が無くなるまで待つ（固定の待ちの代わり）
  const settleIO = async ({ quiet = 300, ms = 5000 } = {}) => {
    const t0 = Date.now(); let last = -1, since = Date.now();
    for (;;) {
      const s = await ev(`window.__in && window.__ioPending ? [window.__in.io, window.__ioPending()] : [0, 0]`);
      if (s[0] !== last) { last = s[0]; since = Date.now(); }
      if (s[1] <= 0 && Date.now() - since >= quiet) return { io: s[0], ms: Date.now() - t0 };
      if (Date.now() - t0 > ms) throw new Error(s[1] > 0 ? `NG io: ${ms}ms 待っても IntersectionObserver の初回が ${s[1]} 件届かない` : `NG io: ${ms}ms の間 IntersectionObserver が鳴り続けて ${quiet}ms 静かにならない`);
      await sleep(20);
    }
  };
  const parkMouse = async () => { if (park) { await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: park.x, y: park.y }); mouse = { ...park }; } };
  const center = (sel, i = 0) => run(`const el = qa(${JSON.stringify(sel)})[${i}]; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
  // クリック: 押して離し、click の到着を確かめ（届かなければ NG）、マウスを park へ退避する
  // expect: 到着を確かめるイベント（mousedown で DOM が入れ替わって click が出ないページは "mouseup"。null で確かめない）
  let mouse = null;
  const clickAt = async (x, y, { ms = 3000, keepMouse = false, expect = "click" } = {}) => {
    const before = expect ? await mark(expect) : null;
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    mouse = { x, y };
    // 退避は到着を待つ前に（クリックで同期に中身が動くページでも、止まったマウスの下に残らない。CDP は順序を保つので click は壊れない）
    if (!keepMouse) await parkMouse();
    if (expect) return arrived(expect, before, ms, `click (${Math.round(x)}, ${Math.round(y)})`);
  };
  const click = async (sel, i = 0, o) => { const c = await center(sel, i); if (!c) throw new Error(`NG no element ${sel}`); return clickAt(c.x, c.y, o); };
  const clickText = async (text, o) => { const c = await run(`const el = qa("button, a, [role=button]").find((e) => e.textContent.trim() === ${JSON.stringify(text)} && e.getBoundingClientRect().width > 0); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`); if (!c) throw new Error(`NG no element "${text}"`); return clickAt(c.x, c.y, o); };
  // hover を見たいときの移動（退避しない）。到着を確かめる
  const move = async (x, y, { ms = 3000 } = {}) => { const same = mouse && mouse.x === x && mouse.y === y; const before = await mark("mousemove"); await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }); mouse = { x, y }; if (!same) await arrived("mousemove", before, ms, `move (${x}, ${y})`); };
  // wheel: 1 回分を送り、届くのを確かめる
  const wheel = async (deltaY, { x = width / 2, y = height / 2, deltaX = 0, ms = 3000 } = {}) => { const before = await mark("wheel"); await send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY }); await arrived("wheel", before, ms, `wheel ${deltaY}`); };
  // 払う（タッチ）。native スクロールのページは慣性が実時間で入るので、位置を揃えたいだけなら scrollTo を使う
  const swipe = async ({ x = width / 2, y0, y1, x1 = x, steps = 8, dt = 16, ms = 3000 } = {}) => {
    const before = await mark("touchend");
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: y0 }] });
    for (let i = 1; i <= steps; i++) { await send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + (x1 - x) * i / steps, y: y0 + (y1 - y0) * i / steps }] }); await sleep(dt); }
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await arrived("touchend", before, ms, "swipe");
  };
  const key = async (k, { code = k, ms = 3000 } = {}) => { const before = await mark("keyup"); await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code }); await arrived("keyup", before, ms, `key ${k}`); };
  // 即時のスクロール（scroll-behavior: smooth を無視）。位置が変わるなら scroll の到着を確かめ、IO の初回が落ち着くまで待つ
  const scrollTo = async (y, { io = true, ms = 3000 } = {}) => {
    const r = await run(`const b = [window.__in ? window.__in.scroll || 0 : 0, performance.timeOrigin]; const y0 = scrollY; window.scrollTo({ top: ${Number(y)}, behavior: "instant" }); return { b, moved: scrollY !== y0, y: scrollY };`);
    if (r.moved) await arrived("scroll", r.b, ms, `scrollTo ${y}`);
    if (io) await settleIO({ ms: Math.max(ms, 5000) });
    return r.y;
  };
  const shot = async (path, o = {}) => { const r = await send("Page.captureScreenshot", { format: path.endsWith(".png") ? "png" : "jpeg", quality: 80, ...o }); writeFileSync(path, Buffer.from(r.result.data, "base64")); return path; };
  return { kit: KIT, kind, ev, run, send, close, errors, requests, blocked, held, fulfilled, inflight, stuck, idle, step, waapiStats, inputs, count, settleIO,
    center, click, clickText, clickAt, move, wheel, swipe, key, scrollTo, parkMouse, shot };
}
