import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseCookies, readBody, redirect, sameOrigin, send, sendJson } from "./http.js";
import {
  AttemptLimiter, csrfToken, csrfValid, decryptSecret, encryptSecret, fakeVerify, matchTotp, newTotpSecret,
  verifyPagoradarSignature, verifyPassword,
} from "./security.js";
import { ingestEvent } from "./pagoradar.js";
import { currentPeriod } from "./text.js";
import { casasPage, flashOf, linkPage, loginPage, notFoundPage, panelPage, residentPage, twoFaPage } from "./views.js";

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
/** The only static files served: a fixed list, never a path built from the request. */
const STATIC = { "/static/app.css": ["app.css", "text/css; charset=utf-8"] };
const COOKIE = "cuotia_sid";
const FULL_TTL_S = 12 * 3600;
const PENDING_TTL_MS = 10 * 60_000; // password accepted, waiting for the code
const SETUP_TTL_MS = 30 * 60_000; // time to install an authenticator app

/** Plain `(req, res)` router, no framework. Each branch answers and returns. */
export function createApp({ config, store }) {
  const loginLimiter = new AttemptLimiter();
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
      const [file, type] = STATIC[path];
      return send(res, 200, readFileSync(join(PUBLIC_DIR, file)), { "Content-Type": type, "Cache-Control": "public, max-age=300" });
    }

    // pagoradar → Cuotia. The signature covers the exact body, so verify before parsing.
    if (method === "POST" && path === "/webhooks/pagoradar") {
      const body = await readBody(req);
      if (!verifyPagoradarSignature(body, req.headers["pagoradar-signature"], config.pagoradarWebhookSecret)) {
        return sendJson(res, 400, { error: "Firma inválida" });
      }
      let event;
      try {
        event = JSON.parse(body);
      } catch {
        return sendJson(res, 400, { error: "JSON inválido" });
      }
      return sendJson(res, 200, ingestEvent(store, event));
    }

    if (path === "/login") {
      if (method === "GET") {
        const s = sessionOf(req);
        return s ? redirect(res, s.stage === "full" ? "/panel" : "/2fa") : send(res, 200, loginPage());
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
    const r = method === "GET" && path.match(/^\/r\/([A-Za-z0-9_-]{20,})$/);
    if (r) {
      const found = store.residentByToken(r[1]);
      if (!found) return send(res, 404, notFoundPage());
      const ledger = store.forTenant(found.tenant.id);
      return send(res, 200, residentPage({ ...found, dues: ledger.dues.listForHouse(found.house.id), period: currentPeriod() }));
    }

    // ---- Everything below needs a fully signed-in treasurer ----
    if (path === "/" || path === "/panel" || path.startsWith("/panel/")) return panel(req, res, url, path, method);

    return send(res, 404, notFoundPage());
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
    const base = { tenant: s.tenant, user: s.user, csrf };

    if (method === "GET" && (path === "/" || path === "/panel")) {
      return send(res, 200, panelPage({
        ...base,
        flash: flashOf(url.searchParams),
        summary: ledger.summary(period),
        dues: ledger.dues.listByPeriod(period),
        unassigned: ledger.payments.listUnassigned(),
        houses: ledger.houses.list(),
      }));
    }
    if (method === "GET" && path === "/panel/casas") {
      return send(res, 200, casasPage({ ...base, flash: flashOf(url.searchParams), houses: ledger.houses.list() }));
    }

    if (method !== "POST") return send(res, 404, notFoundPage());

    // Every state change: same origin AND the session's form token.
    if (!sameOrigin(req, config.publicUrl)) return send(res, 403, "Origen no permitido");
    const form = new URLSearchParams(await readBody(req, 8 * 1024));
    if (!csrfValid(s.token, form.get("_csrf"))) return send(res, 403, "Formulario vencido. Recarga la página e inténtalo de nuevo.");
    const back = (m, n) => redirect(res, `/panel?m=${m}${n === undefined ? "" : `&n=${n}`}`);

    try {
      if (path === "/panel/cuotas/generar") return back("gen", ledger.dues.generate(period));

      const assign = path.match(/^\/panel\/pagos\/(pg_[a-f0-9]+)\/asignar$/);
      if (assign) {
        const { dueId } = ledger.payments.assign(assign[1], String(form.get("house") ?? ""), { rememberAlias: form.get("remember") === "1" });
        return back(dueId ? "asig" : "asigsin");
      }

      if (path === "/panel/efectivo") {
        ledger.payments.recordCash(String(form.get("house") ?? ""));
        return back("efec");
      }

      if (path === "/panel/casas") {
        const code = String(form.get("code") ?? "").trim();
        const name = String(form.get("residente") ?? "").trim();
        if (!code || !name) return redirect(res, "/panel/casas?m=err");
        const phone = String(form.get("telefono") ?? "").replace(/\D/g, "") || null;
        let created;
        try {
          created = ledger.houses.create({ code, residentName: name, phone });
        } catch (e) {
          if (/UNIQUE/.test(e.message)) return redirect(res, "/panel/casas?m=dup");
          throw e;
        }
        return showLink(res, base, created.house, created.accessToken);
      }

      const link = path.match(/^\/panel\/casas\/(hs_[a-f0-9]+)\/enlace$/);
      if (link) {
        const house = ledger.houses.get(link[1]);
        if (!house) return redirect(res, "/panel/casas?m=err");
        return showLink(res, base, house, ledger.houses.rotateToken(house.id));
      }
    } catch (e) {
      // Known, user-correctable failures (wrong id, already assigned…) come as Error; anything else is a bug.
      console.error(`Acción ${path} falló:`, e.message);
      return redirect(res, "/panel?m=err");
    }
    return send(res, 404, notFoundPage());
  }

  function showLink(res, base, house, token) {
    const linkUrl = `${config.publicUrl}/r/${token}`;
    const digits = (house.phone ?? "").replace(/\D/g, "");
    const to = digits.length === 10 ? `57${digits}` : digits.length >= 11 ? digits : "";
    const text = `Hola ${house.residentName.split(" ")[0]}, este es tu enlace personal de Cuotia para ver y pagar tu cuota de vigilancia: ${linkUrl}`;
    const whatsapp = to ? `https://wa.me/${to}?text=${encodeURIComponent(text)}` : null;
    return send(res, 200, linkPage({ ...base, house, url: linkUrl, whatsapp }));
  }

  return async function app(req, res) {
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
