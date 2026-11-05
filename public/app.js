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

// ---- Live search ------------------------------------------------------------------------------------------------
// With 100 houses a dropdown is a chore. Lists and the "casa" select filter as you type; without JavaScript the same
// inputs are ordinary search forms handled by the server, so nothing here is required.

/** Lower case, no accents: "Pérez" matches "perez". */
const fold = (text) => String(text ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
/** Every word typed must appear somewhere in the text, in any order: "dia per" finds "03 Diana Pérez". */
const matches = (query, text) => {
  const haystack = fold(text);
  return fold(query).split(/\s+/).filter(Boolean).every((word) => haystack.includes(word));
};
globalThis.cuotia = { fold, matches };

for (const input of document.querySelectorAll("[data-live-filter]")) {
  const list = document.querySelector(input.dataset.liveFilter);
  if (!list) continue;
  const empty = input.dataset.liveEmpty ? document.querySelector(input.dataset.liveEmpty) : null;
  const items = [...list.children];
  const form = input.closest("form");
  form?.querySelector("[data-search-button]")?.setAttribute("hidden", "");
  const apply = () => {
    let shown = 0;
    for (const item of items) {
      const visible = matches(input.value, item.dataset.search ?? item.textContent);
      item.hidden = !visible;
      if (visible) shown++;
    }
    if (empty) empty.hidden = shown > 0;
    return shown;
  };
  input.addEventListener("input", apply);
  // Enter: with exactly one house left, open it (the "Elegir" link); otherwise just keep filtering, never reload.
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    const visible = items.filter((item) => !item.hidden);
    const link = visible.length === 1 ? visible[0].querySelector("[data-pick]") : null;
    if (link) location.href = link.href;
  });
  apply();
}

// A <select> with many options gets a search box above it that narrows the options as you type.
for (const input of document.querySelectorAll("[data-select-filter]")) {
  const select = document.querySelector(input.dataset.selectFilter);
  if (!select) continue;
  input.hidden = false;
  const all = [...select.options].map((option) => ({ value: option.value, text: option.textContent }));
  input.addEventListener("keydown", (event) => { if (event.key === "Enter") event.preventDefault(); });
  input.addEventListener("input", () => {
    const chosen = select.value;
    const options = all.filter((o) => !o.value || matches(input.value, o.text)); // the "Elegir casa…" placeholder always stays
    select.replaceChildren(...options.map((o) => new Option(o.text, o.value, false, o.value === chosen)));
    const real = options.filter((o) => o.value);
    if (input.value.trim() && real.length === 1) select.value = real[0].value; // one match: already chosen
  });
}

