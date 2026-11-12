// App Store 版のトップで、入口を過ぎたら画面下に浮かぶ「フル版」への案内 (Liquid Glass 調)。
// 帯 (#full-band)・最後の CTA・フッターが見えている間は引っ込む。× で閉じたらそのページでは出さない。
// 屈折は Chromium だけの上乗せ (backdrop-filter に SVG フィルタを通せるのは Chromium だけ)。それ以外は CSS の層だけで見せる。
export function createFullNudge(el) {

  el.hidden = false;
  let onMove = null;
  const entry = document.querySelector(".entry"), band = document.getElementById("full-band");
  const stops = [band, document.getElementById("download"), document.querySelector("footer")].filter(Boolean);
  let closed = false; const visible = new Set();
  const update = () => {
    const past = entry ? entry.getBoundingClientRect().bottom < innerHeight * 0.4 : scrollY > 600;
    el.classList.toggle("is-on", !closed && past && visible.size === 0);
  };
  const io = new IntersectionObserver((es) => { for (const e of es) e.isIntersecting ? visible.add(e.target) : visible.delete(e.target); update(); }, { threshold: 0.15 }); stops.forEach((s) => io.observe(s));
  addEventListener("scroll", update, { passive: true }); update();
  el.querySelector("button").addEventListener("click", () => { closed = true; update(); });

  // ---- 屈折 (Chromium だけの上乗せ) ----
  // backdrop-filter に SVG フィルタを通せるのは Chromium だけ。Safari は構文を受け付けても何も描かないことがあるので、
  // エンジンで判定し、変位マップを作れたときだけ data-lens="on" にする。それ以外は CSS の層だけで見せる。
  const uad = navigator.userAgentData;
  const isChromium = uad && uad.brands && uad.brands.length ? uad.brands.some((b) => /Chromium/.test(b.brand)) : (!!window.chrome && /Chrome\//.test(navigator.userAgent));
  const filter = document.getElementById("full-nudge-lens");
  const buildLens = () => {
    const w = Math.round(el.offsetWidth), h = Math.round(el.offsetHeight);
    if (!w || !h || !filter) return false;
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const ctx = c.getContext("2d"); if (!ctx) return false;
    const img = ctx.createImageData(w, h), d = img.data, r = h / 2, band = Math.min(r, 18);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const px = x + 0.5, py = y + 0.5, cx = Math.min(Math.max(px, r), w - r);
      const dx = px - cx, dy = py - r, dist = Math.hypot(dx, dy) || 1e-6;
      const t = Math.min(Math.max(1 - (r - dist) / band, 0), 1);      // 0 = 平らな中央, 1 = 縁
      const m = 1 - Math.sqrt(1 - t * t);                              // 丸い断面: 縁に近いほど急に曲がる
      const i = (y * w + x) * 4;
      d[i] = 128 - (dx / dist) * m * 127; d[i + 1] = 128 - (dy / dist) * m * 127; d[i + 2] = 128; d[i + 3] = 255; // 縁ほど内側の像を引く
    }
    ctx.putImageData(img, 0, 0);
    for (const n of [filter, filter.querySelector("feImage")]) { n.setAttribute("width", w); n.setAttribute("height", h); }
    filter.querySelector("feImage").setAttribute("href", c.toDataURL());
    return true;
  };
  if (isChromium && window.CSS && CSS.supports("backdrop-filter", "url(#a)")) {
    const apply = () => { try { el.dataset.lens = buildLens() ? "on" : "off"; } catch (e) { el.dataset.lens = "off"; } };
    apply(); if (document.fonts && document.fonts.ready) document.fonts.ready.then(apply);
    if (window.ResizeObserver) { let w0 = el.offsetWidth; new ResizeObserver(() => { if (el.offsetWidth !== w0) { w0 = el.offsetWidth; apply(); } }).observe(el); }
  }

  // ---- 光の向きをポインタに合わせる (動いた分だけ 1 フレームに 1 回書く。止まっていれば何も走らない) ----
  if (matchMedia("(hover:hover) and (pointer:fine)").matches && !matchMedia("(prefers-reduced-motion:reduce)").matches) {
    let raf = 0, lx = 0, ly = 0;
    const paint = () => {
      raf = 0; if (!el.classList.contains("is-on")) return;
      const r = el.getBoundingClientRect(), dx = lx - (r.left + r.width / 2), dy = ly - (r.top + r.height / 2);
      // 遠いほど効きを弱める (ボタンの近くで動かしたときだけ大きく動く)
      const k = Math.min(1, 260 / Math.max(260, Math.hypot(dx, dy)));
      const ang = -38 + (Math.atan2(dx, -dy) * 180 / Math.PI + 38) * k;
      el.style.setProperty("--ang", ang.toFixed(1) + "deg");
      el.style.setProperty("--mx", (28 + ((lx - r.left) / r.width * 100 - 28) * k).toFixed(1) + "%");
      el.style.setProperty("--my", (-20 + ((ly - r.top) / r.height * 100 + 20) * k).toFixed(1) + "%");
    };
    onMove = (e) => { lx = e.clientX; ly = e.clientY; if (!raf) raf = requestAnimationFrame(paint); };
    addEventListener("pointermove", onMove, { passive: true });
  }

  return {
    destroy() {
      io.disconnect();
      removeEventListener("scroll", update);
      if (onMove) removeEventListener("pointermove", onMove);
      el.classList.remove("is-on");
      el.hidden = true;
    },
  };
}
