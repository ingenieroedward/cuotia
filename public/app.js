// Small progressive enhancements. Everything works without this file; it only adds copy and print buttons.
// No inline scripts anywhere: the page's CSP only allows scripts from this origin.
document.addEventListener("click", async (event) => {
  const copy = event.target.closest("[data-copy]");
  if (copy) {
    const text = copy.getAttribute("data-copy");
    const original = copy.textContent;
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = "¡Copiado!";
    } catch {
      // No clipboard permission (or an old browser): select the text so the person can copy it by hand.
      const target = document.querySelector(copy.getAttribute("data-copy-target") ?? "");
      if (target) { const range = document.createRange(); range.selectNodeContents(target); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); }
      copy.textContent = "Selecciónalo y copia";
    }
    setTimeout(() => { copy.textContent = original; }, 2000);
    return;
  }
  if (event.target.closest("[data-print]")) window.print();
});

// "Reintentar" on the offline page.
document.addEventListener("click", (event) => {
  if (event.target.closest("[data-reload]")) location.reload();
});

// Installable app: the service worker (see /sw.js) only keeps the look when offline; it never stores pages.
if ("serviceWorker" in navigator) {
  addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
