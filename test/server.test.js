import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createApp } from "../src/app.js";
import { encryptSecret, hashPassword, signPagoradarBody, totpCode, totpStep } from "../src/security.js";
import { currentPeriod } from "../src/text.js";
import { paymentEvent, SECRET_A, SECRET_B, twoConjuntos } from "./fixtures.js";

const MASTER_KEY = "a".repeat(64);
const FORM = { "Content-Type": "application/x-www-form-urlencoded" };

/** Runs `fn` against a real server and always closes it, so a failed assertion can't leave the test run hanging. */
async function withServer(fn) {
  const ctx = twoConjuntos();
  const config = { publicUrl: "http://localhost:3000", secureCookies: false, masterKey: MASTER_KEY };
  await ctx.store.users.create({ tenantId: ctx.a.id, email: "marta@ejemplo.com", passwordHash: await hashPassword("clave-de-marta") });
  await ctx.store.users.create({ tenantId: ctx.b.id, email: "luis@ejemplo.com", passwordHash: await hashPassword("clave-de-luis") });
  // Each conjunto has its own pagoradar secret, stored encrypted.
  ctx.store.tenants.setPagoradarSecret(ctx.a.id, encryptSecret(SECRET_A, MASTER_KEY));
  ctx.store.tenants.setPagoradarSecret(ctx.b.id, encryptSecret(SECRET_B, MASTER_KEY));
  const server = createServer(createApp({ config, store: ctx.store }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ ...ctx, base });
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

const hookUrl = (s, tenant) => `${s.base}/webhooks/pagoradar/${tenant.id}`;
const post = (url, body, headers = {}) => fetch(url, { method: "POST", body, redirect: "manual", headers });
const form = (url, fields, cookie, extra = {}) =>
  post(url, new URLSearchParams(fields), { ...FORM, ...(cookie ? { cookie } : {}), ...extra });
const cookieOf = (res) => res.headers.get("set-cookie")?.split(";")[0];

/** Password step only: returns the short "setup"/"pending" cookie. */
async function passwordStep(base, email, password) {
  const res = await form(`${base}/login`, { email, password });
  return { res, cookie: cookieOf(res) };
}

/** Full sign-in. First time it enrolls the TOTP (reading the key off the setup page); later it uses `step`. */
async function signIn(base, email, password, { step = totpStep() } = {}) {
  const { cookie: partial } = await passwordStep(base, email, password);
  const page = await (await fetch(`${base}/2fa`, { headers: { cookie: partial } })).text();
  const key = page.match(/class="key secret" translate="no">([A-Z2-7 ]+)</)?.[1].replace(/ /g, "");
  const res = await form(`${base}/2fa`, { code: totpCode(key, step) }, partial);
  return { res, cookie: cookieOf(res), secret: key };
}

const csrfOf = async (base, cookie, path = "/panel") => (await (await fetch(`${base}${path}`, { headers: { cookie } })).text()).match(/name="_csrf" value="([^"]+)"/)?.[1];

test("/health responde y las respuestas llevan cabeceras de seguridad", () => withServer(async (s) => {
  const res = await fetch(`${s.base}/health`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-security-policy"), /default-src 'self'/);
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  // "no-referrer" would make browsers post forms with `Origin: null`, which the same-origin check refuses.
  assert.equal(res.headers.get("referrer-policy"), "same-origin");
}));

test("webhook: firma inválida 400; firma válida registra el pago; el reintento no duplica", () => withServer(async (s) => {
  s.A.dues.generate(currentPeriod());
  const body = JSON.stringify(paymentEvent({ tenantRef: s.a.id, payerName: "Sandra Duque Arias" }));
  const url = hookUrl(s, s.a);

  assert.equal((await post(url, body, { "Pagoradar-Signature": "t=1,v1=00" })).status, 400);
  assert.equal((await post(url, body)).status, 400, "sin firma");
  assert.equal(s.A.summary(currentPeriod()).paidCount, 0);

  const sig = { "Pagoradar-Signature": signPagoradarBody(body, SECRET_A) };
  const ok = await post(url, body, sig);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).status, "assigned");
  assert.equal(s.A.summary(currentPeriod()).paidCount, 1);
  assert.equal((await (await post(url, body, sig)).json()).status, "duplicate");
}));

