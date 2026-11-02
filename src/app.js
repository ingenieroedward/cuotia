import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseCookies, readBody, redirect, sameOrigin, send, sendJson } from "./http.js";
import {
  AttemptLimiter, csrfToken, csrfValid, decryptSecret, encryptSecret, fakeVerify, hashPassword, matchTotp, newTotpSecret, safeEqual,
  verifyPagoradarSignature, verifyPassword,
} from "./security.js";
import { ingestEvent } from "./pagoradar.js";
import { debtTotals, groupDebts } from "./debts.js";
import { bogotaDateTime, csvCell, currentPeriod, lastPeriods, matchesSearch, parseHouseLines, paymentMedium, periodLabel, peso, shiftPeriod, slugify, whatsappNumber } from "./text.js";
import { ajustesPage, casaPage, casasPage, cobrosPage, flashOf, importPage, importResultPage, linkPage, loginPage, notFoundPage, offlinePage, pagoManualPage, pagosPage, panelPage, receiptPage, residentPage, residentPayPage, setupPage, twoFaPage } from "./views.js";

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
/** The only static files served: a fixed list, never a path built from the request. */
const DAY = 86400;
const STATIC = {
  "/static/app.css": ["app.css", "text/css; charset=utf-8", 300],
  "/static/app.js": ["app.js", "text/javascript; charset=utf-8", 300],
  "/static/fonts/plus-jakarta-sans-latin.woff2": ["fonts/plus-jakarta-sans-latin-wght-normal.woff2", "font/woff2", 7 * DAY],
  "/static/fonts/plus-jakarta-sans-latin-ext.woff2": ["fonts/plus-jakarta-sans-latin-ext-wght-normal.woff2", "font/woff2", 7 * DAY],
  // Icons, favicon and the installable app (PWA). The service worker must live at the root to control every page, and
  // must never be cached by the browser, or a fixed worker would not reach people.
  "/static/icons/icon.svg": ["icons/icon.svg", "image/svg+xml", DAY],
  "/static/icons/maskable.svg": ["icons/maskable.svg", "image/svg+xml", DAY],
  "/static/icons/favicon-32.png": ["icons/favicon-32.png", "image/png", DAY],
  "/static/icons/favicon-48.png": ["icons/favicon-48.png", "image/png", DAY],
  "/static/icons/apple-touch-icon.png": ["icons/apple-touch-icon.png", "image/png", DAY],
  "/static/icons/icon-192.png": ["icons/icon-192.png", "image/png", DAY],
  "/static/icons/icon-512.png": ["icons/icon-512.png", "image/png", DAY],
  "/static/icons/maskable-512.png": ["icons/maskable-512.png", "image/png", DAY],
  "/favicon.ico": ["favicon.ico", "image/x-icon", DAY],
  "/favicon.svg": ["favicon.svg", "image/svg+xml", DAY],
  "/manifest.webmanifest": ["manifest.webmanifest", "application/manifest+json; charset=utf-8", 3600],
  "/sw.js": ["sw.js", "text/javascript; charset=utf-8", 0],
};
const COOKIE = "cuotia_sid";
const PAGE_SIZE = 50;
const FULL_TTL_S = 12 * 3600;
const PENDING_TTL_MS = 10 * 60_000; // password accepted, waiting for the code
const SETUP_TTL_MS = 30 * 60_000; // time to install an authenticator app

