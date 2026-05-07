// Theme toggle: persists "rd_theme" = "light" | "dark" in localStorage and
// renders a fixed-position Light/Dark pill in the bottom-right of every page.
//
// MUST be loaded synchronously in <head> BEFORE the stylesheet so that the
// `html.light` class is set before CSS evaluates — otherwise a user with
// "light" saved sees a brief flash of dark.

(function () {
  // 1. Apply persisted theme as early as possible (no flash).
  //    Default = light (race days are usually outside in daylight).
  try {
    var saved = localStorage.getItem("rd_theme") || "light";
    if (saved === "light") document.documentElement.classList.add("light");
  } catch (e) {
    // localStorage unavailable — still apply light as the default.
    document.documentElement.classList.add("light");
  }

  function isLight() {
    return document.documentElement.classList.contains("light");
  }

  function setTheme(light) {
    if (light) document.documentElement.classList.add("light");
    else document.documentElement.classList.remove("light");
    try { localStorage.setItem("rd_theme", light ? "light" : "dark"); } catch (e) {}
    refreshUI();
    // Other code can listen for this (e.g. workflow.html re-renders Mermaid).
    window.dispatchEvent(new Event("rd-theme-change"));
  }

  // Expose for any other code that wants it.
  window.toggleTheme = function () { setTheme(!isLight()); };

  function refreshUI() {
    var wrap = document.getElementById("theme-toggle");
    if (!wrap) return;
    var lightActive = isLight();
    wrap.querySelectorAll("button").forEach(function (b) {
      b.classList.toggle("active", (b.dataset.mode === "light") === lightActive);
    });
  }

  // 2. Inject the fixed-position pill once <body> exists. Body-level + fixed
  //    position means no other JS that touches the header can wipe it.
  function inject() {
    if (document.getElementById("theme-toggle")) return;
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", inject);
      return;
    }
    var wrap = document.createElement("div");
    wrap.id = "theme-toggle";
    wrap.setAttribute("role", "group");
    wrap.setAttribute("aria-label", "Theme");
    wrap.innerHTML =
      '<button type="button" data-mode="light">Light</button>' +
      '<button type="button" data-mode="dark">Dark</button>';
    wrap.addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-mode]");
      if (!btn) return;
      setTheme(btn.dataset.mode === "light");
    });
    document.body.appendChild(wrap);
    refreshUI();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", inject);
  } else {
    inject();
  }
})();