test("cada conjunto verifica con su propio secreto: el de uno no sirve en la URL del otro", () => withServer(async (s) => {
  s.A.dues.generate(currentPeriod());
  s.B.dues.generate(currentPeriod());
  const body = JSON.stringify(paymentEvent({ payerName: "Sandra Duque Arias" }));

  // Signed with B's secret but sent to A's URL: refused, nothing booked.
  assert.equal((await post(hookUrl(s, s.a), body, { "Pagoradar-Signature": signPagoradarBody(body, SECRET_B) })).status, 400);
  assert.equal(s.A.summary(currentPeriod()).paidCount, 0);

  // Each URL accepts only its own secret.
  assert.equal((await post(hookUrl(s, s.a), body, { "Pagoradar-Signature": signPagoradarBody(body, SECRET_A) })).status, 200);
  const bodyB = JSON.stringify(paymentEvent({ id: "pay_b", payerName: "Carlos Mejía" }));
  assert.equal((await post(hookUrl(s, s.b), bodyB, { "Pagoradar-Signature": signPagoradarBody(bodyB, SECRET_B) })).status, 200);
  assert.equal(s.A.summary(currentPeriod()).paidCount, 1);
  assert.equal(s.B.summary(currentPeriod()).paidCount, 1);

  // A pagoradar account of A that carries B's tenantRef can't push money into B.
  const cross = JSON.stringify(paymentEvent({ id: "pay_x", tenantRef: s.b.id, payerName: "Carlos Mejía" }));
  const r = await post(hookUrl(s, s.a), cross, { "Pagoradar-Signature": signPagoradarBody(cross, SECRET_A) });
  assert.equal((await r.json()).reason, "tenant_mismatch");
}));

test("webhook: conjunto desconocido 404; sin secreto configurado 503; el secreto se guarda cifrado", () => withServer(async (s) => {
  const body = "{}";
  assert.equal((await post(`${s.base}/webhooks/pagoradar/ten_0000000000000000`, body)).status, 404);
  assert.equal((await post(`${s.base}/webhooks/pagoradar`, body)).status, 404, "ya no existe la URL global");

  const fresh = s.store.tenants.create({ slug: "nuevo", name: "Conjunto Nuevo" });
  assert.equal(fresh.pagoradarConfigured, false);
  assert.equal((await post(hookUrl(s, fresh), body, { "Pagoradar-Signature": signPagoradarBody(body, "lo-que-sea") })).status, 503);

  const stored = s.store.tenants.pagoradarSecret(s.a.id);
  assert.ok(stored && !stored.includes(SECRET_A), "en la base no está en claro");
  assert.equal(s.store.tenants.get(s.a.id).pagoradarConfigured, true);
  assert.equal(JSON.stringify(s.store.tenants.get(s.a.id)).includes(stored), false, "el DTO no lleva el secreto");
}));

test("un aviso firmado, aunque sea de prueba, marca la conexión como viva", () => withServer(async (s) => {
  assert.equal(s.store.tenants.get(s.a.id).pagoradarLastAt, null);
  const body = JSON.stringify({ type: "payment.test", data: {} });
  assert.equal((await post(hookUrl(s, s.a), body, { "Pagoradar-Signature": "t=1,v1=00" })).status, 400);
  assert.equal(s.store.tenants.get(s.a.id).pagoradarLastAt, null, "uno sin firma válida no cuenta");
  assert.equal((await post(hookUrl(s, s.a), body, { "Pagoradar-Signature": signPagoradarBody(body, SECRET_A) })).status, 200);
  assert.ok(s.store.tenants.get(s.a.id).pagoradarLastAt);
  assert.equal(s.store.tenants.get(s.b.id).pagoradarLastAt, null, "el otro conjunto no cambia");
}));

