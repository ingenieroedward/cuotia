// Applies the saved look (claro / oscuro / automático) before the page paints, so there is no flash of the wrong theme.
// Loaded synchronously from <head>; the buttons in Ajustes live in app.js. Default is light, as the owner approved.
(function () {
  var root = document.documentElement;
  var mql = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  function saved() { try { var v = localStorage.getItem("cuotia-theme"); return v === "dark" || v === "auto" ? v : "light"; } catch (e) { return "light"; } }
  function apply() {
    var pref = saved();
    var dark = pref === "dark" || (pref === "auto" && !!mql && mql.matches);
    root.setAttribute("data-theme", dark ? "dark" : "light");
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", dark ? "#0b1613" : "#0B4A3A");
  }
  apply();
  if (mql && mql.addEventListener) mql.addEventListener("change", apply);
  window.cuotiaTheme = { apply: apply, saved: saved };
})();