// Phone notifications (Ajustes → Avisos en el celular): ask permission, subscribe through the service worker and tell the
// server which device to notify. Nothing here runs unless that card is on the page.
(() => {
  const box = document.querySelector("[data-push]");
  if (!box) return;
  const button = box.querySelector("[data-push-toggle]");
  const status = box.querySelector("[data-push-status]");
  if (!("serviceWorker" in navigator && "PushManager" in window && "Notification" in window)) {
    status.textContent = "Este navegador no permite avisos. En iPhone, instala primero la app con Compartir → Añadir a pantalla de inicio y ábrela desde ahí.";
    button.hidden = true;
    return;
  }
  const key = Uint8Array.from(atob(box.dataset.key.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  // The treasurer's card posts to the panel with the form token; a resident's card posts to their own personal link.
  const subscribeUrl = box.dataset.subscribeUrl || "/panel/push/suscribir";
  const unsubscribeUrl = box.dataset.unsubscribeUrl || "/panel/push/baja";
  const post = (url, fields) => fetch(url, {
    method: "POST", credentials: "same-origin",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...(box.dataset.csrf ? { _csrf: box.dataset.csrf } : {}), ...fields }),
  }).then((r) => { if (!r.ok) throw new Error(String(r.status)); });
  // A resident's notification must open THEIR link, which the server never stores: remember it on this phone.
  const rememberLink = () => {
    const mine = /^\/r\/[^/]+/.exec(location.pathname);
    if (box.dataset.resident !== undefined && mine && "caches" in self) caches.open("resident-link").then((c) => c.put("/resident-link", new Response(mine[0]))).catch(() => {});
  };
  const current = () => navigator.serviceWorker.ready.then((reg) => reg.pushManager.getSubscription());
  const testButton = box.querySelector("[data-push-test]");
  const render = async () => {
    const sub = await current().catch(() => null);
    button.textContent = sub ? "Desactivar avisos en este dispositivo" : (box.dataset.resident !== undefined ? "Activar avisos" : "Activar avisos en este dispositivo");
    if (testButton) testButton.hidden = !sub;
    const state = document.querySelector("[data-setup-state]");
    if (state && box.dataset.resident !== undefined) state.textContent = sub ? "Avisos activos en este celular" : "Instala la app y activa los avisos de tu pago";
  };
  // A neighbour checks that a notification really reaches this phone, and is told why when it doesn't.
  if (testButton) testButton.addEventListener("click", async () => {
    testButton.disabled = true;
    status.textContent = "Enviando…";
    try {
      const res = await fetch(testButton.dataset.testUrl, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "" });
      const data = await res.json().catch(() => ({ error: res.status === 429 ? "limite" : "otro" }));
      if (data.sent) status.textContent = "Listo: te enviamos una notificación. Debería llegar en unos segundos. Si no la ves, revisa que las notificaciones de Cuotia estén permitidas en los ajustes del teléfono.";
      else if (data.error === "limite") status.textContent = "Ya hiciste varias pruebas. Espera un rato.";
      else if (data.error === "sin-dispositivo") status.textContent = "Este celular no está registrado todavía. Pulsa \"Activar avisos\".";
      else status.textContent = `No se pudo entregar el aviso (${data.status ? `el servicio respondió ${data.status}` : "sin respuesta del servicio"}${data.detail ? `: ${data.detail}` : ""}). Desactiva los avisos, vuelve a activarlos y prueba de nuevo; si sigue igual, avísale al tesorero con este mensaje.`;
    } catch { status.textContent = "No se pudo enviar la prueba. Revisa tu conexión."; }
    finally { testButton.disabled = false; }
  });
  button.addEventListener("click", async () => {
    button.disabled = true;
    status.textContent = "";
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        // The phone's own subscription goes first: even if the server can't be reached it must stop. The server only tidies its list.
        await sub.unsubscribe();
        await post(unsubscribeUrl, { endpoint: sub.endpoint }).catch(() => {});
        status.textContent = "Avisos desactivados en este dispositivo.";
      } else {
        if ((await Notification.requestPermission()) !== "granted") {
          status.textContent = "El permiso quedó bloqueado. Actívalo en los ajustes del teléfono o del navegador y vuelve a intentar.";
          return;
        }
        const made = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        const json = made.toJSON();
        await post(subscribeUrl, { endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth });
        rememberLink();
        status.textContent = box.dataset.resident !== undefined ? "Listo: los avisos están activos en este celular." : "Listo: los avisos están activos. Recarga esta página para probarlos.";
      }
    } catch (e) {
      // Say what the browser said (e.g. NotAllowedError, AbortError: push service error): it is what tells the cause.
      const why = e && e.name ? ` (${e.name}${e.message ? `: ${String(e.message).slice(0, 90)}` : ""})` : "";
      status.textContent = `No se pudo completar${why}. Inténtalo de nuevo en unos segundos.`;
    } finally {
      button.disabled = false;
      render();
    }
  });
  render();
})();

// Registrar pago: the bank/wallet field only applies to a transfer, so it hides (and clears) for cash or "otro".
(() => {
  const medio = document.querySelector("select[data-medio]");
  const banco = document.querySelector("[data-banco]");
  if (!medio || !banco) return;
  const input = banco.querySelector("input");
  let last = input.value || "Nequi";
  const sync = () => {
    const transfer = medio.value === "transfer";
    if (!transfer && input.value) last = input.value;
    banco.hidden = !transfer;
    input.value = transfer ? last : "";
  };
  medio.addEventListener("change", sync);
  sync();
})();

