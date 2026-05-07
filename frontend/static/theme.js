// Theme toggle: persists "rd_theme" = "light" | "dark" in localStorage and
// injects a sun/moon button into every page's header.
//
// MUST be loaded synchronously in <head> BEFORE the stylesheet so that the
// `html.light` class is set before CSS evaluates — otherwise a user with
// "light" saved sees a brief flash of dark.

(function () {
  // 1. Apply persisted theme as early as possible.
  try {
    var saved = localStorage.getItem("rd_theme") || "dark";
    if (saved === "light") document.documentElement.classList.add("light");
  } catch (e) { /* localStorage unavailable; default = dark */ }

  function isLight() {
    return document.documentElement.classList.contains("light");
  }

  function setTheme(light) {
    if (light) document.documentElement.classList.add("light");
    else document.documentElement.classList.remove("light");
    try { localStorage.setItem("rd_theme", light ? "light" : "dark"); } catch (e) {}
    var btn = document.getElementById("theme-toggle");
    if (btn) btn.textContent = light ? "🌙" : "☀️";
    // Let other code (e.g. Chart.js) react if it wants to.
    window.dispatchEvent(new Event("rd-theme-change"));
  }

  // Expose a global toggle for other scripts/inline buttons.
  window.toggleTheme = function () { setTheme(!isLight()); };

  // 2. Inject toggle button into the page header on DOM ready.
  function inject() {
    var header = document.querySelector("header.top");
    if (!header) return;
    if (header.querySelector("#theme-toggle")) return;

    var btn = document.createElement("button");
    btn.id = "theme-toggle";
    btn.title = "Toggle light / dark theme";
    btn.textContent = isLight() ? "🌙" : "☀️";
    btn.addEventListener("click", function () { setTheme(!isLight()); });

    // Drop it into the rightmost .row in the header (next to user-bar/buttons),
    // or fall back to the header itself.
    var rows = header.querySelectorAll(":scope > .row");
    var target = rows.length ? rows[rows.length - 1] : header;
    target.insertBefore(btn, target.firstChild);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", inject);
  } else {
    inject();
  }
})();