/** Plain `(req, res)` router, no framework. Each branch answers and returns. */
export function createApp({ config, store }) {
  const loginLimiter = new AttemptLimiter();
  const setupLimiter = new AttemptLimiter({ max: 10, windowMs: 15 * 60_000 });
  const codeLimiter = new AttemptLimiter({ max: 5, windowMs: 10 * 60_000 });
  const cookieFlags = `HttpOnly; SameSite=Strict; Path=/${config.secureCookies ? "; Secure" : ""}`;
  const setCookie = (token, maxAgeS) => ({ "Set-Cookie": `${COOKIE}=${token}; Max-Age=${maxAgeS}; ${cookieFlags}` });

  const tokenOf = (req) => parseCookies(req.headers.cookie)[COOKIE];
  const sessionOf = (req) => {
    const token = tokenOf(req);
    const s = store.sessions.resolve(token);
    return s ? { ...s, token } : null;
  };

  async function route(req, res) {
    const url = new URL(req.url, "http://x");
    const path = url.pathname;
    const method = req.method;

    if (path === "/health") return sendJson(res, 200, { ok: true });

    if (method === "GET" && STATIC[path]) {
      const [file, type, maxAge] = STATIC[path];
      return send(res, 200, readFileSync(join(PUBLIC_DIR, file)), { "Content-Type": type, "Cache-Control": maxAge ? `public, max-age=${maxAge}` : "no-cache" });
    }

    // pagoradar → Cuotia, one URL and one secret per conjunto. The signature covers the exact body: verify before parsing.
    const hook = path.match(/^\/webhooks\/pagoradar\/(ten_[a-f0-9]+)$/);
    if (method === "POST" && hook) return pagoradarWebhook(req, res, hook[1]);

    // Shown by the service worker when there is no connection (it is cached at install, so it must need no sign-in).
    if (method === "GET" && path === "/offline") return send(res, 200, offlinePage());

    if (path === "/setup" && (method === "GET" || method === "POST")) return setup(req, res, url, method);

    if (path === "/login") {
      if (method === "GET") {
        const s = sessionOf(req);
        if (s) return redirect(res, s.stage === "full" ? "/panel" : "/2fa");
        return send(res, 200, loginPage({ notice: url.searchParams.get("m") === "creado" ? "Conjunto creado. Entra con tu correo y tu contraseña." : undefined }));
      }
      if (method === "POST") return login(req, res);
    }

    if (path === "/2fa") {
      if (method === "GET") return twoFaForm(req, res);
      if (method === "POST") return twoFaSubmit(req, res);
    }

    if (method === "POST" && path === "/logout") {
      if (!sameOrigin(req, config.publicUrl)) return send(res, 403, "Origen no permitido");
      const token = tokenOf(req);
      if (token) store.sessions.delete(token);
      return redirect(res, "/login", setCookie("", 0));
    }

    // A resident's personal link: the unguessable token is the credential.
    const r = method === "GET" && path.match(/^\/r\/([A-Za-z0-9_-]{20,})(?:\/(pagar|manifest\.webmanifest)|\/recibo\/(du_[a-f0-9]+))?$/);
    if (r) {
      const [, token, extra, receiptId] = r;
      const pay = extra === "pagar";
      const found = store.residentByToken(token);
      if (!found) return send(res, 404, notFoundPage());
      // Each resident installs their own app: "Cuotia · Casa 14", which opens on their personal link.
      if (extra === "manifest.webmanifest") return send(res, 200, JSON.stringify(residentManifest(found, token)), { "Content-Type": "application/manifest+json; charset=utf-8" });
      const ledger = store.forTenant(found.tenant.id);
      const dues = ledger.dues.listForHouse(found.house.id);
      if (receiptId) {
        const receipt = ledger.dues.receiptForHouse(found.house.id, receiptId);
        return receipt ? send(res, 200, receiptPage({ tenant: found.tenant, receipt, token })) : send(res, 404, notFoundPage());
      }
      if (pay) {
        // Nothing left to pay (the bank confirmed while the page was open): go back to the home, which says "Al día".
        if (!dues.some((d) => d.status === "pending")) return redirect(res, `/r/${token}`);
        return send(res, 200, residentPayPage({ ...found, dues, token }));
      }
      return send(res, 200, residentPage({ ...found, dues, period: currentPeriod(), token }));
    }

    // ---- Everything below needs a fully signed-in treasurer ----
    if (path === "/" || path === "/panel" || path.startsWith("/panel/")) return panel(req, res, url, path, method);

    return send(res, 404, notFoundPage());
  }

  async function pagoradarWebhook(req, res, tenantId) {
    const body = await readBody(req);
    const tenant = store.tenants.get(tenantId);
    if (!tenant) return sendJson(res, 404, { error: "Conjunto desconocido" });
    const encrypted = store.tenants.pagoradarSecret(tenant.id);
    // Not configured yet: a 503 makes pagoradar keep retrying until the treasurer saves the secret.
    if (!encrypted) return sendJson(res, 503, { error: "Este conjunto aún no tiene configurado el secreto de pagoradar" });
    const secret = decryptSecret(encrypted, config.masterKey);
    if (!verifyPagoradarSignature(body, req.headers["pagoradar-signature"], secret)) {
      return sendJson(res, 400, { error: "Firma inválida" });
    }
    let event;
    try {
      event = JSON.parse(body);
    } catch {
      return sendJson(res, 400, { error: "JSON inválido" });
    }
    store.tenants.touchPagoradar(tenant.id);
    return sendJson(res, 200, ingestEvent(store, event, tenant.id));
  }

  // ---------- first-run setup ----------

  /** Open only while there is no conjunto AND the private token matches. Anything else looks like any other missing page. */
  const setupOpen = (token) => store.tenants.list().length === 0 && safeEqual(String(token ?? ""), config.setupToken);

  async function setup(req, res, url, method) {
    const ip = req.socket.remoteAddress;
    if (setupLimiter.blocked(ip)) return send(res, 429, "Demasiados intentos. Espera unos minutos.");
    if (method === "GET") {
      const token = url.searchParams.get("token");
      if (!setupOpen(token)) { setupLimiter.fail(ip); return send(res, 404, notFoundPage()); }
      return send(res, 200, setupPage({ token }));
    }

    if (!sameOrigin(req, config.publicUrl)) return send(res, 403, "Origen no permitido");
    const form = new URLSearchParams(await readBody(req, 8 * 1024));
    const token = String(form.get("token") ?? "");
    if (!setupOpen(token)) { setupLimiter.fail(ip); return send(res, 404, notFoundPage()); }

    const field = (k, max) => String(form.get(k) ?? "").trim().slice(0, max);
    const values = { nombre: field("nombre", 80), cuota: field("cuota", 9).replace(/[.\s]/g, ""), llave: field("llave", 80), titular: field("titular", 80), tesorero: field("tesorero", 80), correo: field("correo", 120).toLowerCase() };
    const clave = String(form.get("clave") ?? "");
    const again = (error) => send(res, 400, setupPage({ token, error, values }));
    if (!values.nombre) return again("Escribe el nombre del conjunto.");
    if (!/^\d+$/.test(values.cuota) || Number(values.cuota) < 1000 || Number(values.cuota) > 10_000_000) return again("La cuota debe ser un valor en pesos entre 1.000 y 10.000.000.");
    if (!values.tesorero) return again("Escribe tu nombre.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.correo)) return again("Escribe un correo válido.");
    if (clave.length < 10) return again("La contraseña debe tener al menos 10 caracteres.");
    if (clave !== String(form.get("clave2") ?? "")) return again("Las contraseñas no coinciden.");

    const passwordHash = await hashPassword(clave);
    // Hashing is slow and async: check again, synchronously, right before creating, so two submits can't make two conjuntos.
    if (store.tenants.list().length > 0) return send(res, 404, notFoundPage());
    const tenant = store.tenants.create({ slug: slugify(values.nombre), name: values.nombre, payKey: values.llave || null, payHolder: values.titular || null });
    store.forTenant(tenant.id).concepts.create({ name: "Vigilancia", amountCents: Number(values.cuota) * 100 });
    store.users.create({ tenantId: tenant.id, email: values.correo, passwordHash, name: values.tesorero });
    return redirect(res, "/login?m=creado");
  }

  // ---------- login ----------

  async function login(req, res) {
    if (!sameOrigin(req, config.publicUrl)) return send(res, 403, "Origen no permitido");
    const form = new URLSearchParams(await readBody(req, 8 * 1024));
    const email = String(form.get("email") ?? "").trim().toLowerCase();
    const password = String(form.get("password") ?? "");
    const key = `${req.socket.remoteAddress}|${email}`;
    if (loginLimiter.blocked(key)) return send(res, 429, loginPage({ error: "Demasiados intentos. Espera unos minutos." }));

    const user = store.users.byEmail(email);
    const ok = user ? await verifyPassword(password, user.passwordHash) : (await fakeVerify(password), false);
    if (!ok) {
      loginLimiter.fail(key);
      return send(res, 401, loginPage({ error: "Correo o contraseña incorrectos." }));
    }
    loginLimiter.clear(key);
    // The password alone opens nothing: a short "pending" session that only the /2fa page accepts.
    const stage = user.totpEnabled ? "pending" : "setup";
    const ttlMs = stage === "pending" ? PENDING_TTL_MS : SETUP_TTL_MS;
    const token = store.sessions.create(user.id, { stage, ttlMs });
    return redirect(res, "/2fa", setCookie(token, Math.floor(ttlMs / 1000)));
  }

  /** The secret to enroll: the user's unconfirmed one (so a page reload shows the same key), or a new one. */
  function enrollmentSecret(user) {
    if (user.totpSecret && !user.totpEnabled) return decryptSecret(user.totpSecret, config.masterKey);
    const secret = newTotpSecret();
    store.users.setTotpSecret(user.id, encryptSecret(secret, config.masterKey));
    return secret;
  }

  function twoFaForm(req, res, error) {
    const s = sessionOf(req);
    if (!s) return redirect(res, "/login");
    if (s.stage === "full") return redirect(res, "/panel");
    const view = { stage: s.stage, error };
    if (s.stage === "setup") {
      const user = store.users.byId(s.user.id);
      view.secret = enrollmentSecret(user);
      view.email = user.email;
      view.uri = `otpauth://totp/${encodeURIComponent(`Cuotia:${user.email}`)}?secret=${view.secret}&issuer=Cuotia`;
    }
    return send(res, error ? 401 : 200, twoFaPage(view));
  }

  async function twoFaSubmit(req, res) {
    if (!sameOrigin(req, config.publicUrl)) return send(res, 403, "Origen no permitido");
    const s = sessionOf(req);
    if (!s) return redirect(res, "/login");
    if (s.stage === "full") return redirect(res, "/panel");
    const form = new URLSearchParams(await readBody(req, 4 * 1024));
    if (codeLimiter.blocked(s.user.id)) return send(res, 429, twoFaPage({ stage: s.stage, error: "Demasiados intentos. Vuelve a entrar en unos minutos." }));

    const user = store.users.byId(s.user.id);
    if (!user.totpSecret) return redirect(res, "/2fa"); // setup: the key is created when the page is first opened
    const secret = decryptSecret(user.totpSecret, config.masterKey);
    const step = matchTotp(secret, form.get("code"));
    // claimTotpStep refuses a code that was already used, even inside its validity window.
    if (step === null || !store.users.claimTotpStep(user.id, step)) {
      codeLimiter.fail(user.id);
      return twoFaForm(req, res, "Código incorrecto. Revisa que la hora de tu celular esté en automático.");
    }
    codeLimiter.clear(user.id);
    if (s.stage === "setup") store.users.enableTotp(user.id);
    const full = store.sessions.promote(s.token, FULL_TTL_S * 1000);
    return redirect(res, "/panel", setCookie(full, FULL_TTL_S));
  }

  // ---------- panel ----------

  async function panel(req, res, url, path, method) {
    const s = sessionOf(req);
    if (!s) return redirect(res, "/login");
    if (s.stage !== "full") return redirect(res, "/2fa");

    const ledger = store.forTenant(s.tenant.id);
    const csrf = csrfToken(s.token);
    const period = currentPeriod();
    const houses = ledger.houses.list();
    // Who owes what, across months: the sidebar badge, "Por cobrar", the dashboard and the payment form all read this.
    const groups = groupDebts(ledger.dues.listPending(), houses, period, { dueDay: s.tenant.dueDay });
    const debts = { groups, totals: debtTotals(groups) };
    // What the sidebar and tab bar show on every page.
    const base = {
      tenant: s.tenant, user: s.user, csrf,
      badge: ledger.payments.countUnassigned(), owing: groups.length, houseCount: houses.length,
      cuota: ledger.concepts.list()[0] ? peso(ledger.concepts.list()[0].amountCents) : "",
    };

    if (method === "GET" && (path === "/" || path === "/panel")) {
      // Any month that has dues can be looked at; "mes" outside that list falls back to the current one.
      const months = [...new Set([period, ...ledger.dues.periods()])].sort().reverse();
      const asked = url.searchParams.get("mes");
      const selected = months.includes(asked) ? asked : period;
      const at = months.indexOf(selected);
      return send(res, 200, panelPage({
        ...base,
        flash: flashOf(url.searchParams),
        summary: ledger.summary(selected),
        dues: ledger.dues.listByPeriod(selected),
        unassigned: ledger.payments.listUnassigned(),
        houses, debts, current: period,
        prevPeriod: months[at + 1] ?? null, nextPeriod: months[at - 1] ?? null,
        addable: lastPeriods(period, 13).slice(1).filter((m) => !months.includes(m)).slice(0, 6),
        recent: ledger.payments.list({ limit: 4 }).rows,
        filter: ["pagadas", "pendientes"].includes(url.searchParams.get("f")) ? url.searchParams.get("f") : "",
      }));
    }

    // Who owes what, across months, with the buttons to act on each.
    if (method === "GET" && path === "/panel/cobros") {
      const filter = ["atrasadas", "mes"].includes(url.searchParams.get("f")) ? url.searchParams.get("f") : "";
      const q = String(url.searchParams.get("q") ?? "").trim().slice(0, 60);
      const shown = groups
        .filter((g) => (filter === "atrasadas" ? g.overdueCount > 0 : filter === "mes" ? g.overdueCount === 0 : true))
        .filter((g) => matchesSearch(q, `${g.house.code} ${g.house.residentName}`));
      return send(res, 200, cobrosPage({ ...base, flash: flashOf(url.searchParams), groups, shown, totals: debts.totals, filter, q, current: period }));
    }

    if (method === "GET" && path === "/panel/casas") {
      return send(res, 200, casasPage({
        ...base, flash: flashOf(url.searchParams), houses, inactive: ledger.houses.listInactive(), debts, current: period,
        q: String(url.searchParams.get("q") ?? "").trim().slice(0, 60),
      }));
    }

    const casa = method === "GET" && path.match(/^\/panel\/casas\/(hs_[a-f0-9]+)$/);
    if (casa) {
      const house = ledger.houses.get(casa[1]);
      if (!house) return send(res, 404, notFoundPage());
      return send(res, 200, casaPage({
        ...base, flash: flashOf(url.searchParams), house,
        aliases: ledger.aliases.list(house.id),
        dues: ledger.dues.listForHouse(house.id),
        payments: ledger.payments.list({ houseId: house.id, limit: 20 }).rows,
      }));
    }

    if (method === "GET" && path === "/panel/pagos/nuevo") {
      // ?casa= opens that house's form; ?cuota= ticks one due (the row's button), ?todas=1 ticks them all.
      return send(res, 200, pagoManualPage({
        ...base, flash: flashOf(url.searchParams), debts, current: period,
        selected: groups.find((g) => g.house.id === url.searchParams.get("casa")) ?? null,
        missing: (() => {
          const g = groups.find((x) => x.house.id === url.searchParams.get("casa"));
          if (!g) return [];
          const have = new Set(ledger.dues.listForHouse(g.house.id).map((d) => d.period));
          return lastPeriods(period, 13).filter((m) => !have.has(m)).slice(0, 6);
        })(),
        preselect: url.searchParams.getAll("cuota"), all: url.searchParams.get("todas") === "1",
        q: String(url.searchParams.get("q") ?? "").trim().slice(0, 60),
        today: bogotaDateTime(new Date().toISOString()).slice(0, 10),
      }));
    }

    if (method === "GET" && (path === "/panel/pagos" || path === "/panel/pagos.csv")) {
      const f = historyFilters(url.searchParams);
      if (path === "/panel/pagos.csv") return sendCsv(res, ledger, f);
      const result = ledger.payments.list({ ...f, limit: PAGE_SIZE, offset: (f.p - 1) * PAGE_SIZE });
      return send(res, 200, pagosPage({
        ...base, flash: flashOf(url.searchParams), result, period,
        filters: { mes: f.period ?? "", estado: f.status ?? "", q: f.q, p: f.p },
        page: f.p, pages: Math.max(1, Math.ceil(result.total / PAGE_SIZE)),
      }));
    }

    if (method === "GET" && path === "/panel/casas/importar") return send(res, 200, importPage({ ...base }));

    if (method === "GET" && path === "/panel/ajustes") {
      return send(res, 200, ajustesPage({ ...base, flash: flashOf(url.searchParams), webhookUrl: `${config.publicUrl}/webhooks/pagoradar/${s.tenant.id}` }));
    }

    if (method !== "POST") return send(res, 404, notFoundPage());

    // Every state change: same origin AND the session's form token.
    if (!sameOrigin(req, config.publicUrl)) return send(res, 403, "Origen no permitido");
    const form = new URLSearchParams(await readBody(req, 8 * 1024));
    if (!csrfValid(s.token, form.get("_csrf"))) return send(res, 403, "Formulario vencido. Recarga la página e inténtalo de nuevo.");
    const back = (m, n) => redirect(res, `/panel?m=${m}${n === undefined ? "" : `&n=${n}`}`);

    try {
      if (path === "/panel/ajustes/pagoradar") {
        const secret = String(form.get("secret") ?? "").trim();
        if (secret.length < 8 || secret.length > 200 || /\s/.test(secret)) return redirect(res, "/panel/ajustes?m=secbad");
        store.tenants.setPagoradarSecret(s.tenant.id, encryptSecret(secret, config.masterKey));
        return redirect(res, "/panel/ajustes?m=sec");
      }

      if (path === "/panel/ajustes/fechas") {
        const day = (name) => {
          const raw = String(form.get(name) ?? "").trim();
          if (!raw) return null;
          const n = Number(raw);
          return Number.isInteger(n) && n >= 1 && n <= 28 ? n : NaN;
        };
        const openDay = day("desde");
        const dueDay = day("hasta");
        if (Number.isNaN(openDay) || Number.isNaN(dueDay) || (openDay != null && dueDay != null && dueDay < openDay)) return redirect(res, "/panel/ajustes?m=fechasbad");
        store.tenants.setDates(s.tenant.id, { openDay, dueDay });
        return redirect(res, "/panel/ajustes?m=fechas");
      }

      if (path === "/panel/ajustes/cobro") {
        store.tenants.setPayment(s.tenant.id, { payKey: String(form.get("llave") ?? "").slice(0, 80), payHolder: String(form.get("titular") ?? "").slice(0, 80) });
        return redirect(res, "/panel/ajustes?m=cobro");
      }

      if (path === "/panel/ajustes/clave") {
        const key = `clave|${s.user.id}`;
        if (loginLimiter.blocked(key)) return redirect(res, "/panel/ajustes?m=clavelim");
        const user = store.users.byId(s.user.id);
        if (!(await verifyPassword(String(form.get("actual") ?? ""), user.passwordHash))) {
          loginLimiter.fail(key);
          return redirect(res, "/panel/ajustes?m=clavemal");
        }
        const nueva = String(form.get("nueva") ?? "");
        if (nueva.length < 10 || nueva.length > 200 || nueva !== String(form.get("nueva2") ?? "")) return redirect(res, "/panel/ajustes?m=clavebad");
        store.users.setPasswordHash(user.id, await hashPassword(nueva));
        store.sessions.deleteForUser(user.id, s.token); // every other device must sign in again with the new password
        loginLimiter.clear(key);
        return redirect(res, "/panel/ajustes?m=clave");
      }

      if (path === "/panel/cuotas/generar") {
        const asked = String(form.get("mes") ?? "") || period;
        if (!validPastPeriod(asked)) return redirect(res, "/panel?m=mesbad");
        const created = ledger.dues.generate(asked);
        return redirect(res, `/panel?${asked === period ? "" : `mes=${asked}&`}m=gen&n=${created}`);
      }

      const assign = path.match(/^\/panel\/pagos\/(pg_[a-f0-9]+)\/asignar$/);
      if (assign) {
        const { dueId } = ledger.payments.assign(assign[1], String(form.get("house") ?? ""), { rememberAlias: form.get("remember") === "1" });
        return back(dueId ? "asig" : "asigsin");
      }

      if (path === "/panel/pagos/nuevo") {
        const houseId = String(form.get("casa") ?? "");
        const paidAt = manualPaidAt(String(form.get("fecha") ?? ""));
        const dueIds = form.getAll("cuota").map(String);
        if (!paidAt || dueIds.length === 0) return redirect(res, `/panel/pagos/nuevo?casa=${encodeURIComponent(houseId)}&m=manualbad`);
        ledger.payments.recordManual({
          houseId, dueIds, method: String(form.get("medio") ?? "cash"), paidAt,
          bank: String(form.get("banco") ?? ""), note: String(form.get("nota") ?? ""),
        });
        return redirect(res, "/panel/cobros?m=manual");
      }

      if (path === "/panel/casas/importar") {
        const { rows, errors } = parseHouseLines(form.get("casas"));
        const created = [];
        const skipped = [];
        for (const row of rows) {
          try {
            const { house, accessToken } = ledger.houses.create({ code: row.code, residentName: row.residentName, phone: row.phone });
            const url = `${config.publicUrl}/r/${accessToken}`;
            created.push({ house, url, whatsapp: whatsappLink(house, url) });
          } catch (e) {
            if (!/UNIQUE/.test(e.message)) throw e;
            skipped.push({ line: row.line, text: `${row.code} · ${row.residentName}`, reason: `Ya existe la casa ${row.code}` });
          }
        }
        if (created.length) ledger.dues.generate(period);
        return send(res, 200, importResultPage({ ...base, created, problems: [...errors, ...skipped].sort((a, b) => a.line - b.line) }));
      }

      if (path === "/panel/casas") {
        const data = houseForm(form);
        if (!data) return redirect(res, "/panel/casas?m=err");
        let created;
        try {
          created = ledger.houses.create(data);
        } catch (e) {
          if (/UNIQUE/.test(e.message)) return redirect(res, "/panel/casas?m=dup");
          throw e;
        }
        ledger.dues.generate(period);
        return showLink(res, base, created.house, created.accessToken);
      }

      const link = path.match(/^\/panel\/casas\/(hs_[a-f0-9]+)\/enlace$/);
      if (link) {
        const house = ledger.houses.get(link[1]);
        if (!house?.active) return redirect(res, "/panel/casas?m=err");
        return showLink(res, base, house, ledger.houses.rotateToken(house.id));
      }

      const act = path.match(/^\/panel\/casas\/(hs_[a-f0-9]+)\/(editar|alias|desactivar|reactivar|mes)$/);
      if (act) {
        const [, houseId, action] = act;
        const own = `/panel/casas/${houseId}`;
        if (action === "mes") {
          // "+ Octubre": the due of a month that was never generated for this house, and straight to paying it.
          const asked = String(form.get("mes") ?? "");
          const form_ = `/panel/pagos/nuevo?casa=${houseId}`;
          if (!validPastPeriod(asked)) return redirect(res, `${form_}&m=mesbad`);
          ledger.dues.generateForHouse(houseId, asked);
          const ticked = ledger.dues.listForHouse(houseId).filter((d) => d.period === asked && d.status === "pending").map((d) => `&cuota=${d.id}`).join("");
          return redirect(res, `${form_}${ticked}&m=mesok`);
        }
        if (action === "editar") {
          const data = houseForm(form);
          if (!data) return redirect(res, `${own}?m=err`);
          try {
            ledger.houses.update(houseId, data);
          } catch (e) {
            if (/UNIQUE/.test(e.message)) return redirect(res, `${own}?m=dup`);
            throw e;
          }
          return redirect(res, `${own}?m=ed`);
        }
        if (action === "alias") {
          const name = String(form.get("name") ?? "").trim().slice(0, 80);
          return redirect(res, `${own}?m=${name && ledger.aliases.add(houseId, name) ? "aliasok" : "err"}`);
        }
        ledger.houses.setActive(houseId, action === "reactivar");
        if (action === "reactivar") ledger.dues.generate(period);
        return redirect(res, action === "reactivar" ? `${own}?m=react` : "/panel/casas?m=desact");
      }

      const unalias = path.match(/^\/panel\/casas\/(hs_[a-f0-9]+)\/alias\/(al_[a-f0-9]+)\/quitar$/);
      if (unalias) {
        const removed = ledger.aliases.remove(unalias[1], unalias[2]);
        return redirect(res, `/panel/casas/${unalias[1]}?m=${removed ? "aliasdel" : "err"}`);
      }

      const undo = path.match(/^\/panel\/pagos\/(pg_[a-f0-9]+)\/deshacer$/);
      if (undo) {
        const { deleted } = ledger.payments.revert(undo[1]);
        return redirect(res, `/panel/pagos?m=${deleted ? "undoc" : "undo"}`);
      }
    } catch (e) {
      // Known, user-correctable failures (wrong id, already assigned…) come as Error; anything else is a bug.
      console.error(`Acción ${path} falló:`, e.message);
      return redirect(res, "/panel?m=err");
    }
    return send(res, 404, notFoundPage());
  }

  /**
   * "YYYY-MM-DD" typed by the treasurer → the instant to record, or null if it isn't a real date, is in the future (Colombia
   * time) or is absurdly old. Today means "now"; a past day means noon that day in Colombia, so it lands in the right month.
   */
  function manualPaidAt(date) {
    const today = bogotaDateTime(new Date().toISOString()).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)) || date > today || date < "2024-01-01") return null;
    return date === today ? new Date().toISOString() : `${date}T17:00:00.000Z`;
  }

  /** A month you may add dues for: a real "YYYY-MM", not in the future and at most two years back. */
  function validPastPeriod(p) {
    const now = currentPeriod();
    return /^\d{4}-(0[1-9]|1[0-2])$/.test(p) && p <= now && p >= shiftPeriod(now, -24);
  }

  /** Validated house fields from a form, or null. */
  function houseForm(form) {
    const code = String(form.get("code") ?? "").trim().slice(0, 12);
    const residentName = String(form.get("residente") ?? "").trim().slice(0, 80);
    if (!code || !residentName) return null;
    return { code, residentName, phone: String(form.get("telefono") ?? "").replace(/\D/g, "").slice(0, 20) || null };
  }

  /** Query → filters for the history list. Anything unexpected is simply ignored. */
  function historyFilters(params) {
    const mes = params.get("mes");
    const estado = params.get("estado");
    const p = Number.parseInt(params.get("p") ?? "1", 10);
    return {
      period: /^\d{4}-(0[1-9]|1[0-2])$/.test(mes ?? "") ? mes : null,
      status: estado === "assigned" || estado === "unassigned" ? estado : null,
      q: String(params.get("q") ?? "").trim().slice(0, 60),
      p: Number.isSafeInteger(p) && p > 0 ? p : 1,
    };
  }

  /** A spreadsheet of the filtered payments: `;` separated with a BOM, which is what Excel in Spanish opens correctly. */
  function sendCsv(res, ledger, f) {
    const { rows } = ledger.payments.list({ period: f.period, status: f.status, q: f.q, limit: 20000, offset: 0 });
    const head = ["Fecha", "Pagador", "Banco o medio", "Casa", "Residente", "Cuota", "Monto (COP)", "Estado"];
    const lines = rows.map((p) => [
      bogotaDateTime(p.paidAt), p.payerName, paymentMedium(p), p.houseCode ?? "", p.residentName ?? "",
      p.duePeriod ? `${p.conceptName} ${periodLabel(p.duePeriod)}` : "", Math.round(p.amountCents / 100), p.status === "assigned" ? "Asignado" : "Por asignar",
    ].map(csvCell).join(";"));
    const body = `\uFEFF${[head.map(csvCell).join(";"), ...lines].join("\r\n")}\r\n`;
    return send(res, 200, body, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="pagos-${f.period ?? "todos"}.csv"`,
    });
  }

  function residentManifest({ tenant, house }, token) {
    const base = `/r/${token}`;
    const icon = (src, sizes, type, purpose = "any") => ({ src, sizes, type, purpose });
    return {
      id: base, name: `Cuotia · Casa ${house.code}`, short_name: `Casa ${house.code}`,
      description: `Tu cuota de vigilancia en ${tenant.name}.`, lang: "es-CO", dir: "ltr",
      start_url: base, scope: base, display: "standalone", background_color: "#f3f5f8", theme_color: "#0b1b2b",
      icons: [
        icon("/static/icons/icon-192.png", "192x192", "image/png"), icon("/static/icons/icon-512.png", "512x512", "image/png"),
        icon("/static/icons/maskable-512.png", "512x512", "image/png", "maskable"), icon("/static/icons/icon.svg", "any", "image/svg+xml"),
      ],
    };
  }

  /** A WhatsApp link to this resident with their personal link already written, or null without a usable phone. */
  function whatsappLink(house, linkUrl) {
    const to = whatsappNumber(house.phone);
    if (!to) return null;
    const text = `Hola ${house.residentName.split(" ")[0]}, este es tu enlace personal de Cuotia para ver y pagar tu cuota de vigilancia: ${linkUrl}`;
    return `https://wa.me/${to}?text=${encodeURIComponent(text)}`;
  }

  function showLink(res, base, house, token) {
    const linkUrl = `${config.publicUrl}/r/${token}`;
    return send(res, 200, linkPage({ ...base, house, url: linkUrl, whatsapp: whatsappLink(house, linkUrl) }));
  }

  return async function app(req, res) {
    // Behind HTTPS, tell browsers never to use plain HTTP for this site again (about six months).
    if (config.secureCookies) res.setHeader("Strict-Transport-Security", "max-age=15552000");
    try {
      await route(req, res);
    } catch (err) {
      if (!res.headersSent) {
        if (err.status === 413) return sendJson(res, 413, { error: "Cuerpo demasiado grande" });
        console.error(err);
        sendJson(res, 500, { error: "Error interno" });
      }
    }
  };
}