test("Ajustes: el tesorero guarda el secreto de su conjunto sin tocar el de otro", () => withServer(async (s) => {
  const { cookie } = await signIn(s.base, "marta@ejemplo.com", "clave-de-marta");
  const page = await (await fetch(`${s.base}/panel/ajustes`, { headers: { cookie } })).text();
  assert.ok(page.includes(`${"http://localhost:3000"}/webhooks/pagoradar/${s.a.id}`), "muestra la URL propia del conjunto");
  assert.doesNotMatch(page, new RegExp(s.b.id), "no muestra la del otro");
  assert.doesNotMatch(page, new RegExp(SECRET_A), "nunca muestra el secreto guardado");
  const csrf = page.match(/name="_csrf" value="([^"]+)"/)[1];

  const before = s.store.tenants.pagoradarSecret(s.b.id);
  assert.equal((await form(`${s.base}/panel/ajustes/pagoradar`, { secret: "nuevo-secreto-123" }, cookie)).status, 403, "sin token");
  assert.match((await form(`${s.base}/panel/ajustes/pagoradar`, { _csrf: csrf, secret: "corto" }, cookie)).headers.get("location"), /m=secbad/);
  assert.match((await form(`${s.base}/panel/ajustes/pagoradar`, { _csrf: csrf, secret: "con espacios aqui" }, cookie)).headers.get("location"), /m=secbad/);

  assert.match((await form(`${s.base}/panel/ajustes/pagoradar`, { _csrf: csrf, secret: "nuevo-secreto-123" }, cookie)).headers.get("location"), /m=sec$/);
  assert.equal(s.store.tenants.pagoradarSecret(s.b.id), before, "el secreto del otro conjunto no cambió");

  // The new secret works on A's URL, the old one no longer does.
  const body = JSON.stringify(paymentEvent({ payerName: "X" }));
  assert.equal((await post(hookUrl(s, s.a), body, { "Pagoradar-Signature": signPagoradarBody(body, SECRET_A) })).status, 400);
  assert.equal((await post(hookUrl(s, s.a), body, { "Pagoradar-Signature": signPagoradarBody(body, "nuevo-secreto-123") })).status, 200);
}));

test("la contraseña sola no abre el panel; hace falta el código", () => withServer(async (s) => {
  const bad = await passwordStep(s.base, "marta@ejemplo.com", "mala");
  assert.equal(bad.res.status, 401);

  const { res, cookie } = await passwordStep(s.base, "marta@ejemplo.com", "clave-de-marta");
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/2fa");
  assert.match(res.headers.get("set-cookie"), /HttpOnly/);
  assert.match(res.headers.get("set-cookie"), /SameSite=Strict/);

  const panel = await fetch(`${s.base}/panel`, { headers: { cookie }, redirect: "manual" });
  assert.equal(panel.status, 303);
  assert.equal(panel.headers.get("location"), "/2fa", "con la contraseña sola solo se ve la página del código");

  const early = await form(`${s.base}/2fa`, { code: "000000" }, cookie);
  assert.equal(early.headers.get("location"), "/2fa", "enviar un código antes de ver la clave no hace nada");
  await fetch(`${s.base}/2fa`, { headers: { cookie } });
  const wrong = await form(`${s.base}/2fa`, { code: "000000" }, cookie);
  assert.equal(wrong.status, 401);
  assert.equal((await fetch(`${s.base}/panel`, { headers: { cookie }, redirect: "manual" })).status, 303, "un código malo no abre nada");
}));

test("doble factor: se activa, se pide en los siguientes ingresos y un código no se puede reutilizar", () => withServer(async (s) => {
  const step = totpStep();
  const first = await signIn(s.base, "marta@ejemplo.com", "clave-de-marta", { step });
  assert.equal(first.res.status, 303);
  assert.equal(first.res.headers.get("location"), "/panel");
  assert.equal(s.store.users.byEmail("marta@ejemplo.com").totpEnabled, true);
  assert.ok(!s.store.users.byEmail("marta@ejemplo.com").totpSecret.includes(first.secret), "el secreto se guarda cifrado");
  assert.equal((await fetch(`${s.base}/panel`, { headers: { cookie: first.cookie } })).status, 200);

  // Second sign-in: now the page asks for the code (no key shown), and the used step is refused.
  const { cookie: partial } = await passwordStep(s.base, "marta@ejemplo.com", "clave-de-marta");
  const page = await (await fetch(`${s.base}/2fa`, { headers: { cookie: partial } })).text();
  assert.doesNotMatch(page, /class="key secret"/);
  const replay = await form(`${s.base}/2fa`, { code: totpCode(first.secret, step) }, partial);
  assert.equal(replay.status, 401, "el mismo código no sirve dos veces");
  const next = await form(`${s.base}/2fa`, { code: totpCode(first.secret, step + 1) }, partial);
  assert.equal(next.headers.get("location"), "/panel");
  assert.notEqual(cookieOf(next), partial, "la cookie cambia al subir de nivel");
  assert.equal((await fetch(`${s.base}/panel`, { headers: { cookie: partial }, redirect: "manual" })).status, 303, "la sesión previa ya no sirve");
}));

