// GA4 events specific to clipdex.o2z0.com (the common part is /js/ga.js).
// Sends nothing when ga.js stopped at its guard and window.gtag is missing.
(function () {
  // The /buy and /en/buy forms submit to the license Worker. The submit event fires only after the
  // required checkbox passes validation, so this counts real attempts. Purchase completion is not tracked.
  document.addEventListener("submit", function (event) {
    if (typeof window.gtag !== "function") return;
    var form = event.target;
    if (!form || !form.action) return;
    if (form.action.indexOf("https://clipdex-license.o2z0.workers.dev/buy") !== 0) return;
    // beacon: the page navigates away right after this, so the hit must not wait for the response.
    window.gtag("event", "begin_checkout", { transport_type: "beacon" });
  });
})();
