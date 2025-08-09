/**
 * Lightweight UTM capturer for Nuvemshop storefront/checkout.
 * This file is intended to be referenced by a Nuvemshop Script (store/checkout).
 */
(function () {
  try {
    var params = new URLSearchParams(window.location.search);
    var utm_keys = ["utm_source","utm_medium","utm_campaign","utm_content","utm_term","gclid","fbclid","ref"];
    var utms = {};
    utm_keys.forEach(function(k){ if (params.get(k)) utms[k] = params.get(k); });

    // Persist locally
    if (Object.keys(utms).length) {
      try { localStorage.setItem("ns_utms", JSON.stringify(utms)); } catch {}
    }

    // On checkout page, try to read email and post UTMs to middleware
    function trySend() {
      var emailInput = document.querySelector('input[type="email"], input#email, input[name="email"]');
      var email = emailInput && emailInput.value;
      if (!email) return false;
      var stored = {};
      try { stored = JSON.parse(localStorage.getItem("ns_utms")||"{}"); } catch {}
      var payload = Object.assign({ email: email }, stored);
      var base = (window.__NS_BRIDGE_BASE__ || (location.origin));
      fetch(base + "/session/utm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }).catch(function(){});
      return true;
    }

    // Fire on first interaction or when email field blurs
    document.addEventListener("click", function(){ trySend(); }, { once: true });
    document.addEventListener("visibilitychange", function(){ if (document.visibilityState === "hidden") trySend(); });
    document.addEventListener("change", function(e){ if (e && e.target && e.target.type === "email") trySend(); });

    // Expose a manual method
    window.__NS_UTM_SYNC__ = trySend;
  } catch (e) {
    // swallow
  }
})();
