import { parseCookies, readBody, redirect, sameOrigin, send } from "./http.js";
import {
  AttemptLimiter, csrfToken, csrfValid, decryptSecret, encryptSecret, fakeVerify, hashPassword, matchTotp, newTotpSecret, verifyPassword,
} from "./security.js";
import { slugify } from "./text.js";
import { lastOffsite, runOffsiteBackup, testDestinations } from "./offsite.js";
import { OPERADOR_FLASHES, operadorCuentaPage, operadorLinkPage, operadorLoginPage, operadorPage, twoFaPage } from "./views.js";

const COOKIE = "cuotia_op";
const FULL_TTL_S = 12 * 3600;
const PENDING_TTL_MS = 10 * 60_000;
const SETUP_TTL_MS = 30 * 60_000;

/**
 * The operator panel (`/operador`): the platform's owner creates conjuntos and invites their treasurer. Own people, own
 * sessions and cookie (scoped to /operador), same security as a treasurer (password + mandatory 2-step code, CSRF, same
 * origin, rate limits). It sees counts only: never a resident, a payment or an account of any conjunto.
 * Answers 404 until at least one operator exists (`npm run admin -- crear-operador`), so it doesn't advertise itself.
 */
export function createOperator({ store, config }) {
  const loginLimiter = new AttemptLimiter();
  const codeLimiter = new AttemptLimiter({ max: 5, windowMs: 10 * 60_000 });
  const flags = `HttpOnly; SameSite=Strict; Path=/operador${config.secureCookies ? "; Secure" : ""}`;
  const setCookie = (token, maxAgeS) => ({ "Set-Cookie": `${COOKIE}=${token}; Max-Age=${maxAgeS}; ${flags}` });
  const clearCookie = () => setCookie("", 0);
  const sessionOf = (req) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    const s = store.operatorSessions.resolve(token);
    return s ? { ...s, token } : null;
  };
  const text = (res, status, msg) => send(res, status, msg, { "Content-Type": "text/plain; charset=utf-8" });

  const parsePesos = (value) => {
    const digits = String(value ?? "").replace(/[\s$.,]/g, "");
    return /^\d{1,9}$/.test(digits) ? Number(digits) * 100 : null;
  };
  const uniqueSlug = (name) => {
    const base = slugify(name);
    let slug = base;
    for (let i = 2; store.tenants.bySlug(slug); i++) slug = `${base}-${i}`.slice(0, 44);
    return slug;
  };

  function enrollmentSecret(operator) {
    if (operator.totpSecret && !operator.totpEnabled) return decryptSecret(operator.totpSecret, config.masterKey);
    const secret = newTotpSecret();
    store.operators.setTotpSecret(operator.id, encryptSecret(secret, config.masterKey));
    return secret;
  }

  function twoFaForm(req, res, error) {
    const s = sessionOf(req);
    if (!s) return redirect(res, "/operador/entrar");
    if (s.stage === "full") return redirect(res, "/operador");
    const view = { stage: s.stage, error, action: "/operador/2fa" };
    if (s.stage === "setup") {
      const op = store.operators.byId(s.operator.id);
      view.secret = enrollmentSecret(op);
      view.email = op.email;
      view.uri = `otpauth://totp/${encodeURIComponent(`Cuotia operador:${op.email}`)}?secret=${view.secret}&issuer=Cuotia`;
    }
    return send(res, error ? 401 : 200, twoFaPage(view));
  }

  async function login(req, res) {
    if (!sameOrigin(req, config.publicUrl)) return text(res, 403, "Origen no permitido");
    const form = new URLSearchParams(await readBody(req, 8 * 1024));
    const email = String(form.get("email") ?? "").trim().toLowerCase();
    const key = `${req.socket.remoteAddress}|${email}`;
    if (loginLimiter.blocked(key)) return send(res, 429, operadorLoginPage({ error: "Demasiados intentos. Espera unos minutos." }));
    const op = store.operators.byEmail(email);
    const ok = op ? await verifyPassword(String(form.get("password") ?? ""), op.passwordHash) : (await fakeVerify(String(form.get("password") ?? "")), false);
    if (!ok) {
      loginLimiter.fail(key);
      return send(res, 401, operadorLoginPage({ error: "Correo o contraseña incorrectos." }));
    }
    loginLimiter.clear(key);
    const stage = op.totpEnabled ? "pending" : "setup";
    const ttlMs = stage === "pending" ? PENDING_TTL_MS : SETUP_TTL_MS;
    return redirect(res, "/operador/2fa", setCookie(store.operatorSessions.create(op.id, { stage, ttlMs }), Math.floor(ttlMs / 1000)));
  }

  async function twoFaSubmit(req, res) {
    if (!sameOrigin(req, config.publicUrl)) return text(res, 403, "Origen no permitido");
    const s = sessionOf(req);
    if (!s) return redirect(res, "/operador/entrar");
    if (s.stage === "full") return redirect(res, "/operador");
    const form = new URLSearchParams(await readBody(req, 4 * 1024));
    if (codeLimiter.blocked(s.operator.id)) return send(res, 429, twoFaPage({ stage: s.stage, error: "Demasiados intentos. Vuelve a entrar en unos minutos.", action: "/operador/2fa" }));
    const op = store.operators.byId(s.operator.id);
    if (!op.totpSecret) return redirect(res, "/operador/2fa");
    const step = matchTotp(decryptSecret(op.totpSecret, config.masterKey), form.get("code"));
    if (step === null || !store.operators.claimTotpStep(op.id, step)) {
      codeLimiter.fail(op.id);
      return twoFaForm(req, res, "Código incorrecto. Revisa que la hora de tu celular esté en automático.");
    }
    codeLimiter.clear(op.id);
    if (s.stage === "setup") store.operators.enableTotp(op.id);
    return redirect(res, "/operador", setCookie(store.operatorSessions.promote(s.token, FULL_TTL_S * 1000), FULL_TTL_S));
  }

  /** What the operator may know about a conjunto: counts and status. Reached only through each conjunto's own methods. */
  function overview() {
    const tenants = store.tenants.list().map((t) => {
      const ledger = store.forTenant(t.id);
      return {
        id: t.id, name: t.name, slug: t.slug, createdAt: t.createdAt ?? null,
        houses: ledger.houses.list().length, team: ledger.team.list().length, invites: ledger.team.invitations().length,
        pagoradarConfigured: t.pagoradarConfigured, pagoradarLastAt: t.pagoradarLastAt,
        lastLogin: ledger.audit.list({ action: "sesion", limit: 1 }).rows[0]?.at ?? null,
      };
    });
    return { tenants, totals: { tenants: tenants.length, houses: tenants.reduce((n, t) => n + t.houses, 0) } };
  }

  /** What the panel shows about the off-server copies: destinations by name (never keys), and the last run. */
  function backupsView(tested = null) {
    return { destinations: (config.backups ?? []).map((b) => b.name), warnings: config.backupWarnings ?? [], last: lastOffsite(store), lastOk: store.settings.get("offsite_last_ok"), tested };
  }

  const invitationUrl = (token) => `${config.publicUrl}/invitacion/${token}`;

  /** @returns {Promise<boolean>} true when the request was for /operador and has been answered. */
  return async function handle(req, res, url, path, method) {
    if (!(path === "/operador" || path.startsWith("/operador/"))) return false;
    if (store.operators.count() === 0) { await Promise.resolve(); send(res, 404, "No encontrado"); return true; }

    if (path === "/operador/entrar") {
      if (method === "GET") { send(res, 200, operadorLoginPage()); return true; }
      if (method === "POST") { await login(req, res); return true; }
    }
    if (path === "/operador/2fa") {
      if (method === "GET") { twoFaForm(req, res); return true; }
      if (method === "POST") { await twoFaSubmit(req, res); return true; }
    }

    const s = sessionOf(req);
    if (!s) { redirect(res, "/operador/entrar"); return true; }
    if (s.stage !== "full") { redirect(res, "/operador/2fa"); return true; }
    const csrf = csrfToken(s.token);
    const operator = s.operator;
    const flashOf = () => OPERADOR_FLASHES[url.searchParams.get("m")] ?? null;

    if (method === "GET" && path === "/operador") {
      send(res, 200, operadorPage({ csrf, operator, flash: flashOf(), ...overview(), backups: backupsView() }));
      return true;
    }
    if (method === "GET" && path === "/operador/cuenta") {
      send(res, 200, operadorCuentaPage({ csrf, operator, flash: flashOf() }));
      return true;
    }
    if (method !== "POST") { send(res, 404, "No encontrado"); return true; }

    if (!sameOrigin(req, config.publicUrl)) { text(res, 403, "Origen no permitido"); return true; }
    const form = new URLSearchParams(await readBody(req, 8 * 1024));
    if (!csrfValid(s.token, form.get("_csrf"))) { text(res, 403, "Formulario vencido. Recarga la página e inténtalo de nuevo."); return true; }

    if (path === "/operador/salir") {
      store.operatorSessions.delete(s.token);
      redirect(res, "/operador/entrar", clearCookie());
      return true;
    }

    if (path === "/operador/cuenta/clave") {
      const key = `clave|${operator.id}`;
      const op = store.operators.byId(operator.id);
      const nueva = String(form.get("nueva") ?? "");
      if (loginLimiter.blocked(key) || !(await verifyPassword(String(form.get("actual") ?? ""), op.passwordHash))) {
        loginLimiter.fail(key);
        redirect(res, "/operador/cuenta?m=claveerr");
        return true;
      }
      if (nueva.length < 10 || nueva.length > 200 || nueva !== String(form.get("nueva2") ?? "")) { redirect(res, "/operador/cuenta?m=claveerr"); return true; }
      store.operators.setPasswordHash(op.id, await hashPassword(nueva));
      store.operatorSessions.deleteForOperator(op.id, s.token);
      loginLimiter.clear(key);
      redirect(res, "/operador/cuenta?m=clave");
      return true;
    }

    if (path === "/operador/respaldo") {
      if ((config.backups ?? []).length === 0) { redirect(res, "/operador?m=respaldoerr"); return true; }
      const r = await runOffsiteBackup({ store, config });
      redirect(res, `/operador?m=${r.results.every((x) => x.ok) ? "respaldo" : "respaldoerr"}`);
      return true;
    }

    if (path === "/operador/respaldo/probar") {
      const tested = await testDestinations({ config });
      send(res, 200, operadorPage({ csrf, operator, flash: null, ...overview(), backups: backupsView(tested) }));
      return true;
    }

    if (path === "/operador/conjuntos") {
      const field = (k, max) => String(form.get(k) ?? "").trim().slice(0, max);
      const values = { nombre: field("nombre", 80), cuota: field("cuota", 12), llave: field("llave", 80), titular: field("titular", 80), tesorero: field("tesorero", 80), correo: field("correo", 120).toLowerCase() };
      const amount = parsePesos(values.cuota);
      const again = (error) => send(res, 400, operadorPage({ csrf, operator, error, values, ...overview(), backups: backupsView() }));
      if (values.nombre.length < 3) { again("Escribe el nombre del conjunto (mínimo 3 letras)."); return true; }
      if (amount === null || amount < 100_000 || amount > 1_000_000_000) { again("La cuota debe ser un valor en pesos entre 1.000 y 10.000.000."); return true; }
      if (values.tesorero.length < 2) { again("Escribe el nombre del tesorero."); return true; }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.correo)) { again("Escribe un correo válido para el tesorero."); return true; }
      if (store.users.byEmail(values.correo)) { again("Ese correo ya tiene una cuenta en Cuotia. Usa otro."); return true; }
      const tenant = store.tenants.create({ slug: uniqueSlug(values.nombre), name: values.nombre, payKey: values.llave || null, payHolder: values.titular || null });
      const ledger = store.forTenant(tenant.id);
      ledger.concepts.create({ name: "Vigilancia", amountCents: amount });
      ledger.audit.record({ userName: "Equipo de Cuotia", action: "ajustes", summary: "Se creó el conjunto" });
      const { token, email } = ledger.team.invite({ email: values.correo, name: values.tesorero });
      send(res, 200, operadorLinkPage({ csrf, operator, tenantName: tenant.name, email, url: invitationUrl(token) }));
      return true;
    }

    const invite = path.match(/^\/operador\/conjuntos\/(ten_[a-f0-9]+)\/invitar$/);
    if (invite) {
      const tenant = store.tenants.get(invite[1]);
      if (!tenant) { redirect(res, "/operador?m=err"); return true; }
      try {
        const { token, email } = store.forTenant(tenant.id).team.invite({ email: form.get("correo"), name: form.get("nombre") });
        store.forTenant(tenant.id).audit.record({ userName: "Equipo de Cuotia", action: "equipo", summary: `Invitó a ${email} al equipo` });
        send(res, 200, operadorLinkPage({ csrf, operator, tenantName: tenant.name, email, url: invitationUrl(token) }));
      } catch {
        redirect(res, "/operador?m=err");
      }
      return true;
    }

    send(res, 404, "No encontrado");
    return true;
  };
}