// WhatsApp message editor (Ajustes → Mensajes): live preview and "insert variable" buttons. `renderMessage` must stay identical to
// renderTemplate in src/messages.js (a test runs both on the same cases).
(() => {
  const renderMessage = (body, vars) => String(body)
    .replace(/\{([a-z_]+)\}/g, (match, key) => (key in vars ? String(vars[key]) : match))
    .split("\n").map((line) => line.replace(/^[ \t]+|[ \t]+$/g, "").replace(/ {2,}/g, " ")).join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  globalThis.cuotia = { ...(globalThis.cuotia ?? {}), renderMessage };
  for (const area of document.querySelectorAll("textarea[data-msg]")) {
    let vars = {};
    try { vars = JSON.parse(area.dataset.vars); } catch { /* the server-rendered preview stays */ }
    const preview = document.querySelector(area.dataset.preview);
    const update = () => { if (preview) preview.textContent = renderMessage(area.value, vars); };
    area.addEventListener("input", update);
    const form = area.closest("form");
    for (const chip of form.querySelectorAll("[data-insert]")) {
      chip.hidden = false; // without JavaScript the variables can still be typed by hand
      chip.addEventListener("click", () => {
        const start = area.selectionStart ?? area.value.length;
        const end = area.selectionEnd ?? start;
        area.setRangeText(chip.dataset.insert, start, end, "end");
        area.focus();
        update();
      });
    }
  }
})();

