import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseCookies, readBody, readBuffer, redirect, sameOrigin, send, sendJson } from "./http.js";
import {
  AttemptLimiter, newRecoveryCodes, newToken, normalizeRecoveryCode, recoveryHash, csrfToken, csrfValid, decryptSecret, encryptSecret, fakeVerify, hashPassword, matchTotp, newTotpSecret, safeEqual,
  verifyPagoradarSignature, verifyPassword,
} from "./security.js";
import { ingestEvent } from "./pagoradar.js";
import { debtTotals, groupDebts } from "./debts.js";
import { MAX_PROOF_BYTES, parseMultipart, sniffProof } from "./upload.js";
import { sendPush, validEndpoint, validKeys } from "./webpush.js";
import { createNotifier } from "./notifier.js";
import { createOperator } from "./operator.js";
import { backupName, backupTo } from "./backup.js";
import { EXPENSE_CATEGORIES } from "./store.js";
import { MANUAL_LABELS, payMethodTitle, bogotaDateTime, csvCell, currentPeriod, lastPeriods, matchesSearch, parseHouseLines, paymentMedium, periodLabel, peso, shiftPeriod, slugify, whatsappNumber } from "./text.js";
import { AUDIT_ACTIONS } from "./audit.js";
import { MESSAGES, MESSAGE_KEYS, validateTemplate } from "./messages.js";
import { ALLOWED_ALGS, b64u, fromB64u, verifyAssertion, verifyRegistration } from "./webauthn.js";
import { message } from "./messages.js";
import { ajustesPage, bitacoraPage, conceptosPage, masPage, mensajesPage, privacidadPage, reiniciarPage, casaPage, casasPage, cobrosPage, cuentasPage, residentCuentasPage, transparenciaPage, olvidePage, restablecerPage, recoveryCodesPage, resetLinkPage, estadoPage, pazYSalvoPage, verificarPage, flashOf, importPage, importResultPage, linkPage, loginPage, notFoundPage, offlinePage, pagoManualPage, pagosPage, panelPage, receiptPage, residentPage, residentPayPage, residentProofPage, inviteAcceptPage, inviteLinkPage, setupPage, twoFaPage } from "./views.js";

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
/** The only static files served: a fixed list, never a path built from the request. */
const DAY = 86400;
const STATIC = {
  "/static/app.css": ["app.css", "text/css; charset=utf-8", 300],
  "/static/app.js": ["app.js", "text/javascript; charset=utf-8", 300],
  "/static/theme.js": ["theme.js", "text/javascript; charset=utf-8", 300],
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
export function createApp({ config, store, pushSend = sendPush, notifier = createNotifier({ store, config, pushSend }) }) {
  const operator = createOperator({ store, config });
  const vapid = () => ({ publicKey: notifier.publicKey() });
  const notify = (tenantId, message, opts) => notifier.team(tenantId, message, opts);
  const loginLimiter = new AttemptLimiter();
  const setupLimiter = new AttemptLimiter({ max: 10, windowMs: 15 * 60_000 });
  const codeLimiter = new AttemptLimiter({ max: 5, windowMs: 10 * 60_000 });
  const inviteLimiter = new AttemptLimiter({ max: 15, windowMs: 15 * 60_000 });
  const proofLimiter = new AttemptLimiter({ max: 12, windowMs: 60 * 60_000 });
  const verifyLimiter = new AttemptLimiter({ max: 30, windowMs: 15 * 60_000 });
  const publicLimiter = new AttemptLimiter({ max: 30, windowMs: 15 * 60_000 });
  const forgotLimiter = new AttemptLimiter({ max: 6, windowMs: 15 * 60_000 });
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

    // The operator panel has its own login and cookie; it answers everything under /operador.
    if ((path === "/operador" || path.startsWith("/operador/")) && await operator(req, res, url, path, method)) return;

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
    if (method === "GET" && path === "/privacidad") return send(res, 200, privacidadPage({ contact: config.privacyContact }));

    // Public transparency page: the unguessable token in the link is the credential; the treasurer can switch it off or change it.
    const pub = method === "GET" && path.match(/^\/t\/([A-Za-z0-9_-]{20,})$/);
    if (pub) {
      const ip = req.socket.remoteAddress;
      if (publicLimiter.blocked(ip)) return send(res, 429, "Demasiados intentos. Espera unos minutos.");
      const tenant = store.tenants.byPublicToken(pub[1]);
      if (!tenant) { publicLimiter.fail(ip); return send(res, 404, notFoundPage()); }
      const ledger = store.forTenant(tenant.id);
      const asked = url.searchParams.get("mes");
      const month = validPastPeriod(asked) ? asked : currentPeriod();
      // Only totals and the expenses' text: never a resident, a house or a receipt file (those stay behind the personal links).
      return send(res, 200, transparenciaPage({
        tenant, token: pub[1], period: month, current: currentPeriod(), books: ledger.books(month), summary: ledger.summary(month),
        expenses: ledger.expenses.list({ period: month }).filter((e) => !e.voided),
        prev: validPastPeriod(shiftPeriod(month, -1)) ? shiftPeriod(month, -1) : null, next: month < currentPeriod() ? shiftPeriod(month, 1) : null,
      }), { "X-Robots-Tag": "noindex, nofollow, noarchive" });
    }
    if (method === "GET" && path === "/verificar") {
      const ip = req.socket.remoteAddress;
      const code = String(url.searchParams.get("codigo") ?? "").trim().toUpperCase().slice(0, 12);
      if (!code) return send(res, 200, verificarPage({}));
      if (verifyLimiter.blocked(ip)) return send(res, 429, verificarPage({ code, error: "Demasiados intentos. Espera unos minutos." }));
      verifyLimiter.fail(ip);
      return send(res, 200, verificarPage({ code, searched: true, found: store.certificates.byCode(code) }));
    }
    // Access recovery: forgot the password (with a backup code), and the one-use link a colleague creates.
    if (path === "/olvide") {
      if (method === "GET") return send(res, 200, olvidePage({}));
      if (method === "POST") return forgotPassword(req, res);
    }
    const reset = (method === "GET" || method === "POST") && path.match(/^\/restablecer\/([A-Za-z0-9_-]{20,})$/);
    if (reset) return accessReset(req, res, reset[1], method);
    if (method === "POST" && path === "/2fa/respaldo") return backupCodeLogin(req, res);
    const invite = (method === "GET" || method === "POST") && path.match(/^\/invitacion\/([A-Za-z0-9_-]{20,})$/);
    if (invite) return invitation(req, res, invite[1], method);

    // Passkeys: sign in without typing (the browser offers the saved passkey).
    if (method === "POST" && path === "/login/passkey/opciones") return passkeyLoginOptions(req, res);
    if (method === "POST" && path === "/login/passkey") return passkeyLogin(req, res);

    if (path === "/login") {
      if (method === "GET") {
        const s = sessionOf(req);
        if (s) return redirect(res, s.stage === "full" ? "/panel" : "/2fa");
        return send(res, 200, loginPage({ notice: { creado: "Conjunto creado. Entra con tu correo y tu contraseña.", invitado: "Tu cuenta está lista. Entra con tu correo y tu contraseña.", clavenueva: "Listo: ya tienes contraseña nueva. Entra con ella.", accesonuevo: "Listo: tu contraseña cambió. Al entrar te pediremos activar el código de verificación en tu celular.", celular: "Listo. Entra de nuevo y activaremos el celular nuevo." }[url.searchParams.get("m")] }));
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

    // A resident uploads a proof of payment (photo or PDF). Same personal-link credential, same-origin only.
    const avisos = method === "POST" && path.match(/^\/r\/([A-Za-z0-9_-]{20,})\/avisos\/(suscribir|baja)$/);
    if (avisos) return residentPush(req, res, avisos[1], avisos[2]);
    const upload = method === "POST" && path.match(/^\/r\/([A-Za-z0-9_-]{20,})\/comprobante$/);
    if (upload) return residentUpload(req, res, upload[1]);

    // A resident's personal link: the unguessable token is the credential.
    const r = method === "GET" && path.match(/^\/r\/([A-Za-z0-9_-]{20,})(?:\/(pagar|comprobante|cuentas|estado|paz-y-salvo|manifest\.webmanifest)|\/recibo\/(du_[a-f0-9]+)|\/cuentas\/(gt_[a-f0-9]+)\/soporte)?$/);
    if (r) {
      const [, token, extra, receiptId, expenseId] = r;
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
      if (extra === "estado" || extra === "paz-y-salvo") {
        return serveDocument(res, extra, { tenant: found.tenant, house: found.house, ledger, backHref: `/r/${token}`, base: `/r/${token}`, issuedBy: "residente", manifest: `/r/${token}/manifest.webmanifest` });
      }
      if (extra === "cuentas" || expenseId) {
        // The treasurer decides whether residents see the accounts (Ajustes); otherwise it looks like the page doesn't exist.
        if (!found.tenant.showAccounts) return send(res, 404, notFoundPage());
        if (expenseId) {
          const own = ledger.expenses.get(expenseId);
          const file = own && !own.voided ? ledger.expenses.file(expenseId) : null;
          return file ? sendExpenseFile(res, file) : send(res, 404, notFoundPage());
        }
        const asked = url.searchParams.get("mes");
        const month = validPastPeriod(asked) ? asked : currentPeriod();
        return send(res, 200, residentCuentasPage({
          ...found, token, period: month, current: currentPeriod(), books: ledger.books(month),
          expenses: ledger.expenses.list({ period: month }).filter((e) => !e.voided),
          prev: validPastPeriod(shiftPeriod(month, -1)) ? shiftPeriod(month, -1) : null, next: month < currentPeriod() ? shiftPeriod(month, 1) : null,
        }));
      }
      if (extra === "comprobante") {
        return send(res, 200, residentProofPage({ ...found, dues, token, proofs: ledger.proofs.listForHouse(found.house.id), sent: url.searchParams.get("m") === "enviado" }));
      }
      if (pay) {
        // Nothing left to pay (the bank confirmed while the page was open): go back to the home, which says "Al día".
        if (!dues.some((d) => d.status === "pending")) return redirect(res, `/r/${token}`);
        return send(res, 200, residentPayPage({ ...found, tenant: { ...found.tenant, payMethods: ledger.payMethods.list() }, dues, token, proofs: ledger.proofs.listForHouse(found.house.id) }));
      }
      return send(res, 200, residentPage({ ...found, dues, period: currentPeriod(), token, proofs: ledger.proofs.listForHouse(found.house.id), pushKey: notifier.publicKey(), pushOn: ledger.housePush.count(found.house.id) }));
    }

    // ---- Everything below needs a fully signed-in treasurer ----
    if (path === "/" || path === "/panel" || path.startsWith("/panel/")) return panel(req, res, url, path, method);

    return send(res, 404, notFoundPage());
  }

  async function residentUpload(req, res, token) {
    const found = store.residentByToken(token);
    if (!found) return send(res, 404, notFoundPage());
    if (!sameOrigin(req, config.publicUrl)) return send(res, 403, "Origen no permitido");
    const ledger = store.forTenant(found.tenant.id);
    const dues = ledger.dues.listForHouse(found.house.id);
    const show = (error, status = 400) => send(res, status, residentProofPage({ ...found, dues, token, proofs: ledger.proofs.listForHouse(found.house.id), error }));
    const key = `proof:${found.house.id}`;
    if (proofLimiter.blocked(key)) return show("Has enviado muchos comprobantes. Espera un rato e inténtalo de nuevo.", 429);
    let body;
    try {
      body = await readBuffer(req, MAX_PROOF_BYTES + 64 * 1024);
    } catch (e) {
      if (e.status === 413) return show("El archivo pesa más de 5 MB. Toma la foto con menos calidad o envía una captura de pantalla.", 413);
      throw e;
    }
    proofLimiter.fail(key);
    const parsed = parseMultipart(body, req.headers["content-type"]);
    const file = parsed?.files.archivo;
    if (!file || file.data.length === 0) return show("Elige la foto o el PDF del comprobante.");
    if (file.data.length > MAX_PROOF_BYTES) return show("El archivo pesa más de 5 MB.", 413);
    const mime = sniffProof(file.data);
    if (!mime) return show("Solo se aceptan fotos (JPG, PNG, WebP) o PDF.");
    try {
      ledger.proofs.create({ houseId: found.house.id, mime, data: file.data, note: parsed.fields.nota });
    } catch (e) {
      if (/esperando revisión/.test(e.message)) return show(e.message);
      throw e;
    }
    void notify(found.tenant.id, { title: "Comprobante nuevo", body: `La casa ${found.house.code} subió un comprobante`, url: "/panel#comprobantes", tag: "comprobante" });
    return redirect(res, `/r/${token}/comprobante?m=enviado`);
  }

  /** Keeps an encrypted copy of a house's personal link (MASTER_KEY) so the reminders can include it. Never throws: the link itself already exists. */
  const keepLink = (ledger, houseId, token) => {
    try { ledger.houses.setSealedLink(houseId, encryptSecret(token, config.masterKey)); } catch { /* the reminder just goes without the link */ }
  };

  /** Writes one line in the conjunto's audit log. Never throws: a log failure must not undo what was just done. */
  const auditFor = (ledger, s) => (action, summary, target = {}) => {
    try { ledger.audit.record({ userId: s.user.id, userName: s.user.name, action, summary, targetType: target.type ?? null, targetId: target.id ?? null }); } catch { /* the action stands */ }
  };

  /** A paid house hears it on its own phone: "Pago confirmado". Never throws and never delays the answer. */
  function notifyConfirmed(tenantId, paymentId) {
    try {
      const p = store.forTenant(tenantId).payments.get(paymentId);
      if (p?.status === "assigned" && p.houseId) {
        void notifier.house(tenantId, p.houseId, { title: "Pago confirmado", body: `Recibimos tu pago de ${peso(p.amountCents)}. ¡Gracias!`, url: "@resident", tag: "pago" });
      }
    } catch { /* a notification must never break a payment */ }
  }

  /** A resident turns notifications on or off for their own house. The personal link is the credential; same origin only. */
  async function residentPush(req, res, token, action) {
    const found = store.residentByToken(token);
    if (!found) return send(res, 404, notFoundPage());
    if (!sameOrigin(req, config.publicUrl)) return send(res, 403, "Origen no permitido");
    const key = `push:${found.house.id}`;
    if (proofLimiter.blocked(key)) return send(res, 429, "Demasiados intentos", { "Content-Type": "text/plain; charset=utf-8" });
    proofLimiter.fail(key);
    const form = new URLSearchParams(await readBody(req, 4 * 1024));
    const ledger = store.forTenant(found.tenant.id);
    const endpoint = String(form.get("endpoint") ?? "");
    const text = { "Content-Type": "text/plain; charset=utf-8" };
    if (action === "baja") {
      ledger.housePush.remove(endpoint);
      return send(res, 200, "ok", text);
    }
    const p256dh = String(form.get("p256dh") ?? "");
    const auth = String(form.get("auth") ?? "");
    if (!validEndpoint(endpoint) || !validKeys(p256dh, auth)) return send(res, 400, "Suscripción inválida", text);
    ledger.housePush.add({ houseId: found.house.id, endpoint, p256dh, auth });
    return send(res, 200, "ok", text);
  }

  /** Estado de cuenta or paz y salvo of one house, for the resident (their link) or the treasurer. A certificate is only
   *  issued while the house has no overdue dues, and each one gets a code that /verificar can check. */
  function serveDocument(res, kind, { tenant, house, ledger, backHref, base, issuedBy, manifest }) {
    if (!house.active) return send(res, 404, notFoundPage());
    const today = bogotaDateTime(new Date().toISOString()).slice(0, 10);
    const all = ledger.dues.listForHouse(house.id);
    const grouped = groupDebts(all.filter((d) => d.status === "pending"), [house], currentPeriod(), { dueDay: tenant.dueDay });
    const late = new Set((grouped[0]?.dues ?? []).filter((d) => d.late).map((d) => d.id));
    const rows = all.map((d) => ({ ...d, late: late.has(d.id) }));
    const sum = (list) => list.reduce((n, d) => n + d.amountCents, 0);
    const doc = { today, rows, paidCents: sum(rows.filter((d) => d.status === "paid")), pendingCents: sum(rows.filter((d) => d.status === "pending")), lateCents: sum(rows.filter((d) => d.late)) };
    if (kind === "estado") return send(res, 200, estadoPage({ tenant, house, doc, backHref, manifest }));
    const code = late.size === 0 ? ledger.certificates.issue({ houseId: house.id, kind: "paz_y_salvo", issuedOn: today, issuedBy }) : null;
    return send(res, 200, pazYSalvoPage({ tenant, house, doc, code, verifyUrl: `${config.publicUrl}/verificar`, backHref, estadoHref: `${base}/estado`, manifest }));
  }

  /** "35.000", "$ 35000" or "35,000" -> cents, or null when it is not a plain amount of pesos. */
  function parsePesos(text) {
    const digits = String(text).replace(/[\s$.,]/g, "");
    return /^\d{1,10}$/.test(digits) ? Number(digits) * 100 : null;
  }

  /** An expense's receipt (photo or PDF): only what it was verified to be, never executed; a PDF is downloaded. */
  function sendExpenseFile(res, file) {
    return send(res, 200, file.data, {
      "Content-Type": file.mime,
      "Content-Disposition": file.mime === "application/pdf" ? 'attachment; filename="soporte.pdf"' : "inline",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "private, no-store",
    });
  }

  // ---------- passkeys (WebAuthn) ----------

  const rpId = new URL(config.publicUrl).hostname;
  const rpOrigin = new URL(config.publicUrl).origin;
  const jsonBody = async (req, limit = 16 * 1024) => { try { return JSON.parse(await readBody(req, limit)); } catch (e) { if (e.status === 413) throw e; return null; } };
  const passkeyDenied = (res, status = 401) => sendJson(res, status, { error: "No se pudo entrar con el passkey. Usa tu correo y contraseña." });
  /** The challenge a browser signed is inside its clientDataJSON: read it to find (and burn) the one we issued. */
  const challengeOf = (credential) => { try { return JSON.parse(fromB64u(credential?.response?.clientDataJSON).toString("utf8")).challenge; } catch { return null; } };

  async function passkeyLoginOptions(req, res) {
    if (!sameOrigin(req, config.publicUrl)) return send(res, 403, "Origen no permitido");
    const key = `passkey|${req.socket.remoteAddress}`;
    if (loginLimiter.blocked(key)) return passkeyDenied(res, 429);
    // No allowCredentials: the passkey itself says who it is (discoverable credential), so no email is typed.
    return sendJson(res, 200, { challenge: store.webauthnChallenges.create({ purpose: "login" }), rpId, userVerification: "required", timeout: 60_000 });
  }

  async function passkeyLogin(req, res) {
    if (!sameOrigin(req, config.publicUrl)) return send(res, 403, "Origen no permitido");
    const key = `passkey|${req.socket.remoteAddress}`;
    if (loginLimiter.blocked(key)) return passkeyDenied(res, 429);
    const body = await jsonBody(req);
    const credential = body?.credential;
    const fail = () => { loginLimiter.fail(key); return passkeyDenied(res); };
    const challenge = challengeOf(credential);
    if (!challenge || !store.webauthnChallenges.consume(challenge, "login")) return fail();
    const stored = store.passkeys.byCredentialId(credential?.id);
    if (!stored) return fail();
    let result;
    try {
      result = verifyAssertion({ response: credential.response, challenge, origin: rpOrigin, rpId, publicKey: stored.publicKey, storedSignCount: stored.signCount });
      const handle = credential.response.userHandle ? fromB64u(credential.response.userHandle).toString("utf8") : null;
      if (handle && handle !== stored.userId) throw new Error("userHandle");
    } catch {
      return fail();
    }
    const user = store.users.byId(stored.userId);
    if (!user) return fail();
    store.passkeys.touch(stored.id, result.signCount);
    loginLimiter.clear(key);
    // A passkey needs the device's fingerprint, face or PIN (checked above): that is both login steps in one.
    const token = store.sessions.create(user.id, { stage: "full", ttlMs: FULL_TTL_S * 1000 });
    try { store.forTenant(user.tenantId).audit.record({ userId: user.id, userName: user.name, action: "sesion", summary: "Inició sesión con passkey" }); } catch { /* the sign-in stands */ }
    return sendJson(res, 200, { ok: true, redirect: "/panel" }, setCookie(token, FULL_TTL_S));
  }

  /** Panel side: options to create a passkey, and the check of what the browser made. CSRF travels in the JSON body. */
  async function passkeyApi(req, res, s, ledger, path) {
    if (!sameOrigin(req, config.publicUrl)) return send(res, 403, "Origen no permitido");
    const body = await jsonBody(req);
    if (!body || !csrfValid(s.token, body._csrf)) return send(res, 403, "Formulario vencido. Recarga la página e inténtalo de nuevo.");
    const audit = auditFor(ledger, s);
    if (path === "/panel/passkeys/opciones") {
      const mine = ledger.passkeys.list(s.user.id);
      return sendJson(res, 200, {
        challenge: store.webauthnChallenges.create({ purpose: "register", userId: s.user.id }),
        rp: { name: "Cuotia", id: rpId },
        user: { id: b64u(Buffer.from(s.user.id)), name: s.user.email, displayName: s.user.name },
        pubKeyCredParams: ALLOWED_ALGS.map((alg) => ({ type: "public-key", alg })),
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        attestation: "none", timeout: 60_000,
        excludeCredentials: mine.map((p) => ({ type: "public-key", id: p.credentialId })),
      });
    }
    // /panel/passkeys/registrar
    const credential = body.credential;
    const challenge = challengeOf(credential);
    const issued = challenge ? store.webauthnChallenges.consume(challenge, "register") : null;
    if (!issued || issued.userId !== s.user.id) return sendJson(res, 400, { error: "El intento venció. Inténtalo de nuevo." });
    try {
      const made = verifyRegistration({ response: credential.response, challenge, origin: rpOrigin, rpId });
      if (credential.id !== made.credentialId) throw new Error("La credencial no coincide");
      const name = String(body.name ?? "").trim().slice(0, 40) || "Este dispositivo";
      ledger.passkeys.add({ userId: s.user.id, ...made, name, transports: Array.isArray(credential.response.transports) ? credential.response.transports.filter((t) => typeof t === "string") : null });
      audit("seguridad", `Agregó un passkey: ${name}`);
    } catch (e) {
      return sendJson(res, 400, { error: /Máximo|ya está registrado/.test(e.message) ? e.message : "No se pudo guardar el passkey. Inténtalo de nuevo." });
    }
    return sendJson(res, 200, { ok: true });
  }

  async function addExpense(req, res, s, ledger, period) {
    if (!sameOrigin(req, config.publicUrl)) return send(res, 403, "Origen no permitido");
    let body;
    try {
      body = await readBuffer(req, MAX_PROOF_BYTES + 64 * 1024);
    } catch (e) {
      if (e.status === 413) return redirect(res, "/panel/cuentas?m=gastogrande");
      throw e;
    }
    const parsed = parseMultipart(body, req.headers["content-type"]);
    if (!parsed || !csrfValid(s.token, parsed.fields._csrf)) return send(res, 403, "Formulario vencido. Recarga la página e inténtalo de nuevo.");
    const amountCents = parsePesos(parsed.fields.valor ?? "");
    const file = parsed.files.soporte;
    let proof = null;
    if (file && file.data.length > 0) {
      const mime = sniffProof(file.data);
      if (!mime || file.data.length > MAX_PROOF_BYTES) return redirect(res, "/panel/cuentas?m=gastoarchivo");
      proof = { mime, data: file.data };
    }
    const spentOn = String(parsed.fields.fecha ?? "");
    const today = bogotaDateTime(new Date().toISOString()).slice(0, 10);
    if (!amountCents || spentOn > today) return redirect(res, "/panel/cuentas?m=gastobad");
    try {
      ledger.expenses.create({ spentOn, amountCents, category: String(parsed.fields.categoria ?? ""), description: parsed.fields.descripcion, proof, userId: s.user.id });
    } catch {
      return redirect(res, "/panel/cuentas?m=gastobad");
    }
    auditFor(ledger, s)("gastos", `Registró un gasto de ${peso(amountCents)}: ${String(parsed.fields.descripcion ?? "").trim().slice(0, 80)} (${parsed.fields.categoria})${proof ? ", con soporte" : ""}`);
    return redirect(res, `/panel/cuentas?${spentOn.slice(0, 7) !== period ? `mes=${spentOn.slice(0, 7)}&` : ""}m=gastook`);
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
    const result = ingestEvent(store, event, tenant.id);
    if (result.status === "assigned") notifyConfirmed(tenant.id, result.paymentId);
    if (result.status === "unassigned" || result.status === "assigned") {
      const paid = store.forTenant(tenant.id).payments.get(result.paymentId);
      if (paid) void notify(tenant.id, result.status === "assigned"
        ? { title: "Pago recibido", body: `Entró un pago de ${peso(paid.amountCents)} y ya quedó asignado`, url: "/panel/pagos", tag: "pago" }
        : { title: "Pago por asignar", body: `Entró un pago de ${peso(paid.amountCents)} sin casa asociada`, url: "/panel#por-asignar", tag: "pago" });
    }
    return sendJson(res, 200, result);
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

  // ---------- invitation to join a conjunto ----------

  /** The link a treasurer sends: the person picks their password here, then signs in (and enrolls 2-step) as usual. */
  async function invitation(req, res, token, method) {
    const ip = req.socket.remoteAddress;
    if (inviteLimiter.blocked(ip)) return send(res, 429, "Demasiados intentos. Espera unos minutos.");
    const inv = store.invitations.byToken(token);
    if (!inv) { inviteLimiter.fail(ip); return send(res, 404, notFoundPage()); }
    if (method === "GET") return send(res, 200, inviteAcceptPage({ inv, token }));

    if (!sameOrigin(req, config.publicUrl)) return send(res, 403, "Origen no permitido");
    const form = new URLSearchParams(await readBody(req, 8 * 1024));
    const name = String(form.get("nombre") ?? "").trim().slice(0, 80);
    const clave = String(form.get("clave") ?? "");
    const again = (error) => send(res, 400, inviteAcceptPage({ inv, token, error, name }));
    if (!name) return again("Escribe tu nombre.");
    if (clave.length < 10) return again("La contraseña debe tener al menos 10 caracteres.");
    if (clave !== String(form.get("clave2") ?? "")) return again("Las contraseñas no coinciden.");
    const passwordHash = await hashPassword(clave);
    try {
      store.invitations.accept(token, { passwordHash, name }); // re-checks after the slow hash: one link, one account
    } catch {
      inviteLimiter.fail(ip);
      return send(res, 404, notFoundPage());
    }
    return redirect(res, "/login?m=invitado");
  }

  // ---------- access recovery ----------

  /** Forgot the password: email + one backup code + the new password. Always the same answer when something is wrong, so it never says which emails exist. */
  async function forgotPassword(req, res) {
    if (!sameOrigin(req, config.publicUrl)) return send(res, 403, "Origen no permitido");
    const form = new URLSearchParams(await readBody(req, 8 * 1024));
    const email = String(form.get("email") ?? "").trim().toLowerCase().slice(0, 120);
    const ipKey = `ip|${req.socket.remoteAddress}`, mailKey = `mail|${email}`;
    if (forgotLimiter.blocked(ipKey) || forgotLimiter.blocked(mailKey)) return send(res, 429, olvidePage({ email, error: "Demasiados intentos. Espera unos minutos." }));
    const nueva = String(form.get("nueva") ?? "");
    if (nueva.length < 10 || nueva.length > 200) return send(res, 400, olvidePage({ email, error: "La contraseña nueva debe tener al menos 10 caracteres." }));
    if (nueva !== String(form.get("nueva2") ?? "")) return send(res, 400, olvidePage({ email, error: "Las contraseñas no coinciden." }));
    const hash = await hashPassword(nueva); // same work whether or not the email exists
    const user = store.users.byEmail(email);
    const code = normalizeRecoveryCode(form.get("codigo"));
    if (!user || !code || !store.recoveryCodes.consume(user.id, recoveryHash(code, config.masterKey))) {
      forgotLimiter.fail(ipKey); forgotLimiter.fail(mailKey);
      return send(res, 400, olvidePage({ email, error: "El correo o el código de respaldo no son correctos." }));
    }
    store.users.setPasswordHash(user.id, hash);
    store.sessions.deleteForUser(user.id); // anyone who had the old password is out
    forgotLimiter.clear(ipKey); forgotLimiter.clear(mailKey);
    try { store.forTenant(user.tenantId).audit.record({ userId: user.id, userName: user.name, action: "seguridad", summary: "Cambió su contraseña con un código de respaldo" }); } catch { /* the change stands */ }
    return redirect(res, "/login?m=clavenueva");
  }

  /** A colleague's link: choose a new password; the old phone, passkeys, backup codes and sessions are discarded and the next sign-in enrolls a new phone. */
  async function accessReset(req, res, token, method) {
    const ip = req.socket.remoteAddress;
    if (inviteLimiter.blocked(ip)) return send(res, 429, "Demasiados intentos. Espera unos minutos.");
    const r = store.accessResets.byToken(token);
    if (!r) { inviteLimiter.fail(ip); return send(res, 404, notFoundPage()); }
    if (method === "GET") return send(res, 200, restablecerPage({ r, token }));
    if (!sameOrigin(req, config.publicUrl)) return send(res, 403, "Origen no permitido");
    const form = new URLSearchParams(await readBody(req, 8 * 1024));
    const clave = String(form.get("clave") ?? "");
    const again = (error) => send(res, 400, restablecerPage({ r, token, error }));
    if (clave.length < 10 || clave.length > 200) return again("La contraseña debe tener al menos 10 caracteres.");
    if (clave !== String(form.get("clave2") ?? "")) return again("Las contraseñas no coinciden.");
    const passwordHash = await hashPassword(clave);
    let used;
    try { used = store.accessResets.use(token, { passwordHash }); } catch { inviteLimiter.fail(ip); return send(res, 404, notFoundPage()); }
    try { store.forTenant(used.tenantId).audit.record({ userId: used.userId, userName: used.name, action: "seguridad", summary: "Restableció su acceso con un enlace de un compañero" }); } catch { /* the reset stands */ }
    return redirect(res, "/login?m=accesonuevo");
  }

  /** Lost phone: a backup code opens the second step once. */
  async function backupCodeLogin(req, res) {
    if (!sameOrigin(req, config.publicUrl)) return send(res, 403, "Origen no permitido");
    const s = sessionOf(req);
    if (!s) return redirect(res, "/login");
    if (s.stage !== "pending") return redirect(res, s.stage === "full" ? "/panel" : "/2fa");
    const form = new URLSearchParams(await readBody(req, 4 * 1024));
    if (codeLimiter.blocked(s.user.id)) return send(res, 429, twoFaPage({ stage: s.stage, backupAction: "/2fa/respaldo", error: "Demasiados intentos. Vuelve a entrar en unos minutos." }));
    const code = normalizeRecoveryCode(form.get("codigo"));
    if (!code || !store.recoveryCodes.consume(s.user.id, recoveryHash(code, config.masterKey))) {
      codeLimiter.fail(s.user.id);
      return send(res, 401, twoFaPage({ stage: s.stage, backupAction: "/2fa/respaldo", error: "Ese código de respaldo no sirve. Revisa que lo escribiste igual que en tu hoja, o que no lo hayas usado ya." }));
    }
    codeLimiter.clear(s.user.id);
    const ledger = store.forTenant(s.user.tenantId);
    try { ledger.audit.record({ userId: s.user.id, userName: s.user.name, action: "sesion", summary: "Inició sesión con un código de respaldo" }); } catch { /* the sign-in stands */ }
    const full = store.sessions.promote(s.token, FULL_TTL_S * 1000);
    return redirect(res, `/panel?m=respaldousado&n=${ledger.recovery.status(s.user.id).remaining}`, setCookie(full, FULL_TTL_S));
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
    const view = { stage: s.stage, error, backupAction: s.stage === "pending" ? "/2fa/respaldo" : null };
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
    if (codeLimiter.blocked(s.user.id)) return send(res, 429, twoFaPage({ stage: s.stage, backupAction: s.stage === "pending" ? "/2fa/respaldo" : null, error: "Demasiados intentos. Vuelve a entrar en unos minutos." }));

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
    try { store.forTenant(user.tenantId).audit.record({ userId: user.id, userName: user.name, action: "sesion", summary: "Inició sesión" }); } catch { /* the sign-in stands */ }
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
    // The encrypted personal links become `house.link` here, once per request, so the WhatsApp reminders of every page can carry them.
    const sealed = ledger.houses.sealedLinks();
    const houses = ledger.houses.list().map((h) => {
      let link = null;
      try { if (sealed.has(h.id)) link = `${config.publicUrl}/r/${decryptSecret(sealed.get(h.id), config.masterKey)}`; } catch { /* unreadable (key changed): no link in the message */ }
      return { ...h, link };
    });
    // Who owes what, across months: the sidebar badge, "Por cobrar", the dashboard and the payment form all read this.
    const groups = groupDebts(ledger.dues.listPending(), houses, period, { dueDay: s.tenant.dueDay });
    const debts = { groups, totals: debtTotals(groups) };
    // What the sidebar and tab bar show on every page.
    const base = {
      // `payMethods`, `templates`, `sender` and `monthlyCents` are what the WhatsApp messages are built from.
      tenant: {
        ...s.tenant, payMethods: ledger.payMethods.list(), templates: ledger.templates.all(), sender: s.user.name,
        monthlyCents: ledger.concepts.list().reduce((n, c) => n + c.amountCents, 0),
      }, user: s.user, csrf,
      badge: ledger.payments.countUnassigned() + ledger.proofs.countPending(), owing: groups.length, houseCount: houses.length,
      cuota: (() => { const m = ledger.concepts.list(); return m.length === 0 ? "" : m.length === 1 ? `${m[0].name} ${peso(m[0].amountCents)}` : `Cuota mensual ${peso(m.reduce((n, c) => n + c.amountCents, 0))}`; })(),
    };

    if (method === "GET" && (path === "/" || path === "/panel")) {
      // Any month that has dues can be looked at; "mes" outside that list falls back to the current one.
      const months = [...new Set([period, ...ledger.dues.periods()])].sort().reverse();
      const asked = url.searchParams.get("mes");
      // Any month up to 24 back can be opened, even one that was never generated (the page then offers to create it).
      const selected = months.includes(asked) || validPastPeriod(asked) ? asked : period;
      return send(res, 200, panelPage({
        ...base,
        flash: flashOf(url.searchParams),
        summary: ledger.summary(selected),
        dues: ledger.dues.listByPeriod(selected),
        unassigned: ledger.payments.listUnassigned(),
        proofs: ledger.proofs.listPending(),
        houses, debts, current: period,
        prevPeriod: validPastPeriod(shiftPeriod(selected, -1)) ? shiftPeriod(selected, -1) : null,
        nextPeriod: selected < period ? shiftPeriod(selected, 1) : null,
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

    const proofFile = method === "GET" && path.match(/^\/panel\/comprobantes\/(pf_[a-f0-9]+)\/archivo$/);
    if (proofFile) {
      const file = ledger.proofs.file(proofFile[1]);
      if (!file) return send(res, 404, notFoundPage());
      // Untrusted bytes: served as what they were verified to be, never sniffed, never executed; a PDF is downloaded.
      return send(res, 200, file.data, {
        "Content-Type": file.mime,
        "Content-Disposition": file.mime === "application/pdf" ? 'attachment; filename="comprobante.pdf"' : "inline",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cache-Control": "private, no-store",
      });
    }

    if (method === "GET" && path === "/panel/pagos/nuevo") {
      const proof = ledger.proofs.meta(String(url.searchParams.get("comprobante") ?? ""));
      // ?casa= opens that house's form; ?cuota= ticks one due (the row's button), ?todas=1 ticks them all.
      return send(res, 200, pagoManualPage({
        ...base, flash: flashOf(url.searchParams), debts, current: period,
        proof: proof?.status === "pending" ? proof : null,
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
      const proofOf = ledger.payments.proofsByPayment(result.rows.map((r) => r.id));
      for (const row of result.rows) row.proof = proofOf.get(row.id) ?? null;
      return send(res, 200, pagosPage({
        ...base, flash: flashOf(url.searchParams), result, period,
        filters: { mes: f.period ?? "", estado: f.status ?? "", q: f.q, p: f.p },
        page: f.p, pages: Math.max(1, Math.ceil(result.total / PAGE_SIZE)),
      }));
    }

    if (method === "GET" && path === "/panel/casas/importar") return send(res, 200, importPage({ ...base }));

    if (method === "GET" && path === "/panel/ajustes") {
      return send(res, 200, ajustesPage({ ...base, flash: flashOf(url.searchParams), team: ledger.team.list(), invites: ledger.team.invitations(), meId: s.user.id, recovery: ledger.recovery.status(s.user.id), pushKey: vapid().publicKey, pushDevices: ledger.push.countForUser(s.user.id), passkeys: ledger.passkeys.list(s.user.id), webhookUrl: `${config.publicUrl}/webhooks/pagoradar/${s.tenant.id}` }));
    }

    if (method === "GET" && (path === "/panel/cuentas" || path === "/panel/cuentas.csv")) {
      const asked = url.searchParams.get("mes");
      const month = validPastPeriod(asked) ? asked : period;
      const list = ledger.expenses.list({ period: month });
      if (path === "/panel/cuentas.csv") {
        const head = ["Fecha", "Categoría", "Descripción", "Valor (COP)", "Soporte", "Estado"];
        const lines = list.map((e) => [e.spentOn, e.category, e.description, Math.round(e.amountCents / 100), e.hasProof ? "Sí" : "No", e.voided ? "Anulado" : "Vigente"].map(csvCell).join(";"));
        return send(res, 200, `\uFEFF${[head.map(csvCell).join(";"), ...lines].join("\r\n")}\r\n`, {
          "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="gastos-${month}.csv"`,
        });
      }
      let publicLink = null;
      try { const enc = store.tenants.publicTokenEnc(s.tenant.id); if (enc) publicLink = `${config.publicUrl}/t/${decryptSecret(enc, config.masterKey)}`; } catch { /* unreadable: shown as off */ }
      return send(res, 200, cuentasPage({
        ...base, publicLink, flash: flashOf(url.searchParams), period: month, current: period, books: ledger.books(month), expenses: list,
        categories: EXPENSE_CATEGORIES, today: bogotaDateTime(new Date().toISOString()).slice(0, 10),
        prev: validPastPeriod(shiftPeriod(month, -1)) ? shiftPeriod(month, -1) : null, next: month < period ? shiftPeriod(month, 1) : null,
      }));
    }

    if (method === "GET" && path === "/panel/conceptos") {
      return send(res, 200, conceptosPage({
        ...base, flash: flashOf(url.searchParams), concepts: ledger.concepts.all(), houses, current: period,
        months: lastPeriods(period, 6), today: period,
      }));
    }

    if (method === "GET" && path === "/panel/reiniciar") {
      return send(res, 200, reiniciarPage({ ...base, flash: flashOf(url.searchParams), preview: ledger.resetPreview(), withBackup: !!config.backupDir }));
    }

    if (method === "GET" && path === "/panel/mensajes") {
      return send(res, 200, mensajesPage({ ...base, flash: flashOf(url.searchParams), focus: String(url.searchParams.get("k") ?? ""), origin: config.publicUrl }));
    }

    if (method === "GET" && path === "/panel/mas") return send(res, 200, masPage({ ...base }));

    if (method === "GET" && path === "/panel/bitacora") {
      const action = String(url.searchParams.get("tipo") ?? "");
      const q = String(url.searchParams.get("q") ?? "").trim().slice(0, 60);
      const page = Math.max(1, Number.parseInt(url.searchParams.get("p") ?? "1", 10) || 1);
      const result = ledger.audit.list({ action: AUDIT_ACTIONS[action] ? action : null, q, limit: 50, offset: (page - 1) * 50 });
      return send(res, 200, bitacoraPage({ ...base, result, tipo: AUDIT_ACTIONS[action] ? action : "", q, page, pages: Math.max(1, Math.ceil(result.total / 50)), actions: AUDIT_ACTIONS }));
    }

    const houseDoc = method === "GET" && path.match(/^\/panel\/casas\/(hs_[a-f0-9]+)\/(estado|paz-y-salvo)$/);
    if (houseDoc) {
      const house = ledger.houses.get(houseDoc[1]);
      if (!house) return send(res, 404, notFoundPage());
      return serveDocument(res, houseDoc[2], { tenant: s.tenant, house, ledger, backHref: `/panel/casas/${house.id}`, base: `/panel/casas/${house.id}`, issuedBy: s.user.id });
    }

    const expenseFile = method === "GET" && path.match(/^\/panel\/gastos\/(gt_[a-f0-9]+)\/soporte$/);
    if (expenseFile) {
      const file = ledger.expenses.file(expenseFile[1]);
      return file ? sendExpenseFile(res, file) : send(res, 404, notFoundPage());
    }

    if (method !== "POST") return send(res, 404, notFoundPage());

    // A new expense carries a file, so it is multipart; the form token travels as a field.
    if (path === "/panel/gastos") return addExpense(req, res, s, ledger, period);
    if (path === "/panel/passkeys/opciones" || path === "/panel/passkeys/registrar") return passkeyApi(req, res, s, ledger, path);

    // Every state change: same origin AND the session's form token.
    if (!sameOrigin(req, config.publicUrl)) return send(res, 403, "Origen no permitido");
    const form = new URLSearchParams(await readBody(req, 8 * 1024));
    if (!csrfValid(s.token, form.get("_csrf"))) return send(res, 403, "Formulario vencido. Recarga la página e inténtalo de nuevo.");
    const back = (m, n) => redirect(res, `/panel?m=${m}${n === undefined ? "" : `&n=${n}`}`);
    const audit = auditFor(ledger, s);
    const houseTag = (id) => { const h = ledger.houses.get(id); return h ? `la casa ${h.code}` : "una casa"; };

    try {
      if (path === "/panel/ajustes/pagoradar") {
        const secret = String(form.get("secret") ?? "").trim();
        if (secret.length < 8 || secret.length > 200 || /\s/.test(secret)) return redirect(res, "/panel/ajustes?m=secbad");
        store.tenants.setPagoradarSecret(s.tenant.id, encryptSecret(secret, config.masterKey));
        audit("ajustes", "Guardó el secreto de pagoradar");
        return redirect(res, "/panel/ajustes?m=sec");
      }

      if (path === "/panel/push/suscribir") {
        const endpoint = String(form.get("endpoint") ?? "");
        const p256dh = String(form.get("p256dh") ?? "");
        const auth = String(form.get("auth") ?? "");
        if (!validEndpoint(endpoint) || !validKeys(p256dh, auth)) return send(res, 400, "Suscripción inválida", { "Content-Type": "text/plain; charset=utf-8" });
        ledger.push.add({ userId: s.user.id, endpoint, p256dh, auth });
        return send(res, 200, "ok", { "Content-Type": "text/plain; charset=utf-8" });
      }
      if (path === "/panel/push/baja") {
        ledger.push.remove(String(form.get("endpoint") ?? ""));
        return send(res, 200, "ok", { "Content-Type": "text/plain; charset=utf-8" });
      }
      if (path === "/panel/push/probar") {
        if (ledger.push.countForUser(s.user.id) === 0) return redirect(res, "/panel/ajustes?m=pushsin");
        await notify(s.tenant.id, { title: "Cuotia", body: "Los avisos funcionan en este dispositivo.", url: "/panel/ajustes", tag: "prueba" }, { userId: s.user.id });
        return redirect(res, "/panel/ajustes?m=pushprobe");
      }

      if (path === "/panel/equipo/invitar") {
        try {
          const { token, email } = ledger.team.invite({ email: form.get("correo"), name: form.get("nombre"), invitedBy: s.user.id });
          audit("equipo", `Invitó a ${email} al equipo`);
          return send(res, 200, inviteLinkPage({ ...base, url: `${config.publicUrl}/invitacion/${token}`, email, name: String(form.get("nombre") ?? "").trim().slice(0, 80) }));
        } catch (e) {
          return redirect(res, `/panel/ajustes?m=${/ya tiene/.test(e.message) ? "eqexiste" : "eqbad"}`);
        }
      }
      const cancelInvite = path.match(/^\/panel\/equipo\/invitaciones\/(inv_[a-f0-9]+)\/cancelar$/);
      if (cancelInvite) {
        const pending = ledger.team.invitations().find((i) => i.id === cancelInvite[1]);
        ledger.team.cancelInvitation(cancelInvite[1]);
        audit("equipo", `Canceló la invitación a ${pending?.email ?? "alguien"}`);
        return redirect(res, "/panel/ajustes?m=eqcanc");
      }
      const removeUser = path.match(/^\/panel\/equipo\/(usr_[a-f0-9]+)\/quitar$/);
      if (removeUser) {
        if (removeUser[1] === s.user.id) return redirect(res, "/panel/ajustes?m=eqyo");
        const gone = ledger.team.list().find((u) => u.id === removeUser[1]);
        try { ledger.team.remove(removeUser[1]); } catch { return redirect(res, "/panel/ajustes?m=equltimo"); }
        audit("equipo", `Quitó a ${gone?.name ?? "una persona"} (${gone?.email ?? ""}) del equipo`);
        return redirect(res, "/panel/ajustes?m=eqquit");
      }

      if (path === "/panel/conceptos") {
        const amount = parsePesos(String(form.get("valor") ?? ""));
        const name = String(form.get("nombre") ?? "").trim();
        if (amount === null) return redirect(res, "/panel/conceptos?m=cnbad");
        try {
          ledger.concepts.create({ name, amountCents: amount, kind: "monthly" });
        } catch (e) {
          return redirect(res, `/panel/conceptos?m=${/ya existe/i.test(e.message) ? "cndup" : "cnbad"}`);
        }
        ledger.dues.generate(period); // this month's due appears right away, not at the next hourly run
        audit("cobros", `Agregó el cobro mensual "${name}" por ${peso(amount)}`);
        return redirect(res, "/panel/conceptos?m=cnok");
      }

      const conceptAmount = path.match(/^\/panel\/conceptos\/(cn_[a-f0-9]+)\/valor$/);
      if (conceptAmount) {
        const amount = parsePesos(String(form.get("valor") ?? ""));
        if (amount === null) return redirect(res, "/panel/conceptos?m=cnbad");
        const before = ledger.concepts.all().find((c) => c.id === conceptAmount[1]);
        try { ledger.concepts.setAmount(conceptAmount[1], amount); } catch { return redirect(res, "/panel/conceptos?m=cnbad"); }
        audit("cobros", `Cambió el valor de "${before?.name ?? "un cobro"}" de ${peso(before?.amountCents ?? 0)} a ${peso(amount)} (solo para las cuotas nuevas)`);
        return redirect(res, "/panel/conceptos?m=cnval");
      }

      const conceptState = path.match(/^\/panel\/conceptos\/(cn_[a-f0-9]+)\/estado$/);
      if (conceptState) {
        const on = form.get("activo") === "1";
        const before = ledger.concepts.all().find((c) => c.id === conceptState[1]);
        try { ledger.concepts.setActive(conceptState[1], on); } catch { return redirect(res, "/panel/conceptos?m=cnultimo"); }
        if (on) ledger.dues.generate(period);
        audit("cobros", `${on ? "Reanudó" : "Pausó"} el cobro mensual "${before?.name ?? "un cobro"}"`);
        return redirect(res, "/panel/conceptos?m=cnest");
      }

      if (path === "/panel/conceptos/especial") {
        const amount = parsePesos(String(form.get("valor") ?? ""));
        const name = String(form.get("nombre") ?? "").trim();
        const month = String(form.get("mes") ?? "");
        if (amount === null || !validPastPeriod(month)) return redirect(res, "/panel/conceptos?m=espbad");
        const all = form.get("alcance") !== "una";
        const targets = all ? ledger.houses.list().map((h) => h.id) : [String(form.get("casa") ?? "")];
        let made;
        try {
          made = ledger.concepts.charge({ name, amountCents: amount, period: month, houseIds: targets });
        } catch (e) {
          return redirect(res, `/panel/conceptos?m=${/ya existe/i.test(e.message) ? "cndup" : "espbad"}`);
        }
        audit("cobros", `Hizo un cobro especial "${name}" de ${peso(amount)} a ${all ? `todas las casas (${made.created})` : houseTag(targets[0])} para ${periodLabel(month)}`);
        return redirect(res, "/panel/cobros?m=espok");
      }

      if (path === "/panel/reiniciar") {
        // The most destructive thing the panel can do: password again, the word typed, and a copy of the database first.
        const key = `reiniciar|${s.user.id}`;
        const user = store.users.byId(s.user.id);
        if (loginLimiter.blocked(key) || !(await verifyPassword(String(form.get("clave") ?? ""), user.passwordHash))) {
          loginLimiter.fail(key);
          return redirect(res, "/panel/reiniciar?m=rsclave");
        }
        if (String(form.get("confirmar") ?? "").trim().toUpperCase() !== "BORRAR") return redirect(res, "/panel/reiniciar?m=rsconf");
        const keepHouses = form.get("alcance") !== "todo";
        if (config.backupDir) {
          // No copy, nothing is erased. Two copies in the same second would share a name: the next second's name is used.
          let saved = false;
          for (let i = 0; i < 3 && !saved; i++) {
            try { backupTo(store.db, join(config.backupDir, backupName(new Date(Date.now() + i * 1000)))); saved = true; } catch (e) { if (!/Ya existe/.test(e.message)) break; }
          }
          if (!saved) return redirect(res, "/panel/reiniciar?m=rscopia");
        }
        loginLimiter.clear(key);
        const gone = ledger.reset({ keepHouses });
        ledger.dues.generate(period);
        audit("ajustes", `Empezó de cero: borró ${gone.payments} pago${gone.payments === 1 ? "" : "s"}, ${gone.dues} cuota${gone.dues === 1 ? "" : "s"}, ${gone.proofs} comprobante${gone.proofs === 1 ? "" : "s"} y ${gone.expenses} gasto${gone.expenses === 1 ? "" : "s"}; ${keepHouses ? "conservó las casas" : `borró también ${gone.houses} casa${gone.houses === 1 ? "" : "s"}`}`);
        return redirect(res, `/panel?m=${config.backupDir ? "reinicio" : "reiniciosc"}`);
      }

      const removePasskey = path.match(/^\/panel\/passkeys\/(pk_[a-f0-9]+)\/quitar$/);
      if (removePasskey) {
        const mine = ledger.passkeys.list(s.user.id).find((p) => p.id === removePasskey[1]);
        try { ledger.passkeys.remove(removePasskey[1], s.user.id); } catch { return redirect(res, "/panel/ajustes?m=pkbad"); }
        audit("seguridad", `Quitó un passkey: ${mine?.name ?? ""}`.trim());
        return redirect(res, "/panel/ajustes?m=pkquit");
      }

      const saveMessage = path.match(/^\/panel\/mensajes\/([a-z_]+)$/);
      if (saveMessage) {
        const key = saveMessage[1];
        if (!MESSAGE_KEYS.includes(key)) return redirect(res, "/panel/mensajes?m=msbad");
        const checked = validateTemplate(key, String(form.get("texto") ?? ""));
        // Shown on the page itself (escaped), with what was typed, instead of putting text in the address.
        if (!checked.ok) return send(res, 400, mensajesPage({ ...base, focus: key, origin: config.publicUrl, error: checked.error, draft: String(form.get("texto") ?? "") }));
        ledger.templates.set(key, checked.body);
        audit("ajustes", `Cambió el mensaje de WhatsApp: ${MESSAGES[key].title}`);
        return redirect(res, `/panel/mensajes?m=msok&k=${key}`);
      }
      const resetMessage = path.match(/^\/panel\/mensajes\/([a-z_]+)\/restablecer$/);
      if (resetMessage && MESSAGE_KEYS.includes(resetMessage[1])) {
        ledger.templates.reset(resetMessage[1]);
        audit("ajustes", `Volvió al mensaje original de WhatsApp: ${MESSAGES[resetMessage[1]].title}`);
        return redirect(res, `/panel/mensajes?m=msreset&k=${resetMessage[1]}`);
      }

      const voidExpense = path.match(/^\/panel\/gastos\/(gt_[a-f0-9]+)\/anular$/);
      if (voidExpense) {
        const e = ledger.expenses.get(voidExpense[1]);
        ledger.expenses.void(voidExpense[1]);
        audit("gastos", `Anuló el gasto de ${peso(e?.amountCents ?? 0)}: ${e?.description ?? ""}`, { type: "gasto", id: voidExpense[1] });
        return redirect(res, `/panel/cuentas?${e && e.period !== period ? `mes=${e.period}&` : ""}m=gastoanul`);
      }

      if (path === "/panel/transparencia") {
        const act = form.get("accion");
        if (act === "activar" || act === "cambiar") {
          if (act === "activar" && store.tenants.publicTokenEnc(s.tenant.id)) return redirect(res, "/panel/cuentas?m=trok#transparencia");
          const token = newToken(24);
          store.tenants.setPublicToken(s.tenant.id, token, encryptSecret(token, config.masterKey));
          audit("ajustes", act === "activar" ? "Activó la página pública de transparencia" : "Cambió el enlace de la página pública de transparencia");
          return redirect(res, `/panel/cuentas?m=${act === "activar" ? "trok" : "trcambio"}#transparencia`);
        }
        if (act === "apagar") {
          store.tenants.clearPublicToken(s.tenant.id);
          audit("ajustes", "Apagó la página pública de transparencia");
          return redirect(res, "/panel/cuentas?m=trapagado#transparencia");
        }
        return redirect(res, "/panel/cuentas#transparencia");
      }

      if (path === "/panel/ajustes/cuentas") {
        const opening = parsePesos(String(form.get("saldo") || "0"));
        if (opening === null) return redirect(res, "/panel/cuentas?m=saldobad#ajustes");
        store.tenants.setAccounts(s.tenant.id, { openingCents: opening, showAccounts: form.get("mostrar") === "1" });
        audit("ajustes", `Cambió el saldo inicial (${peso(opening)}); las cuentas ${form.get("mostrar") === "1" ? "las ven los residentes" : "no las ven los residentes"}`);
        return redirect(res, "/panel/cuentas?m=cuentasok");
      }

      if (path === "/panel/ajustes/modo") {
        const mode = String(form.get("modo") ?? "");
        if (mode !== "auto" && mode !== "manual") return redirect(res, "/panel/ajustes?m=modobad");
        store.tenants.setPayMode(s.tenant.id, mode);
        audit("ajustes", `Cambió cómo confirma los pagos: ${mode === "auto" ? "automático con pagoradar" : "manual"}`);
        return redirect(res, "/panel/ajustes?m=modo");
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
        audit("ajustes", `Cambió las fechas de pago: del ${openDay ?? "—"} al ${dueDay ?? "—"}`);
        return redirect(res, "/panel/ajustes?m=fechas");
      }

      if (path === "/panel/ajustes/medios") {
        const kind = String(form.get("tipo") ?? "");
        try {
          ledger.payMethods.add({ kind, label: form.get("nombre"), account: form.get("cuenta"), accountType: form.get("clase"), holder: form.get("titular"), note: form.get("nota") });
        } catch (e) {
          return redirect(res, `/panel/ajustes?m=${/Ya agregaste/.test(e.message) ? "pmdup" : "pmbad"}`);
        }
        audit("ajustes", `Agregó un medio de pago: ${payMethodTitle({ kind, label: String(form.get("nombre") ?? "").trim(), accountType: kind === "bancolombia" ? String(form.get("clase") ?? "") : null })}`);
        return redirect(res, "/panel/ajustes?m=pmok");
      }
      const removeMethod = path.match(/^\/panel\/ajustes\/medios\/(pm_[a-f0-9]+)\/quitar$/);
      if (removeMethod) {
        const before = ledger.payMethods.list().find((m) => m.id === removeMethod[1]);
        try { ledger.payMethods.remove(removeMethod[1]); } catch { return redirect(res, "/panel/ajustes?m=pmbad"); }
        audit("ajustes", `Quitó un medio de pago: ${before ? payMethodTitle(before) : ""}`.trim());
        return redirect(res, "/panel/ajustes?m=pmquit");
      }

      if (path === "/panel/ajustes/cobro") {
        store.tenants.setPayment(s.tenant.id, { payKey: String(form.get("llave") ?? "").slice(0, 80), payHolder: String(form.get("titular") ?? "").slice(0, 80) });
        audit("ajustes", "Cambió la cuenta para cobrar (llave y titular)");
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
        audit("seguridad", "Cambió su contraseña");
        return redirect(res, "/panel/ajustes?m=clave");
      }

      if (path === "/panel/respaldo/generar" || path === "/panel/celular/cambiar") {
        const key = `clave|${s.user.id}`; // same counter as the password change: re-typing the password is the guard
        if (loginLimiter.blocked(key)) return redirect(res, "/panel/ajustes?m=clavelim#recuperacion");
        const user = store.users.byId(s.user.id);
        if (!(await verifyPassword(String(form.get("actual") ?? ""), user.passwordHash))) { loginLimiter.fail(key); return redirect(res, "/panel/ajustes?m=clavemal#recuperacion"); }
        loginLimiter.clear(key);
        if (path === "/panel/respaldo/generar") {
          const codes = newRecoveryCodes(10);
          ledger.recovery.replace(s.user.id, codes.map((c) => recoveryHash(normalizeRecoveryCode(c), config.masterKey)));
          audit("seguridad", "Generó códigos de respaldo nuevos");
          return send(res, 200, recoveryCodesPage({ ...base, codes }));
        }
        audit("seguridad", "Cambió el celular de verificación (se pedirá activar uno nuevo)");
        store.users.resetTotp(user.id);
        store.sessions.deleteForUser(user.id); // including this one: the next sign-in enrolls the new phone
        return redirect(res, "/login?m=celular", setCookie("", 0));
      }

      const resetUser = path.match(/^\/panel\/equipo\/(usr_[a-f0-9]+)\/acceso$/);
      if (resetUser) {
        if (resetUser[1] === s.user.id) return redirect(res, "/panel/ajustes?m=eqyo");
        try {
          const { token, email, name } = ledger.team.resetAccess(resetUser[1], s.user.id);
          audit("equipo", `Creó un enlace para restablecer el acceso de ${name} (${email})`);
          return send(res, 200, resetLinkPage({ ...base, url: `${config.publicUrl}/restablecer/${token}`, email, name }));
        } catch { return redirect(res, "/panel/ajustes?m=eqbad"); }
      }

      if (path === "/panel/cuotas/generar") {
        const asked = String(form.get("mes") ?? "") || period;
        if (!validPastPeriod(asked)) return redirect(res, "/panel?m=mesbad");
        const created = ledger.dues.generate(asked);
        audit("cuotas", `Generó las cuotas de ${periodLabel(asked)} para todas las casas (${created} nuevas)`);
        return redirect(res, `/panel?${asked === period ? "" : `mes=${asked}&`}m=gen&n=${created}`);
      }

      const assign = path.match(/^\/panel\/pagos\/(pg_[a-f0-9]+)\/asignar$/);
      if (assign) {
        const toAssign = ledger.payments.get(assign[1]);
        const { dueId } = ledger.payments.assign(assign[1], String(form.get("house") ?? ""), { rememberAlias: form.get("remember") === "1" });
        audit("pagos", `Asignó un pago de ${peso(toAssign?.amountCents ?? 0)} (${toAssign?.payerName || "sin nombre"}) a ${houseTag(String(form.get("house") ?? ""))}`, { type: "pago", id: assign[1] });
        if (dueId) notifyConfirmed(s.tenant.id, assign[1]);
        return back(dueId ? "asig" : "asigsin");
      }

      const rejectProof = path.match(/^\/panel\/comprobantes\/(pf_[a-f0-9]+)\/rechazar$/);
      if (rejectProof) {
        const rejected = ledger.proofs.meta(rejectProof[1]);
        ledger.proofs.reject(rejectProof[1]);
        audit("comprobantes", `Rechazó un comprobante de la casa ${rejected?.houseCode ?? "?"}`, { type: "comprobante", id: rejectProof[1] });
        return back("comprech");
      }

      if (path === "/panel/pagos/nuevo") {
        const houseId = String(form.get("casa") ?? "");
        const paidAt = manualPaidAt(String(form.get("fecha") ?? ""));
        const dueIds = form.getAll("cuota").map(String);
        if (!paidAt || dueIds.length === 0) return redirect(res, `/panel/pagos/nuevo?casa=${encodeURIComponent(houseId)}&m=manualbad`);
        const recorded = ledger.payments.recordManual({
          houseId, dueIds, method: String(form.get("medio") ?? "cash"), paidAt,
          // The bank only means something for a transfer: cash and "other" never keep one (the form pre-fills Nequi).
          bank: String(form.get("medio") ?? "") === "transfer" ? String(form.get("banco") ?? "") : "", note: String(form.get("nota") ?? ""),
          proofId: String(form.get("comprobante") ?? "") || null,
        });
        notifyConfirmed(s.tenant.id, recorded.paymentId);
        audit("pagos", `Registró un pago de ${peso(recorded.amountCents)} de ${houseTag(houseId)} (${MANUAL_LABELS[String(form.get("medio") ?? "cash")] ?? "otro"})${form.get("comprobante") ? ", con comprobante" : ""}`, { type: "pago", id: recorded.paymentId });
        return redirect(res, "/panel/cobros?m=manual");
      }

      if (path === "/panel/casas/importar") {
        const { rows, errors } = parseHouseLines(form.get("casas"));
        const created = [];
        const skipped = [];
        for (const row of rows) {
          try {
            const { house, accessToken } = ledger.houses.create({ code: row.code, residentName: row.residentName, phone: row.phone });
            keepLink(ledger, house.id, accessToken);
            const url = `${config.publicUrl}/r/${accessToken}`;
            created.push({ house, url, whatsapp: whatsappLink(base.tenant, house, url) });
          } catch (e) {
            if (!/UNIQUE/.test(e.message)) throw e;
            skipped.push({ line: row.line, text: `${row.code} · ${row.residentName}`, reason: `Ya existe la casa ${row.code}` });
          }
        }
        if (created.length) { ledger.dues.generate(period); audit("casas", `Importó ${created.length} casa${created.length === 1 ? "" : "s"}`); }
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
        keepLink(ledger, created.house.id, created.accessToken);
        ledger.dues.generate(period);
        audit("casas", `Agregó la casa ${created.house.code} (${created.house.residentName})`, { type: "casa", id: created.house.id });
        return showLink(res, base, created.house, created.accessToken);
      }

      const link = path.match(/^\/panel\/casas\/(hs_[a-f0-9]+)\/enlace$/);
      if (link) {
        const house = ledger.houses.get(link[1]);
        if (!house?.active) return redirect(res, "/panel/casas?m=err");
        const fresh = ledger.houses.rotateToken(house.id);
        keepLink(ledger, house.id, fresh);
        audit("casas", `Generó un enlace personal nuevo para la casa ${house.code}`, { type: "casa", id: house.id });
        return showLink(res, base, house, fresh);
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
          audit("cuotas", `Agregó ${periodLabel(asked)} a ${houseTag(houseId)}`, { type: "casa", id: houseId });
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
          audit("casas", `Editó los datos de la casa ${data.code}`, { type: "casa", id: houseId });
          return redirect(res, `${own}?m=ed`);
        }
        if (action === "alias") {
          const name = String(form.get("name") ?? "").trim().slice(0, 80);
          const added = name && ledger.aliases.add(houseId, name);
          if (added) audit("casas", `Agregó el nombre de pago "${name}" a ${houseTag(houseId)}`, { type: "casa", id: houseId });
          return redirect(res, `${own}?m=${added ? "aliasok" : "err"}`);
        }
        ledger.houses.setActive(houseId, action === "reactivar");
        audit("casas", `${action === "reactivar" ? "Dio de alta otra vez" : "Dio de baja"} ${houseTag(houseId)}`, { type: "casa", id: houseId });
        if (action === "reactivar") ledger.dues.generate(period);
        return redirect(res, action === "reactivar" ? `${own}?m=react` : "/panel/casas?m=desact");
      }

      const anonymize = path.match(/^\/panel\/casas\/(hs_[a-f0-9]+)\/anonimizar$/);
      if (anonymize) {
        const before = ledger.houses.get(anonymize[1]);
        try { ledger.houses.anonymize(anonymize[1]); } catch { return redirect(res, `/panel/casas/${anonymize[1]}?m=err`); }
        audit("casas", `Borró los datos personales de la casa ${before?.code ?? "?"}`, { type: "casa", id: anonymize[1] });
        return redirect(res, `/panel/casas/${anonymize[1]}?m=anon`);
      }

      const unalias = path.match(/^\/panel\/casas\/(hs_[a-f0-9]+)\/alias\/(al_[a-f0-9]+)\/quitar$/);
      if (unalias) {
        const removed = ledger.aliases.remove(unalias[1], unalias[2]);
        if (removed) audit("casas", `Quitó un nombre de pago de ${houseTag(unalias[1])}`, { type: "casa", id: unalias[1] });
        return redirect(res, `/panel/casas/${unalias[1]}?m=${removed ? "aliasdel" : "err"}`);
      }

      const undo = path.match(/^\/panel\/pagos\/(pg_[a-f0-9]+)\/deshacer$/);
      if (undo) {
        const undone = ledger.payments.get(undo[1]);
        const { deleted } = ledger.payments.revert(undo[1]);
        audit("pagos", `Deshizo el pago de ${peso(undone?.amountCents ?? 0)} (${deleted ? "manual, anulado" : "vuelve a por asignar"}) de ${houseTag(undone?.houseId)}`, { type: "pago", id: undo[1] });
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
      description: `Tu cuota en ${tenant.name}.`, lang: "es-CO", dir: "ltr",
      start_url: base, scope: base, display: "standalone", background_color: "#faf8f5", theme_color: "#3b3028",
      icons: [
        icon("/static/icons/icon-192.png", "192x192", "image/png"), icon("/static/icons/icon-512.png", "512x512", "image/png"),
        icon("/static/icons/maskable-512.png", "512x512", "image/png", "maskable"), icon("/static/icons/icon.svg", "any", "image/svg+xml"),
      ],
    };
  }

  /** A WhatsApp link to this resident with their personal link already written, or null without a usable phone. */
  function whatsappLink(tenant, house, linkUrl) {
    const to = whatsappNumber(house.phone);
    if (!to) return null;
    const text = message(tenant, "enlace_casa", { nombre: house.residentName.trim().split(/\s+/)[0], casa: house.code, enlace: linkUrl });
    return `https://wa.me/${to}?text=${encodeURIComponent(text)}`;
  }

  function showLink(res, base, house, token) {
    const linkUrl = `${config.publicUrl}/r/${token}`;
    return send(res, 200, linkPage({ ...base, house, url: linkUrl, whatsapp: whatsappLink(base.tenant, house, linkUrl) }));
  }

  const app = async function app(req, res) {
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
  app.notifier = notifier; // the hourly reminders (server.js) use the same keys
  return app;
}