test("el panel solo muestra el conjunto del tesorero", () => withServer(async (s) => {
  const period = currentPeriod();
  s.A.dues.generate(period);
  s.B.dues.generate(period);
  assert.equal((await fetch(`${s.base}/panel`, { redirect: "manual" })).headers.get("location"), "/login");

  const a = await signIn(s.base, "marta@ejemplo.com", "clave-de-marta");
  const page = await (await fetch(`${s.base}/panel`, { headers: { cookie: a.cookie } })).text();
  assert.match(page, /Jardines de Ibiza/);
  assert.match(page, /Sandra Duque Arias/);
  assert.doesNotMatch(page, /Carlos Mejía|Los Robles/);

  const b = await signIn(s.base, "luis@ejemplo.com", "clave-de-luis");
  const other = await (await fetch(`${s.base}/panel`, { headers: { cookie: b.cookie } })).text();
  assert.match(other, /Los Robles/);
  assert.doesNotMatch(other, /Sandra Duque Arias/);

  await form(`${s.base}/logout`, { _csrf: "x" }, a.cookie);
  assert.equal((await fetch(`${s.base}/panel`, { headers: { cookie: a.cookie }, redirect: "manual" })).status, 303, "la sesión cerrada ya no sirve");
}));

test("las acciones exigen el token del formulario y el mismo origen", () => withServer(async (s) => {
  const { cookie } = await signIn(s.base, "marta@ejemplo.com", "clave-de-marta");
  const csrf = await csrfOf(s.base, cookie);
  assert.ok(csrf);

  assert.equal((await form(`${s.base}/panel/cuotas/generar`, {}, cookie)).status, 403, "sin token");
  assert.equal((await form(`${s.base}/panel/cuotas/generar`, { _csrf: "falso" }, cookie)).status, 403, "token falso");
  assert.equal((await form(`${s.base}/panel/cuotas/generar`, { _csrf: csrf }, cookie, { Origin: "https://malo.example" })).status, 403, "otro sitio");
  assert.equal(s.A.summary(currentPeriod()).expectedCents, 0, "nada se creó");

  const ok = await form(`${s.base}/panel/cuotas/generar`, { _csrf: csrf }, cookie);
  assert.match(ok.headers.get("location"), /m=gen&n=2/);
  assert.equal(s.A.summary(currentPeriod()).expectedCents, 6_000_000);

  // A token from another session is worthless.
  const b = await signIn(s.base, "luis@ejemplo.com", "clave-de-luis");
  const csrfB = await csrfOf(s.base, b.cookie);
  assert.equal((await form(`${s.base}/panel/cuotas/generar`, { _csrf: csrfB }, cookie)).status, 403);
}));

test("asignar un pago a mano salda la cuota y enseña el nombre", () => withServer(async (s) => {
  const period = currentPeriod();
  s.A.dues.generate(period);
  const { cookie } = await signIn(s.base, "marta@ejemplo.com", "clave-de-marta");
  const hook = (id, name) => {
    const body = JSON.stringify(paymentEvent({ id, tenantRef: s.a.id, payerName: name }));
    return post(hookUrl(s, s.a), body, { "Pagoradar-Signature": signPagoradarBody(body, SECRET_A) });
  };
  assert.equal((await (await hook("pay_a", "Pedro Duque")).json()).status, "unassigned");

  const page = await (await fetch(`${s.base}/panel`, { headers: { cookie } })).text();
  assert.match(page, /Por asignar/);
  assert.match(page, /Pedro Duque/);
  const csrf = page.match(/name="_csrf" value="([^"]+)"/)[1];
  const pid = page.match(/\/panel\/pagos\/(pg_[a-f0-9]+)\/asignar/)[1];

  // A house of another conjunto can't be chosen.
  const foreign = await form(`${s.base}/panel/pagos/${pid}/asignar`, { _csrf: csrf, house: s.b01.house.id, remember: "1" }, cookie);
  assert.match(foreign.headers.get("location"), /m=err/);
  assert.equal(s.A.payments.listUnassigned().length, 1);

  const ok = await form(`${s.base}/panel/pagos/${pid}/asignar`, { _csrf: csrf, house: s.a14.house.id, remember: "1" }, cookie);
  assert.match(ok.headers.get("location"), /m=asig/);
  assert.equal(s.A.payments.listUnassigned().length, 0);
  assert.equal(s.A.summary(period).paidCount, 1);
  assert.equal((await (await hook("pay_c", "PEDRO DUQUE")).json()).status, "unassigned", "sin cuota abierta no se concilia solo");
  s.A.dues.generate("2030-01"); // the next month's due
  assert.equal((await (await hook("pay_b", "PEDRO DUQUE")).json()).status, "assigned", "con cuota abierta, el nombre aprendido concilia solo");
}));

