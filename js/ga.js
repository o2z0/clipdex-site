// 正本: o2z0/public/js/ga.js（2026-11-05）
// GA4 common part. Canonical copy for all o2z0.com sites: copy this file unmodified (o2z0 GA4 policy §7b).
// Contains: hostname guard, ?internal=on opt-out, signals and ad personalization off (set + config), page_view on bfcache restore.
// Site-specific events do not belong here: put them in /js/ga-events.js.
(function () {
  var id = document.currentScript && document.currentScript.dataset.gaId;
  if (!id) return;
  var host = document.currentScript.dataset.gaHost;
  if (host && location.hostname !== host) return;

  var internal = false;
  try {
    var mode = new URLSearchParams(location.search).get("internal");
    if (mode === "on") localStorage.setItem("o2z0-internal", "1");
    if (mode === "off") localStorage.removeItem("o2z0-internal");
    internal = localStorage.getItem("o2z0-internal") === "1";
  } catch (_) { /* Storage が使えない環境では計測を続ける */ }
  if (internal) window["ga-disable-" + id] = true;

  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { window.dataLayer.push(arguments); };
  window.gtag("js", new Date());
  // Newer GA4 properties ignore these keys when given only in config (npa=0 measured 2026-11-05), so set them page-wide first.
  window.gtag("set", { allow_google_signals: false, allow_ad_personalization_signals: false });
  window.gtag("config", id, { allow_google_signals: false, allow_ad_personalization_signals: false });

  // Count a page restored from bfcache once (no double count measured on o2z0.com, 2026-11-02).
  addEventListener("pageshow", function (event) {
    if (event.persisted) window.gtag("event", "page_view");
  });
})();
