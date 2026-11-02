import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseCookies, readBody, redirect, sameOrigin, send, sendJson } from "./http.js";
import { AttemptLimiter, fakeVerify, verifyPagoradarSignature, verifyPassword } from "./security.js";
import { ingestEvent } from "./pagoradar.js";
import { currentPeriod } from "./text.js";
import { loginPage, notFoundPage, panelPage, residentPage } from "./views.js";

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
/** The only static files served: a fixed list, never a path built from the request. */
const STATIC = { "/static/app.css": ["app.css", "text/css; charset=utf-8"] };
const COOKIE = "cuotia_sid";

/** Plain `(req, res)` router, no framework. Each branch answers and returns. */
export function createApp({ config, store }) {
  const limiter = new AttemptLimiter();
  const cookieFlags = `HttpOnly; SameSite=Strict; Path=/${config.secureCookies ? "; Secure" : ""}`;

  const sessionOf = (req) => store.sessions.resolve(parseCookies(req.headers.cookie)[COOKIE]);

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
      if (method === "GET") return sessionOf(req) ? redirect(res, "/panel") : send(res, 200, loginPage());
      if (method === "POST") return login(req, res);
    }

    if (method === "POST" && path === "/logout") {
      if (!sameOrigin(req, config.publicUrl)) return send(res, 403, "Origen no permitido");
      const token = parseCookies(req.headers.cookie)[COOKIE];
      if (token) store.sessions.delete(token);
      return redirect(res, "/login", { "Set-Cookie": `${COOKIE}=; Max-Age=0; ${cookieFlags}` });
    }

    if (method === "GET" && (path === "/" || path === "/panel")) {
      const session = sessionOf(req);
      if (!session) return redirect(res, "/login");
      const ledger = store.forTenant(session.tenant.id);
      const period = currentPeriod();
      return send(res, 200, panelPage({
        tenant: session.tenant,
        user: session.user,
        summary: ledger.summary(period),
        dues: ledger.dues.listByPeriod(period),
        unassigned: ledger.payments.listUnassigned(),
      }));
    }

    // A resident's personal link: the unguessable token is the credential.
    const r = method === "GET" && path.match(/^\/r\/([A-Za-z0-9_-]{20,})$/);
    if (r) {
      const found = store.residentByToken(r[1]);
      if (!found) return send(res, 404, notFoundPage());
      const ledger = store.forTenant(found.tenant.id);
      return send(res, 200, residentPage({ ...found, dues: ledger.dues.listForHouse(found.house.id), period: currentPeriod() }));
    }

    return send(res, 404, notFoundPage());
  }

  async function login(req, res) {
    if (!sameOrigin(req, config.publicUrl)) return send(res, 403, "Origen no permitido");
    const form = new URLSearchParams(await readBody(req, 8 * 1024));
    const email = String(form.get("email") ?? "").trim().toLowerCase();
    const password = String(form.get("password") ?? "");
    const key = `${req.socket.remoteAddress}|${email}`;
    if (limiter.blocked(key)) return send(res, 429, loginPage({ error: "Demasiados intentos. Espera unos minutos." }));

    const user = store.users.byEmail(email);
    const ok = user ? await verifyPassword(password, user.passwordHash) : (await fakeVerify(password), false);
    if (!ok) {
      limiter.fail(key);
      return send(res, 401, loginPage({ error: "Correo o contraseña incorrectos." }));
    }
    limiter.clear(key);
    const token = store.sessions.create(user.id);
    return redirect(res, "/panel", { "Set-Cookie": `${COOKIE}=${token}; Max-Age=${12 * 3600}; ${cookieFlags}` });
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