test("pago en efectivo, casas nuevas y enlace personal", () => withServer(async (s) => {
  const period = currentPeriod();
  s.A.dues.generate(period);
  const { cookie } = await signIn(s.base, "marta@ejemplo.com", "clave-de-marta");
  const csrf = await csrfOf(s.base, cookie);

  assert.match((await form(`${s.base}/panel/efectivo`, { _csrf: csrf, house: s.a03.house.id }, cookie)).headers.get("location"), /m=efec/);
  assert.equal(s.A.summary(period).paidCount, 1);
  assert.match((await form(`${s.base}/panel/efectivo`, { _csrf: csrf, house: s.a03.house.id }, cookie)).headers.get("location"), /m=err/, "ya no debe nada");
  assert.match((await form(`${s.base}/panel/efectivo`, { _csrf: csrf, house: s.b01.house.id }, cookie)).headers.get("location"), /m=err/, "casa de otro conjunto");

  const created = await form(`${s.base}/panel/casas`, { _csrf: csrf, code: "20", residente: "Lucía Gómez", telefono: "300 123 4567" }, cookie);
  assert.equal(created.status, 200);
  const html = await created.text();
  const link = html.match(/http:\/\/localhost:3000(\/r\/[A-Za-z0-9_-]+)/)[1];
  assert.match(html, /wa\.me\/573001234567/);
  assert.equal((await fetch(`${s.base}${link}`)).status, 200, "el enlace nuevo abre la cuota");

  const dup = await form(`${s.base}/panel/casas`, { _csrf: csrf, code: "20", residente: "Otra" }, cookie);
  assert.match(dup.headers.get("location"), /m=dup/);

  const house = s.A.houses.list().find((h) => h.code === "20");
  const rotated = await (await form(`${s.base}/panel/casas/${house.id}/enlace`, { _csrf: csrf }, cookie)).text();
  const link2 = rotated.match(/http:\/\/localhost:3000(\/r\/[A-Za-z0-9_-]+)/)[1];
  assert.notEqual(link2, link);
  assert.equal((await fetch(`${s.base}${link}`)).status, 404, "el enlace anterior dejó de servir");
  assert.equal((await fetch(`${s.base}${link2}`)).status, 200);

  const otherHouse = await form(`${s.base}/panel/casas/${s.b01.house.id}/enlace`, { _csrf: csrf }, cookie);
  assert.match(otherHouse.headers.get("location"), /m=err/, "no se puede rotar el enlace de otro conjunto");
  assert.equal((await fetch(`${s.base}/r/${s.b01.accessToken}`)).status, 200, "y el enlace del otro conjunto sigue igual");
}));

test("el mensaje de aviso solo muestra textos fijos, nunca el de la URL", () => withServer(async (s) => {
  const { cookie } = await signIn(s.base, "marta@ejemplo.com", "clave-de-marta");
  const page = await (await fetch(`${s.base}/panel?m=<script>alert(1)</script>&n=9`, { headers: { cookie } })).text();
  assert.doesNotMatch(page, /<script>alert/);
  assert.doesNotMatch(page, /class="flash/);
}));

test("login rechaza formularios de otro sitio", () => withServer(async (s) => {
  const res = await form(`${s.base}/login`, { email: "marta@ejemplo.com", password: "clave-de-marta" }, null, { Origin: "https://malo.example" });
  assert.equal(res.status, 403);
}));

test("el residente ve su cuota con su enlace personal y nada más", () => withServer(async (s) => {
  s.A.dues.generate(currentPeriod());
  const page = await (await fetch(`${s.base}/r/${s.a14.accessToken}`)).text();
  assert.match(page, /Casa 14/);
  assert.match(page, /\$30\.000/);
  assert.match(page, /@ibiza/, "muestra la llave Bre-B del conjunto");
  assert.doesNotMatch(page, /Diana/, "no ve a otras casas");
  assert.equal((await fetch(`${s.base}/r/${"x".repeat(32)}`)).status, 404);
}));

test("el CSS se sirve y no hay rutas fuera de la lista", () => withServer(async (s) => {
  const css = await fetch(`${s.base}/static/app.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type"), /text\/css/);
  assert.equal((await fetch(`${s.base}/static/../src/store.js`)).status, 404);
}));