// Passkeys (WebAuthn): sign in without typing, and register one from Ajustes. The server does all the checking.
(() => {
  if (!("PublicKeyCredential" in globalThis) || !navigator.credentials) return;
  const enc = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const dec = (s) => Uint8Array.from(atob(String(s).replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const post = async (url, body) => {
    const res = await fetch(url, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "No se pudo completar");
    return data;
  };
  const say = (node, text) => { if (node) node.textContent = text; };

  // Sign-in page.
  const box = document.querySelector("[data-passkey-login-box]");
  if (box) {
    box.hidden = false;
    const status = box.querySelector("[data-passkey-status]");
    box.querySelector("[data-passkey-login]").addEventListener("click", async (event) => {
      event.target.disabled = true;
      say(status, "");
      try {
        const options = await post("/login/passkey/opciones", {});
        const cred = await navigator.credentials.get({ publicKey: { challenge: dec(options.challenge), rpId: options.rpId, userVerification: "required", timeout: options.timeout } });
        const result = await post("/login/passkey", { credential: { id: cred.id, rawId: enc(cred.rawId), response: {
          clientDataJSON: enc(cred.response.clientDataJSON), authenticatorData: enc(cred.response.authenticatorData),
          signature: enc(cred.response.signature), userHandle: cred.response.userHandle ? enc(cred.response.userHandle) : null } } });
        location.href = result.redirect;
      } catch (e) {
        say(status, e.name === "NotAllowedError" ? "Cancelaste o no se pudo verificar. Puedes entrar con tu correo y contraseña." : e.message);
        event.target.disabled = false;
      }
    });
  }

  // Ajustes: add a passkey on this device.
  const card = document.querySelector("[data-passkeys]");
  if (card) {
    const add = card.querySelector("[data-passkey-add]");
    const status = card.querySelector("[data-passkey-status]");
    add.hidden = false;
    add.addEventListener("click", async () => {
      add.disabled = true;
      say(status, "");
      try {
        const csrf = card.dataset.csrf;
        const o = await post("/panel/passkeys/opciones", { _csrf: csrf });
        const cred = await navigator.credentials.create({ publicKey: { ...o, challenge: dec(o.challenge), user: { ...o.user, id: dec(o.user.id) }, excludeCredentials: o.excludeCredentials.map((c) => ({ ...c, id: dec(c.id) })) } });
        await post("/panel/passkeys/registrar", { _csrf: csrf, name: card.querySelector("[data-passkey-name]").value, credential: { id: cred.id, rawId: enc(cred.rawId), response: {
          clientDataJSON: enc(cred.response.clientDataJSON), attestationObject: enc(cred.response.attestationObject),
          transports: cred.response.getTransports ? cred.response.getTransports() : [] } } });
        location.reload();
      } catch (e) {
        say(status, e.name === "NotAllowedError" ? "Cancelaste o este dispositivo no pudo crear el passkey." : e.name === "InvalidStateError" ? "Este dispositivo ya tiene un passkey de Cuotia." : e.message);
        add.disabled = false;
      }
    });
  }
})();

// Apariencia (Ajustes): claro / oscuro / automático. Only this device; theme.js applies it before paint.
(() => {
  const card = document.querySelector("[data-theme-card]");
  if (!card || !globalThis.cuotiaTheme) return;
  card.hidden = false;
  const buttons = [...card.querySelectorAll("[data-theme-set]")];
  const mark = () => { const now = globalThis.cuotiaTheme.saved(); for (const b of buttons) b.setAttribute("aria-pressed", String(b.dataset.themeSet === now)); };
  for (const b of buttons) b.addEventListener("click", () => {
    try { localStorage.setItem("cuotia-theme", b.dataset.themeSet); } catch { /* private mode: the choice lasts until reload */ }
    globalThis.cuotiaTheme.apply(); mark();
  });
  mark();
})();

// Sign-in comforts: show/hide a password, one press only, and the 6-digit code sends itself.
(() => {
  for (const input of document.querySelectorAll('input[type="password"]')) {
    const wrap = document.createElement("span");
    wrap.className = "pw-wrap";
    input.replaceWith(wrap);
    wrap.append(input);
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "pw-toggle";
    toggle.textContent = "Ver";
    toggle.setAttribute("aria-label", "Mostrar la contraseña");
    toggle.setAttribute("aria-pressed", "false");
    toggle.addEventListener("click", () => {
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      toggle.textContent = show ? "Ocultar" : "Ver";
      toggle.setAttribute("aria-label", show ? "Ocultar la contraseña" : "Mostrar la contraseña");
      toggle.setAttribute("aria-pressed", String(show));
      input.focus();
    });
    wrap.append(toggle);
  }

  for (const form of document.querySelectorAll("form")) {
    const button = form.querySelector("button[data-busy]");
    if (!button) continue;
    const label = button.textContent;
    form.addEventListener("submit", (event) => {
      if (event.submitter && event.submitter !== button) return;
      setTimeout(() => { button.disabled = true; button.textContent = button.dataset.busy; }, 0);
    });
    // Coming back with the browser's back button must not leave the button stuck.
    addEventListener("pageshow", () => { button.disabled = false; button.textContent = label; });
  }

  for (const code of document.querySelectorAll("input[data-autosubmit]")) {
    const size = Number(code.dataset.autosubmit);
    code.addEventListener("input", () => {
      if (code.value.replace(/\D/g, "").length === size && code.form.checkValidity()) code.form.requestSubmit(code.form.querySelector("button[data-busy]"));
    });
  }
})();

// "Instala Cuotia": show the steps for this phone, an install button where the browser has one, and hide it once installed.
(() => {
  const card = document.querySelector("[data-install]");
  if (!card) return;
  const standalone = (typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches) || (typeof navigator !== "undefined" && navigator.standalone === true);
  if (standalone) { card.hidden = true; return; }
  const ua = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
  const ios = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && typeof navigator !== "undefined" && navigator.maxTouchPoints > 1);
  for (const steps of card.querySelectorAll("[data-install-steps]")) steps.hidden = steps.dataset.installSteps !== (ios ? "ios" : "android");
  const button = card.querySelector("[data-install-button]");
  let offered = null;
  addEventListener("beforeinstallprompt", (event) => { event.preventDefault(); offered = event; button.hidden = false; });
  button.addEventListener("click", async () => {
    if (!offered) return;
    offered.prompt();
    await offered.userChoice.catch(() => null);
    offered = null;
    button.hidden = true;
  });
  addEventListener("appinstalled", () => { card.hidden = true; });
})();

// Neighbour's home: the "Pagar" button follows you down the page once the big one has scrolled out of sight.
(() => {
  const float = document.querySelector("[data-pay-float]");
  const hero = document.querySelector("[data-pay-hero]");
  if (!float || !hero || typeof IntersectionObserver !== "function") return;
  new IntersectionObserver(([entry]) => { float.hidden = entry.isIntersecting; }, { threshold: 0.1 }).observe(hero);
})();
