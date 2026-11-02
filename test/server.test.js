import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createApp } from "../src/app.js";
import { encryptSecret, hashPassword, signPagoradarBody, totpCode, totpStep } from "../src/security.js";
import { bogotaDateTime, currentPeriod, shiftPeriod } from "../src/text.js";
import { openStore } from "../src/store.js";
import { qrSvg } from "../src/qr.js";
import { paymentEvent, SECRET_A, SECRET_B, twoConjuntos } from "./fixtures.js";

const MASTER_KEY = "a".repeat(64);
const SETUP_TOKEN = "token-de-configuracion-inicial-123";
const FORM = { "Content-Type": "application/x-www-form-urlencoded" };

/** Runs `fn` against a real server and always closes it, so a failed assertion can't leave the test run hanging. */
async function withServer(fn, { empty = false, secure = false } = {}) {
  const ctx = empty ? { store: openStore(":memory:") } : twoConjuntos();
  const config = { publicUrl: "http://localhost:3000", secureCookies: secure, masterKey: MASTER_KEY, setupToken: SETUP_TOKEN };
  if (!empty) {
    await ctx.store.users.create({ tenantId: ctx.a.id, email: "marta@ejemplo.com", passwordHash: await hashPassword("clave-de-marta") });
    await ctx.store.users.create({ tenantId: ctx.b.id, email: "luis@ejemplo.com", passwordHash: await hashPassword("clave-de-luis") });
    // Each conjunto has its own pagoradar secret, stored encrypted.
    ctx.store.tenants.setPagoradarSecret(ctx.a.id, encryptSecret(SECRET_A, MASTER_KEY));
    ctx.store.tenants.setPagoradarSecret(ctx.b.id, encryptSecret(SECRET_B, MASTER_KEY));
  }
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

test("pago manual, casas nuevas y enlace personal", () => withServer(async (s) => {
  const period = currentPeriod();
  s.A.dues.generate(period);
  const { cookie } = await signIn(s.base, "marta@ejemplo.com", "clave-de-marta");
  const csrf = await csrfOf(s.base, cookie);

  const today = bogotaDateTime(new Date().toISOString()).slice(0, 10);
  const due03 = s.A.dues.listForHouse(s.a03.house.id)[0].id;
  const pay = (casa, cuota) => form(`${s.base}/panel/pagos/nuevo`, { _csrf: csrf, casa, cuota, medio: "cash", fecha: today }, cookie);
  assert.match((await pay(s.a03.house.id, due03)).headers.get("location"), /m=manual/);
  assert.equal(s.A.summary(period).paidCount, 1);
  assert.match((await pay(s.a03.house.id, due03)).headers.get("location"), /m=err/, "ya no debe nada");
  assert.match((await pay(s.b01.house.id, s.B.dues.listForHouse(s.b01.house.id)[0]?.id ?? "x")).headers.get("location"), /m=err/, "casa de otro conjunto");

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
  assert.match(page, /Hola, Sandra/);
  assert.match(page, /Casa 14/);
  assert.match(page, /\$30\.000/);
  assert.ok(page.includes(`/r/${s.a14.accessToken}/pagar`), "botón para pagar");
  assert.doesNotMatch(page, /Diana/, "no ve a otras casas");
  assert.equal((await fetch(`${s.base}/r/${"x".repeat(32)}`)).status, 404);
}));

test("pantalla de pagar: llave para copiar, monto exacto y se actualiza sola", () => withServer(async (s) => {
  s.A.dues.generate(currentPeriod());
  const res = await fetch(`${s.base}/r/${s.a14.accessToken}/pagar`);
  assert.equal(res.status, 200);
  const page = await res.text();
  assert.match(page, /@ibiza/, "muestra la llave Bre-B del conjunto");
  assert.match(page, /Titular: <b>Marta Rojas<\/b>/);
  assert.match(page, /\$30\.000/);
  assert.match(page, /data-copy="@ibiza"/, "botón de copiar");
  assert.match(page, /<meta http-equiv="refresh" content="20">/);
  assert.doesNotMatch(page, /Diana|Carlos/);

  // Once nothing is left to pay, the page sends the resident home.
  s.A.payments.recordCash(s.a14.house.id);
  const done = await fetch(`${s.base}/r/${s.a14.accessToken}/pagar`, { redirect: "manual" });
  assert.equal(done.status, 303);
  assert.equal(done.headers.get("location"), `/r/${s.a14.accessToken}`);
  assert.match(await (await fetch(`${s.base}/r/${s.a14.accessToken}`)).text(), /Al día/);
  assert.equal((await fetch(`${s.base}/r/${"x".repeat(32)}/pagar`)).status, 404);
}));

test("recibo: solo de una cuota pagada y de la propia casa", () => withServer(async (s) => {
  s.A.dues.generate(currentPeriod());
  s.B.dues.generate(currentPeriod());
  const mine = s.A.dues.listForHouse(s.a14.house.id)[0];
  const other = s.A.dues.listForHouse(s.a03.house.id)[0];
  const foreign = s.B.dues.listForHouse(s.b01.house.id)[0];
  const url = (token, id) => `${s.base}/r/${token}/recibo/${id}`;

  assert.equal((await fetch(url(s.a14.accessToken, mine.id))).status, 404, "una cuota sin pagar no tiene recibo");
  s.A.payments.recordCash(s.a14.house.id);
  s.A.payments.recordCash(s.a03.house.id);
  s.B.payments.recordCash(s.b01.house.id);

  const res = await fetch(url(s.a14.accessToken, mine.id));
  assert.equal(res.status, 200);
  const page = await res.text();
  assert.match(page, /¡Pago confirmado!/);
  assert.match(page, /Gracias, Sandra/);
  assert.match(page, /Casa 14 · Sandra Duque Arias/);
  assert.match(page, /Efectivo/);
  assert.match(page, /N\.º \d{4}-\d{2}-[0-9A-F]{4}/);
  assert.match(page, /data-print/);
  assert.doesNotMatch(page, /<script(?![^>]*src=)/i, "sin scripts en línea");

  assert.equal((await fetch(url(s.a14.accessToken, other.id))).status, 404, "ni el recibo de otra casa del mismo conjunto");
  assert.equal((await fetch(url(s.a14.accessToken, foreign.id))).status, 404, "ni el de otro conjunto");
  assert.equal((await fetch(url("x".repeat(32), mine.id))).status, 404);
  assert.match(await (await fetch(`${s.base}/r/${s.a14.accessToken}`)).text(), new RegExp(`/recibo/${mine.id}`), "el inicio enlaza al recibo");
}));

test("el panel nuevo: saludo con el nombre, menú lateral, barra inferior y tarjetas del resumen", () => withServer(async (s) => {
  s.A.dues.generate(currentPeriod());
  s.A.payments.recordCash(s.a14.house.id);
  s.A.payments.record({ externalId: "p_x", payerName: "Pedro Duque", payerNorm: "PEDRO DUQUE", amountCents: 3_000_000, bank: "nequi", paidAt: new Date().toISOString() });
  const { cookie } = await signIn(s.base, "marta@ejemplo.com", "clave-de-marta");
  const page = await (await fetch(`${s.base}/panel`, { headers: { cookie } })).text();
  assert.match(page, /Hola, Marta/, "nombre sacado del correo cuando no hay uno");
  assert.match(page, /class="side"/);
  assert.match(page, /class="tabbar"/);
  assert.match(page, /Jardines de Ibiza/);
  assert.match(page, /2 casas · Vigilancia \$30\.000/);
  assert.match(page, /class="badge"[^>]*>1</, "un pago por asignar en el menú");
  assert.match(page, /Faltan por pagar/);
  assert.match(page, /Recordar a todos por WhatsApp/);
  assert.match(page, /https:\/\/wa\.me\/\?text=[^"]*Casas%20pendientes%3A%2003/, "el recordatorio ya lleva las casas pendientes");
  assert.match(page, /Últimos pagos/);
  assert.match(page, /Pagó el/);
  assert.doesNotMatch(page, /style="/, "sin estilos en línea");
  assert.doesNotMatch(page, /<script(?![^>]*src=)/i);
  assert.doesNotMatch(page, /fonts\.googleapis/);

  // Filter chips narrow the table without scripts.
  const pendientes = await (await fetch(`${s.base}/panel?f=pendientes`, { headers: { cookie } })).text();
  const rows = (html) => (html.match(/<tbody>[\s\S]*?<\/tbody>/)?.[0].match(/<tr>/g) ?? []).length;
  assert.equal(rows(page), 2);
  assert.equal(rows(pendientes), 1);
  assert.equal(rows(await (await fetch(`${s.base}/panel?f=pagadas`, { headers: { cookie } })).text()), 1);
  assert.equal(rows(await (await fetch(`${s.base}/panel?f=raro`, { headers: { cookie } })).text()), 2, "un filtro desconocido se ignora");
}));

test("la tipografía propia y el script se sirven desde el propio servidor", () => withServer(async (s) => {
  for (const path of ["/static/fonts/plus-jakarta-sans-latin.woff2", "/static/fonts/plus-jakarta-sans-latin-ext.woff2"]) {
    const res = await fetch(`${s.base}${path}`);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get("content-type"), "font/woff2");
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.equal(bytes.subarray(0, 4).toString("latin1"), "wOF2", "el archivo llega intacto, no convertido a texto");
    assert.ok(bytes.length > 10_000);
  }
  const js = await fetch(`${s.base}/static/app.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type"), /javascript/);
  const css = await (await fetch(`${s.base}/static/app.css`)).text();
  assert.match(css, /@font-face[\s\S]*plus-jakarta-sans-latin\.woff2/);
  assert.equal((await fetch(`${s.base}/static/fonts/OFL-plus-jakarta-sans.txt`)).status, 404, "solo los archivos de la lista");
}));

test("el CSS se sirve y no hay rutas fuera de la lista", () => withServer(async (s) => {
  const css = await fetch(`${s.base}/static/app.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type"), /text\/css/);
  assert.equal((await fetch(`${s.base}/static/../src/store.js`)).status, 404);
}));

test("ficha de la casa: editar datos, nombres de pago, desactivar y reactivar", () => withServer(async (s) => {
  const period = currentPeriod();
  s.A.dues.generate(period);
  const { cookie } = await signIn(s.base, "marta@ejemplo.com", "clave-de-marta");
  const own = `/panel/casas/${s.a14.house.id}`;
  const csrf = await csrfOf(s.base, cookie, own);
  assert.ok(csrf);
  const page = await (await fetch(`${s.base}${own}`, { headers: { cookie } })).text();
  assert.match(page, /Sandra Duque Arias/);

  // Edit: needs the token, validates, and refuses a code already used by another house.
  assert.equal((await form(`${s.base}${own}/editar`, { code: "14", residente: "X" }, cookie)).status, 403);
  assert.match((await form(`${s.base}${own}/editar`, { _csrf: csrf, code: "", residente: "X" }, cookie)).headers.get("location"), /m=err/);
  assert.match((await form(`${s.base}${own}/editar`, { _csrf: csrf, code: "03", residente: "Sandra" }, cookie)).headers.get("location"), /m=dup/);
  assert.match((await form(`${s.base}${own}/editar`, { _csrf: csrf, code: "14A", residente: "Sandra Duque Restrepo", telefono: "(300) 111-2233" }, cookie)).headers.get("location"), /m=ed/);
  const edited = s.A.houses.get(s.a14.house.id);
  assert.deepEqual([edited.code, edited.residentName, edited.phone], ["14A", "Sandra Duque Restrepo", "3001112233"]);

  // Aliases.
  assert.match((await form(`${s.base}${own}/alias`, { _csrf: csrf, name: "Pedro Duque" }, cookie)).headers.get("location"), /m=aliasok/);
  assert.equal(s.A.aliases.houseFor("PEDRO DUQUE"), s.a14.house.id);
  const aliasId = s.A.aliases.list(s.a14.house.id)[0].id;
  assert.match((await form(`${s.base}${own}/alias/${aliasId}/quitar`, { _csrf: csrf }, cookie)).headers.get("location"), /m=aliasdel/);
  assert.equal(s.A.aliases.houseFor("PEDRO DUQUE"), null);

  // Deactivate: gone from the month, its link closes; reactivate brings it back.
  assert.match((await form(`${s.base}${own}/desactivar`, { _csrf: csrf }, cookie)).headers.get("location"), /m=desact/);
  assert.equal((await fetch(`${s.base}/r/${s.a14.accessToken}`)).status, 404);
  const panel = await (await fetch(`${s.base}/panel`, { headers: { cookie } })).text();
  assert.doesNotMatch(panel, /Sandra Duque Restrepo/);
  const casas = await (await fetch(`${s.base}/panel/casas`, { headers: { cookie } })).text();
  assert.match(casas, /Casas dadas de baja/);
  assert.equal((await form(`${s.base}${own}/enlace`, { _csrf: csrf }, cookie)).headers.get("location"), "/panel/casas?m=err", "no hay enlace para una casa desactivada");
  assert.match((await form(`${s.base}${own}/reactivar`, { _csrf: csrf }, cookie)).headers.get("location"), /m=react/);
  assert.equal((await fetch(`${s.base}/r/${s.a14.accessToken}`)).status, 200);
}));

test("un tesorero no puede ver ni tocar las casas, nombres o pagos de otro conjunto", () => withServer(async (s) => {
  s.B.dues.generate(currentPeriod());
  s.B.aliases.add(s.b01.house.id, "Nombre Ajeno");
  const bAlias = s.B.aliases.list(s.b01.house.id)[0].id;
  const { payment } = s.B.payments.record({ externalId: "pay_b", payerName: "Carlos Mejía", payerNorm: "CARLOS MEJIA", amountCents: 3_000_000, paidAt: new Date().toISOString() });
  s.B.payments.assign(payment.id, s.b01.house.id);

  const { cookie } = await signIn(s.base, "marta@ejemplo.com", "clave-de-marta");
  const csrf = await csrfOf(s.base, cookie);
  const other = `/panel/casas/${s.b01.house.id}`;

  assert.equal((await fetch(`${s.base}${other}`, { headers: { cookie } })).status, 404, "ni ver la ficha");
  for (const [path, body] of [
    [`${other}/editar`, { code: "99", residente: "Hackeado" }],
    [`${other}/alias`, { name: "Intruso" }],
    [`${other}/alias/${bAlias}/quitar`, {}],
    [`${other}/desactivar`, {}],
    [`/panel/pagos/${payment.id}/deshacer`, {}],
  ]) {
    const res = await form(`${s.base}${path}`, { _csrf: csrf, ...body }, cookie);
    assert.match(res.headers.get("location"), /m=err/, path);
  }
  assert.equal(s.B.houses.get(s.b01.house.id).residentName, "Carlos Mejía");
  assert.equal(s.B.houses.get(s.b01.house.id).active, true);
  assert.deepEqual(s.B.aliases.list(s.b01.house.id).map((a) => a.name).sort(), ["CARLOS MEJIA", "NOMBRE AJENO"]);
  assert.equal(s.B.payments.get(payment.id).status, "assigned");

  const history = await (await fetch(`${s.base}/panel/pagos`, { headers: { cookie } })).text();
  assert.doesNotMatch(history, /Carlos Mejía/, "el historial no muestra pagos del otro conjunto");
  const csv = await (await fetch(`${s.base}/panel/pagos.csv`, { headers: { cookie } })).text();
  assert.doesNotMatch(csv, /Carlos/);
}));

test("historial: filtros, página y deshacer desde el panel", () => withServer(async (s) => {
  const period = currentPeriod();
  s.A.dues.generate(period);
  const { cookie } = await signIn(s.base, "marta@ejemplo.com", "clave-de-marta");
  for (let i = 0; i < 55; i++) {
    s.A.payments.record({ externalId: `pay_${i}`, payerName: `Vecino ${String(i).padStart(2, "0")}`, payerNorm: `VECINO ${String(i).padStart(2, "0")}`, amountCents: 3_000_000, bank: "nequi", paidAt: new Date(Date.now() - i * 60_000).toISOString() });
  }
  const pageOne = await (await fetch(`${s.base}/panel/pagos`, { headers: { cookie } })).text();
  assert.match(pageOne, /<b>55<\/b> pagos/);
  assert.match(pageOne, /Vecino 00/);
  assert.doesNotMatch(pageOne, /Vecino 54/, "la página 1 trae 50");
  assert.match(pageOne, /Página 1 de 2/);
  const pageTwo = await (await fetch(`${s.base}/panel/pagos?p=2`, { headers: { cookie } })).text();
  assert.match(pageTwo, /Vecino 54/);
  assert.match(await (await fetch(`${s.base}/panel/pagos?estado=assigned`, { headers: { cookie } })).text(), /No hay pagos con estos filtros/);
  assert.match(await (await fetch(`${s.base}/panel/pagos?q=vecino%2012&mes=basura&p=-3`, { headers: { cookie } })).text(), /Vecino 12/, "parámetros raros se ignoran");

  // Undo from the panel: assign one, then undo it.
  const csrf = await csrfOf(s.base, cookie, "/panel/pagos");
  const pid = s.A.payments.list({ q: "Vecino 00" }).rows[0].id;
  s.A.payments.assign(pid, s.a14.house.id);
  assert.match(await (await fetch(`${s.base}/panel/pagos?estado=assigned`, { headers: { cookie } })).text(), /Sí, deshacer/);
  assert.equal(s.A.summary(period).paidCount, 1);
  assert.equal((await form(`${s.base}/panel/pagos/${pid}/deshacer`, {}, cookie)).status, 403, "sin token no deshace");
  assert.match((await form(`${s.base}/panel/pagos/${pid}/deshacer`, { _csrf: csrf }, cookie)).headers.get("location"), /m=undo$/);
  assert.equal(s.A.summary(period).paidCount, 0);
  assert.equal(s.A.payments.get(pid).status, "unassigned");
  const cash = s.A.payments.recordCash(s.a03.house.id);
  assert.match((await form(`${s.base}/panel/pagos/${cash.paymentId}/deshacer`, { _csrf: csrf }, cookie)).headers.get("location"), /m=undoc/);
}));

test("CSV: descarga para Excel, con cabeceras correctas y sin fórmulas peligrosas", () => withServer(async (s) => {
  s.A.dues.generate(currentPeriod());
  const { cookie } = await signIn(s.base, "marta@ejemplo.com", "clave-de-marta");
  s.A.payments.record({ externalId: "e1", payerName: '=HYPERLINK("http://malo","clic")', payerNorm: "X", amountCents: 3_000_000, bank: "nequi", paidAt: "2026-11-03T15:22:53.000Z" });
  const { payment } = s.A.payments.record({ externalId: "e2", payerName: "Sandra; Duque", payerNorm: "SANDRA DUQUE", amountCents: 3_000_000, bank: "bancolombia", paidAt: "2026-11-04T15:00:00.000Z" });
  s.A.payments.assign(payment.id, s.a14.house.id);

  const res = await fetch(`${s.base}/panel/pagos.csv?mes=2026-11`, { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv; charset=utf-8/);
  assert.match(res.headers.get("content-disposition"), /attachment; filename="pagos-2026-11\.csv"/);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "empieza con BOM UTF-8 (fetch().text() lo descartaría)");
  const text = bytes.toString("utf8").slice(1);
  assert.ok(text.startsWith('"Fecha";"Pagador"'), "separador ;");
  assert.match(text, /"2026-11-03 10:22"/, "hora de Colombia");
  assert.match(text, /"'=HYPERLINK/, "una fórmula queda como texto");
  assert.doesNotMatch(text, /;"=HYPERLINK/);
  assert.match(text, /"Sandra; Duque";"Bancolombia";"14";"Sandra Duque Arias";"Vigilancia noviembre 2026";"30000";"Asignado"/);
  assert.equal((await fetch(`${s.base}/panel/pagos.csv`, { redirect: "manual" })).status, 303, "exige sesión");
}));

const setupForm = (over = {}) => ({
  token: SETUP_TOKEN, nombre: "Jardines de Ibiza", cuota: "30.000", llave: "@ibiza", titular: "Marta Rojas", tesorero: "Marta Rojas",
  correo: "Marta@Ejemplo.com", clave: "una-clave-bien-larga", clave2: "una-clave-bien-larga", ...over,
});

test("configuración inicial: solo con el enlace privado, y se cierra al crear el primer conjunto", () => withServer(async (s) => {
  assert.equal((await fetch(`${s.base}/setup`)).status, 404, "sin token");
  assert.equal((await fetch(`${s.base}/setup?token=otro`)).status, 404, "token equivocado");
  const open = await fetch(`${s.base}/setup?token=${SETUP_TOKEN}`);
  assert.equal(open.status, 200);
  assert.match(await open.text(), /Crear conjunto/);

  assert.equal((await form(`${s.base}/setup`, setupForm({ token: "otro" }))).status, 404, "tampoco se puede enviar sin el token");
  assert.equal(s.store.tenants.list().length, 0);

  const ok = await form(`${s.base}/setup`, setupForm());
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get("location"), "/login?m=creado");
  const [tenant] = s.store.tenants.list();
  assert.deepEqual([tenant.name, tenant.slug, tenant.payKey, tenant.payHolder], ["Jardines de Ibiza", "jardines-de-ibiza", "@ibiza", "Marta Rojas"]);
  const L = s.store.forTenant(tenant.id);
  assert.deepEqual(L.concepts.list().map((c) => [c.name, c.amountCents]), [["Vigilancia", 3_000_000]]);
  const user = s.store.users.byEmail("marta@ejemplo.com");
  assert.equal(user.tenantId, tenant.id);
  assert.equal(user.name, "Marta", "el saludo usa el primer nombre que escribió");
  assert.ok(user.passwordHash.startsWith("scrypt$") && !user.passwordHash.includes("una-clave"));

  // Closed for good, even with the right token.
  assert.equal((await fetch(`${s.base}/setup?token=${SETUP_TOKEN}`)).status, 404);
  assert.equal((await form(`${s.base}/setup`, setupForm({ nombre: "Otro", correo: "otro@ejemplo.com" }))).status, 404);
  assert.equal(s.store.tenants.list().length, 1);

  // The login page greets the new treasurer, and the chosen password works through the 2-step flow.
  assert.match(await (await fetch(`${s.base}/login?m=creado`)).text(), /Conjunto creado/);
  const { res, cookie } = await signIn(s.base, "marta@ejemplo.com", "una-clave-bien-larga");
  assert.equal(res.headers.get("location"), "/panel");
  assert.match(await (await fetch(`${s.base}/panel`, { headers: { cookie } })).text(), /Jardines de Ibiza/);
}, { empty: true }));

test("configuración inicial: valida los datos y no crea nada si algo está mal", () => withServer(async (s) => {
  for (const [over, mensaje] of [
    [{ nombre: "" }, /nombre del conjunto/],
    [{ tesorero: "" }, /Escribe tu nombre/],
    [{ cuota: "abc" }, /cuota/],
    [{ cuota: "500" }, /cuota/],
    [{ correo: "sin-arroba" }, /correo válido/],
    [{ clave: "corta", clave2: "corta" }, /10 caracteres/],
    [{ clave2: "otra-clave-distinta" }, /no coinciden/],
  ]) {
    const res = await form(`${s.base}/setup`, setupForm(over));
    assert.equal(res.status, 400, JSON.stringify(over));
    const page = await res.text();
    assert.match(page, mensaje);
    assert.doesNotMatch(page, /una-clave-bien-larga/, "nunca devuelve la contraseña");
  }
  assert.equal(s.store.tenants.list().length, 0);
  const again = await (await form(`${s.base}/setup`, setupForm({ correo: "malo", nombre: "Mi Conjunto" }))).text();
  assert.match(again, /value="Mi Conjunto"/, "conserva lo que ya escribiste");
  assert.equal((await form(`${s.base}/setup`, setupForm(), null, { Origin: "https://malo.example" })).status, 403);
}, { empty: true }));

test("configuración inicial: dos envíos a la vez crean un solo conjunto", () => withServer(async (s) => {
  const results = await Promise.all([
    form(`${s.base}/setup`, setupForm({ nombre: "Uno", correo: "uno@ejemplo.com" })),
    form(`${s.base}/setup`, setupForm({ nombre: "Dos", correo: "dos@ejemplo.com" })),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [303, 404]);
  assert.equal(s.store.tenants.list().length, 1);
}, { empty: true }));

test("configuración inicial: no se puede adivinar el token a golpes", () => withServer(async (s) => {
  let last;
  for (let i = 0; i < 12; i++) last = (await fetch(`${s.base}/setup?token=intento-${i}`)).status;
  assert.equal(last, 429);
  assert.equal((await fetch(`${s.base}/setup?token=${SETUP_TOKEN}`)).status, 429, "ni siquiera el correcto mientras dure el bloqueo");
}, { empty: true }));

test("al activar el doble factor se muestra el QR de la misma clave que se escribe", () => withServer(async (s) => {
  const { cookie } = await passwordStep(s.base, "marta@ejemplo.com", "clave-de-marta");
  const page = await (await fetch(`${s.base}/2fa`, { headers: { cookie } })).text();
  const key = page.match(/class="key secret" translate="no">([A-Z2-7 ]+)</)[1].replace(/ /g, "");
  const uri = `otpauth://totp/${encodeURIComponent("Cuotia:marta@ejemplo.com")}?secret=${key}&issuer=Cuotia`;
  assert.ok(page.includes(qrSvg(uri, { label: "Código QR para agregar Cuotia a tu app de códigos" })), "el QR codifica el mismo secreto que la clave escrita");
  assert.match(page, /¿No puedes escanearlo\?/, "queda la clave escrita como alternativa");
  // Once enrolled, later sign-ins ask only for the code: no QR, no key.
  const { cookie: full } = await signIn(s.base, "marta@ejemplo.com", "clave-de-marta", { step: totpStep() });
  assert.ok(full);
  const { cookie: again } = await passwordStep(s.base, "marta@ejemplo.com", "clave-de-marta");
  const later = await (await fetch(`${s.base}/2fa`, { headers: { cookie: again } })).text();
  assert.doesNotMatch(later, /class="qr"|class="key secret"/);
}));

test("siempre claro, como el diseño: sin modo oscuro automático", () => withServer(async (s) => {
  const css = await (await fetch(`${s.base}/static/app.css`)).text();
  assert.doesNotMatch(css, /prefers-color-scheme/, "un navegador en modo oscuro debe ver el mismo diseño aprobado");
  assert.match(css, /color-scheme:\s*light only/);
  const page = await (await fetch(`${s.base}/login`)).text();
  assert.match(page, /<meta name="color-scheme" content="light">/);
  // The approved palette (taken from the mockups) is what the tokens say.
  for (const [name, hex] of [["ink", "#0b4a3a"], ["accent", "#c9efdc"], ["hero-bg", "#c9efdc"], ["ground", "#f3f8f6"], ["surface", "#ffffff"], ["muted", "#56756b"], ["line", "#d9e7e1"]]) {
    assert.match(css, new RegExp(`--${name}:\\s*${hex}`), name);
  }
}));

test("importar casas: pega una lista, crea casas con su enlace y sus cuotas, y avisa lo que no pudo", () => withServer(async (s) => {
  const { cookie } = await signIn(s.base, "marta@ejemplo.com", "clave-de-marta");
  const csrf = await csrfOf(s.base, cookie, "/panel/casas/importar");
  assert.ok(csrf);
  assert.match(await (await fetch(`${s.base}/panel/casas/importar`, { headers: { cookie } })).text(), /Importar casas/);
  assert.match(await (await fetch(`${s.base}/panel/casas`, { headers: { cookie } })).text(), /Importar varias/);

  const lista = "Casa\tNombre\tCelular\n20\tLucía Gómez\t300 111 2233\n21;Pedro Cardona\n14;Ya existe;3000000000\n22\n";
  assert.equal((await form(`${s.base}/panel/casas/importar`, { casas: lista }, cookie)).status, 403, "sin token");
  assert.equal(s.A.houses.list().length, 2);

  const res = await form(`${s.base}/panel/casas/importar`, { _csrf: csrf, casas: lista }, cookie);
  assert.equal(res.status, 200);
  const page = await res.text();
  assert.match(page, /2 casas importadas/);
  assert.match(page, /Revisa estas líneas/);
  assert.match(page, /Ya existe la casa 14/, "no pisa una casa existente");
  assert.match(page, /Línea 5/, "señala la línea con el problema");
  assert.match(page, /wa\.me\/573001112233/, "WhatsApp solo con celular");
  assert.equal((page.match(/wa\.me\//g) ?? []).length, 1);
  assert.equal(s.A.houses.get(s.a14.house.id).residentName, "Sandra Duque Arias", "la casa 14 sigue igual");

  const links = [...page.matchAll(/http:\/\/localhost:3000(\/r\/[A-Za-z0-9_-]+)/g)].map((m) => m[1]);
  assert.equal(new Set(links).size, 2);
  for (const l of links) assert.equal((await fetch(`${s.base}${l}`)).status, 200, "cada enlace abre la casa");
  const lucia = s.A.houses.list().find((h) => h.code === "20");
  assert.equal(s.A.dues.listForHouse(lucia.id).length, 1, "ya tiene la cuota de este mes");
  assert.equal(s.B.houses.list().length, 1, "el otro conjunto no recibe nada");
}));

test("una casa nueva o reactivada recibe la cuota del mes al instante", () => withServer(async (s) => {
  s.A.dues.generate(currentPeriod());
  const { cookie } = await signIn(s.base, "marta@ejemplo.com", "clave-de-marta");
  const csrf = await csrfOf(s.base, cookie, "/panel/casas");
  await form(`${s.base}/panel/casas`, { _csrf: csrf, code: "30", residente: "Nueva Vecina" }, cookie);
  const nueva = s.A.houses.list().find((h) => h.code === "30");
  assert.equal(s.A.dues.listForHouse(nueva.id).length, 1, "sin esperar a la siguiente pasada");

  s.A.houses.setActive(s.a03.house.id, false);
  s.A.houses.setActive(s.a03.house.id, true);
  const before = s.A.dues.listForHouse(s.a03.house.id).length;
  await form(`${s.base}/panel/casas/${s.a03.house.id}/desactivar`, { _csrf: csrf }, cookie);
  await form(`${s.base}/panel/casas/${s.a03.house.id}/reactivar`, { _csrf: csrf }, cookie);
  assert.equal(s.A.dues.listForHouse(s.a03.house.id).length, before, "no duplica la cuota que ya tenía");
}));

test("Ajustes: la llave Bre-B se cambia y los residentes la ven; el otro conjunto no se entera", () => withServer(async (s) => {
  s.A.dues.generate(currentPeriod());
  const { cookie } = await signIn(s.base, "marta@ejemplo.com", "clave-de-marta");
  const csrf = await csrfOf(s.base, cookie, "/panel/ajustes");
  const page = await (await fetch(`${s.base}/panel/ajustes`, { headers: { cookie } })).text();
  assert.match(page, /value="@ibiza"/, "muestra la llave actual para editarla");

  assert.equal((await form(`${s.base}/panel/ajustes/cobro`, { llave: "@x" }, cookie)).status, 403);
  assert.equal(s.store.tenants.get(s.a.id).payKey, "@ibiza");
  assert.match((await form(`${s.base}/panel/ajustes/cobro`, { _csrf: csrf, llave: "  @nueva.llave ", titular: "Ana Pérez" }, cookie)).headers.get("location"), /m=cobro/);
  assert.match(await (await fetch(`${s.base}/r/${s.a14.accessToken}/pagar`)).text(), /@nueva\.llave[\s\S]*Ana Pérez/);
  assert.equal(s.store.tenants.get(s.b.id).payKey, null);
}));

test("cambiar la contraseña: exige la actual, cierra las otras sesiones y la anterior deja de servir", () => withServer(async (s) => {
  const a = await signIn(s.base, "marta@ejemplo.com", "clave-de-marta");
  const csrf = await csrfOf(s.base, a.cookie, "/panel/ajustes");
  // A second device, signed in with the next code step.
  const second = await passwordStep(s.base, "marta@ejemplo.com", "clave-de-marta");
  const b = { cookie: cookieOf(await form(`${s.base}/2fa`, { code: totpCode(a.secret, totpStep() + 1) }, second.cookie)) };
  assert.equal((await fetch(`${s.base}/panel`, { headers: { cookie: b.cookie }, redirect: "manual" })).status, 200);

  const send = (fields, cookie = a.cookie) => form(`${s.base}/panel/ajustes/clave`, fields, cookie);
  assert.equal((await send({ actual: "clave-de-marta", nueva: "una-clave-nueva-larga", nueva2: "una-clave-nueva-larga" })).status, 403, "sin token");
  assert.match((await send({ _csrf: csrf, actual: "equivocada", nueva: "una-clave-nueva-larga", nueva2: "una-clave-nueva-larga" })).headers.get("location"), /m=clavemal/);
  assert.match((await send({ _csrf: csrf, actual: "clave-de-marta", nueva: "corta", nueva2: "corta" })).headers.get("location"), /m=clavebad/);
  assert.match((await send({ _csrf: csrf, actual: "clave-de-marta", nueva: "una-clave-nueva-larga", nueva2: "otra-distinta-larga" })).headers.get("location"), /m=clavebad/);
  assert.equal((await passwordStep(s.base, "marta@ejemplo.com", "clave-de-marta")).res.status, 303, "nada cambió: la contraseña vieja sigue valiendo");

  assert.match((await send({ _csrf: csrf, actual: "clave-de-marta", nueva: "una-clave-nueva-larga", nueva2: "una-clave-nueva-larga" })).headers.get("location"), /m=clave$/);
  assert.equal((await fetch(`${s.base}/panel`, { headers: { cookie: a.cookie }, redirect: "manual" })).status, 200, "la sesión que hizo el cambio sigue");
  assert.equal((await fetch(`${s.base}/panel`, { headers: { cookie: b.cookie }, redirect: "manual" })).status, 303, "la del otro dispositivo se cerró");
  assert.equal((await passwordStep(s.base, "marta@ejemplo.com", "clave-de-marta")).res.status, 401, "la anterior ya no entra");
  assert.equal((await passwordStep(s.base, "marta@ejemplo.com", "una-clave-nueva-larga")).res.status, 303);
  assert.equal(s.store.users.byEmail("luis@ejemplo.com").passwordHash.startsWith("scrypt$"), true, "la de otra persona no se tocó");
}));

test("adivinar la contraseña actual desde Ajustes también tiene límite", () => withServer(async (s) => {
  const { cookie } = await signIn(s.base, "marta@ejemplo.com", "clave-de-marta");
  const csrf = await csrfOf(s.base, cookie, "/panel/ajustes");
  let last;
  for (let i = 0; i < 7; i++) last = await form(`${s.base}/panel/ajustes/clave`, { _csrf: csrf, actual: `intento-${i}`, nueva: "una-clave-nueva-larga", nueva2: "una-clave-nueva-larga" }, cookie);
  assert.match(last.headers.get("location"), /m=clavelim/);
  const right = await form(`${s.base}/panel/ajustes/clave`, { _csrf: csrf, actual: "clave-de-marta", nueva: "una-clave-nueva-larga", nueva2: "una-clave-nueva-larga" }, cookie);
  assert.match(right.headers.get("location"), /m=clavelim/, "ni la correcta mientras dure el bloqueo");
}));

test("HSTS solo con https; y una cookie dañada redirige al login en vez de fallar", () => withServer(async (s) => {
  const res = await fetch(`${s.base}/health`);
  assert.match(res.headers.get("strict-transport-security"), /max-age=\d+/);
  const broken = await fetch(`${s.base}/panel`, { headers: { cookie: "cuotia_sid=%E0%A4%A" }, redirect: "manual" });
  assert.equal(broken.status, 303);
  assert.equal(broken.headers.get("location"), "/login");
}, { secure: true }));

test("sin https no se manda HSTS (no se debe forzar https en una prueba local)", () => withServer(async (s) => {
  assert.equal((await fetch(`${s.base}/health`)).headers.get("strict-transport-security"), null);
}));

test("pago manual: varios meses de una vez, con medio, fecha y nota; aparece en el historial y en el recibo", () => withServer(async (s) => {
  s.A.dues.generate("2026-09");
  s.A.dues.generate("2026-10");
  s.A.dues.generate(currentPeriod());
  const { cookie } = await signIn(s.base, "marta@ejemplo.com", "clave-de-marta");
  const csrf = await csrfOf(s.base, cookie, "/panel/pagos/nuevo");
  const today = bogotaDateTime(new Date().toISOString()).slice(0, 10);

  // Step 1: only houses with something pending, each with its count.
  const pick = await (await fetch(`${s.base}/panel/pagos/nuevo`, { headers: { cookie } })).text();
  assert.match(pick, /Sandra Duque Arias/);
  assert.match(pick, /3 cuotas/);
  assert.ok(pick.includes(`/panel/pagos/nuevo?casa=${s.a14.house.id}`), "cada casa es un botón que abre su formulario");
  assert.doesNotMatch(pick, /Carlos Mejía/, "ni casas de otro conjunto");

  // Step 2: the dues of that house, the oldest already ticked.
  const form2 = await (await fetch(`${s.base}/panel/pagos/nuevo?casa=${s.a14.house.id}`, { headers: { cookie } })).text();
  const dues = s.A.dues.listForHouse(s.a14.house.id).sort((a, b) => a.period.localeCompare(b.period));
  assert.equal((form2.match(/name="cuota"/g) ?? []).length, 3);
  assert.match(form2, new RegExp(`name="cuota" value="${dues[0].id}" checked`));
  assert.match(form2, new RegExp(`name="fecha" value="${today}" max="${today}"`));
  assert.equal((await fetch(`${s.base}/panel/pagos/nuevo?casa=${s.b01.house.id}`, { headers: { cookie } })).status, 200, "una casa de otro conjunto no se abre: solo muestra el selector");
  assert.doesNotMatch(await (await fetch(`${s.base}/panel/pagos/nuevo?casa=${s.b01.house.id}`, { headers: { cookie } })).text(), /Carlos Mejía/);

  // Pay September and October by Nequi transfer, dated the 2nd of October.
  const res = await form(`${s.base}/panel/pagos/nuevo`, {
    _csrf: csrf, casa: s.a14.house.id, medio: "transfer", banco: "Nequi", fecha: "2026-10-02", nota: "lo trajo la esposa",
  }, cookie).catch(() => null);
  assert.equal(res.headers.get("location"), `/panel/pagos/nuevo?casa=${s.a14.house.id}&m=manualbad`, "sin cuotas marcadas no registra nada");

  const body = new URLSearchParams({ _csrf: csrf, casa: s.a14.house.id, medio: "transfer", banco: "Nequi", fecha: "2026-10-02", nota: "lo trajo la esposa" });
  body.append("cuota", dues[0].id);
  body.append("cuota", dues[1].id);
  const ok = await post(`${s.base}/panel/pagos/nuevo`, body, { ...FORM, cookie });
  assert.match(ok.headers.get("location"), /\/panel\/cobros\?m=manual/, "vuelve a la lista de quién aún debe");

  const after = s.A.dues.listForHouse(s.a14.house.id).sort((a, b) => a.period.localeCompare(b.period));
  assert.deepEqual(after.map((d) => d.status), ["paid", "paid", "pending"]);
  assert.equal(after[0].paymentId, after[1].paymentId, "un solo pago cubre las dos cuotas");
  const payment = s.A.payments.get(after[0].paymentId);
  assert.deepEqual([payment.amountCents, payment.method, payment.bank, payment.note, payment.manual, payment.status], [6_000_000, "transfer", "Nequi", "lo trajo la esposa", true, "assigned"]);
  assert.equal(payment.paidAt, "2026-10-02T17:00:00.000Z", "mediodía de Colombia ese día");
  assert.equal(s.A.payments.list({ period: "2026-10" }).total, 1, "cae en el mes en que pagó, no en el de hoy");

  const history = await (await fetch(`${s.base}/panel/pagos?q=Sandra`, { headers: { cookie } })).text();
  assert.match(history, /Transferencia · Sandra Duque Arias/);
  assert.match(history, /lo trajo la esposa/);
  const csv = await (await fetch(`${s.base}/panel/pagos.csv`, { headers: { cookie } })).text();
  assert.match(csv, /"Transferencia · Nequi";"14"/);

  // The resident gets a receipt per month, saying how it was paid.
  const receipt = await (await fetch(`${s.base}/r/${s.a14.accessToken}/recibo/${dues[0].id}`)).text();
  assert.match(receipt, /Transferencia · Nequi/);
  assert.match(receipt, /\$30\.000/, "el recibo de cada mes muestra el valor de ese mes, no el total");

  // Undo removes the whole manual payment and puts both months back.
  const undone = await form(`${s.base}/panel/pagos/${payment.id}/deshacer`, { _csrf: csrf }, cookie);
  assert.match(undone.headers.get("location"), /m=undoc/);
  assert.equal(s.A.payments.get(payment.id), null);
  assert.deepEqual(s.A.dues.listForHouse(s.a14.house.id).map((d) => d.status), ["pending", "pending", "pending"]);
}));

test("pago manual: valida fecha, cuotas y medio, y no toca nada de otro conjunto", () => withServer(async (s) => {
  s.A.dues.generate(currentPeriod());
  s.B.dues.generate(currentPeriod());
  const { cookie } = await signIn(s.base, "marta@ejemplo.com", "clave-de-marta");
  const csrf = await csrfOf(s.base, cookie, "/panel/pagos/nuevo");
  const mine = s.A.dues.listForHouse(s.a14.house.id)[0].id;
  const theirs = s.B.dues.listForHouse(s.b01.house.id)[0].id;
  const today = bogotaDateTime(new Date().toISOString()).slice(0, 10);
  const tomorrow = new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10);
  const go = (fields) => form(`${s.base}/panel/pagos/nuevo`, { _csrf: csrf, medio: "cash", fecha: today, ...fields }, cookie);
  const untouched = () => s.A.dues.listForHouse(s.a14.house.id)[0].status === "pending" && s.B.dues.listForHouse(s.b01.house.id)[0].status === "pending";

  assert.equal((await form(`${s.base}/panel/pagos/nuevo`, { casa: s.a14.house.id, cuota: mine, medio: "cash", fecha: today }, cookie)).status, 403, "sin token");
  assert.match((await go({ casa: s.a14.house.id, cuota: mine, fecha: tomorrow })).headers.get("location"), /m=manualbad/, "no se registra un pago del futuro");
  assert.match((await go({ casa: s.a14.house.id, cuota: mine, fecha: "ayer" })).headers.get("location"), /m=manualbad/);
  assert.match((await go({ casa: s.a14.house.id, cuota: mine, fecha: "2001-01-01" })).headers.get("location"), /m=manualbad/);
  assert.match((await go({ casa: s.a14.house.id, cuota: mine, medio: "bitcoin" })).headers.get("location"), /m=err/);
  assert.match((await go({ casa: s.b01.house.id, cuota: theirs })).headers.get("location"), /m=err/, "casa de otro conjunto");
  assert.match((await go({ casa: s.a14.house.id, cuota: theirs })).headers.get("location"), /m=err/, "cuota de otro conjunto en una casa propia");
  assert.match((await go({ casa: s.a03.house.id, cuota: mine })).headers.get("location"), /m=err/, "cuota de otra casa");
  assert.ok(untouched(), "ningún intento fallido dejó nada a medias");
  assert.equal(s.A.payments.list().total + s.B.payments.list().total, 0);

  assert.match((await go({ casa: s.a14.house.id, cuota: mine, medio: "other", nota: "x".repeat(500) })).headers.get("location"), /m=manual$/);
  assert.equal(s.A.payments.list().rows[0].note.length, 120, "la nota se recorta");
}));

test("sin pagoradar todo funciona a mano: se registran los pagos y el residente ve que debe avisar al tesorero", () => withServer(async (s) => {
  s.store.db.prepare("UPDATE tenants SET pagoradar_secret = NULL WHERE id = ?").run(s.a.id);
  assert.equal(s.store.tenants.get(s.a.id).pagoradarConfigured, false);
  s.A.dues.generate(currentPeriod());
  const { cookie } = await signIn(s.base, "marta@ejemplo.com", "clave-de-marta");

  const pay = await (await fetch(`${s.base}/r/${s.a14.accessToken}/pagar`)).text();
  assert.match(pay, /pagada<\/b> cuando el tesorero registre tu pago/);
  assert.doesNotMatch(pay, /cuando el banco lo confirme/);
  assert.match(await (await fetch(`${s.base}/panel/ajustes`, { headers: { cookie } })).text(), /Es opcional\.<\/b> Sin pagoradar/);

  const csrf = await csrfOf(s.base, cookie, "/panel/pagos/nuevo");
  const today = bogotaDateTime(new Date().toISOString()).slice(0, 10);
  const due = s.A.dues.listForHouse(s.a14.house.id)[0].id;
  assert.match((await form(`${s.base}/panel/pagos/nuevo`, { _csrf: csrf, casa: s.a14.house.id, cuota: due, medio: "cash", fecha: today }, cookie)).headers.get("location"), /m=manual/);
  assert.match(await (await fetch(`${s.base}/r/${s.a14.accessToken}`)).text(), /Al día/);
  const panel = await (await fetch(`${s.base}/panel`, { headers: { cookie } })).text();
  assert.match(panel, /Registrar pago/);
  assert.match(panel, /\$30\.000/);
}));

const pngSize = (bytes) => [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];

test("favicon e íconos: se sirven con su tipo y son PNG del tamaño que dicen", () => withServer(async (s) => {
  for (const [path, size] of [["favicon-32.png", 32], ["favicon-48.png", 48], ["apple-touch-icon.png", 180], ["icon-192.png", 192], ["icon-512.png", 512], ["maskable-512.png", 512]]) {
    const res = await fetch(`${s.base}/static/icons/${path}`);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get("content-type"), "image/png");
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.equal(bytes.subarray(1, 4).toString(), "PNG", "llega intacto, no convertido a texto");
    assert.deepEqual(pngSize(bytes), [size, size], path);
  }
  for (const path of ["/static/icons/icon.svg", "/static/icons/maskable.svg", "/favicon.svg"]) {
    const res = await fetch(`${s.base}${path}`);
    assert.equal(res.headers.get("content-type"), "image/svg+xml", path);
    assert.match(await res.text(), /<svg[^>]+viewBox="0 0 512 512"/);
  }
  const ico = await fetch(`${s.base}/favicon.ico`);
  assert.equal(ico.headers.get("content-type"), "image/x-icon");
  const bytes = Buffer.from(await ico.arrayBuffer());
  assert.deepEqual([bytes.readUInt16LE(0), bytes.readUInt16LE(2), bytes.readUInt16LE(4)], [0, 1, 2], "cabecera ICO con dos imágenes");
  for (let i = 0; i < 2; i++) {
    const [width, , , , , bits, length, offset] = [bytes[6 + i * 16], bytes[7 + i * 16], bytes[8 + i * 16], bytes[9 + i * 16], bytes.readUInt16LE(10 + i * 16), bytes.readUInt16LE(12 + i * 16), bytes.readUInt32LE(14 + i * 16), bytes.readUInt32LE(18 + i * 16)];
    assert.equal(bits, 32);
    assert.deepEqual(pngSize(bytes.subarray(offset, offset + length)), [width, width], "cada imagen del .ico es un PNG del tamaño anunciado");
  }
}));

test("manifiesto del tesorero: instalable, con íconos que existen y accesos directos reales", () => withServer(async (s) => {
  const res = await fetch(`${s.base}/manifest.webmanifest`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /application\/manifest\+json/);
  const m = await res.json();
  assert.deepEqual([m.name, m.short_name, m.display, m.start_url, m.scope], ["Cuotia", "Cuotia", "standalone", "/panel", "/"]);
  assert.equal(m.theme_color, "#0b4a3a");
  assert.equal(m.background_color, "#f3f8f6");
  const pngs = m.icons.filter((i) => i.type === "image/png");
  assert.ok(pngs.some((i) => i.sizes === "192x192" && i.purpose === "any"), "ícono de 192 para instalar");
  assert.ok(pngs.some((i) => i.sizes === "512x512" && i.purpose === "any"), "ícono de 512 para la pantalla de inicio");
  assert.ok(pngs.some((i) => i.purpose === "maskable"), "versión que el celular puede recortar");
  for (const icon of m.icons) {
    const r = await fetch(`${s.base}${icon.src}`);
    assert.equal(r.status, 200, icon.src);
    assert.equal(r.headers.get("content-type"), icon.type);
    if (icon.type === "image/png") assert.deepEqual(pngSize(Buffer.from(await r.arrayBuffer())), icon.sizes.split("x").map(Number), `${icon.src} mide lo que dice`);
  }
  for (const sc of m.shortcuts) assert.equal((await fetch(`${s.base}${sc.url}`, { redirect: "manual" })).status, 303, `${sc.url} existe (pide iniciar sesión)`);
}));

test("las páginas enlazan el ícono, el manifiesto y los datos para instalar en iPhone y Android", () => withServer(async (s) => {
  s.A.dues.generate(currentPeriod());
  const { cookie } = await signIn(s.base, "marta@ejemplo.com", "clave-de-marta");
  const pages = [
    await (await fetch(`${s.base}/login`)).text(),
    await (await fetch(`${s.base}/panel`, { headers: { cookie } })).text(),
    await (await fetch(`${s.base}/offline`)).text(),
  ];
  for (const html of pages) {
    assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/);
    assert.match(html, /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml">/);
    assert.match(html, /rel="icon" href="\/static\/icons\/favicon-32\.png"/);
    assert.match(html, /<link rel="apple-touch-icon" href="\/static\/icons\/apple-touch-icon\.png">/);
    assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes">/);
    assert.match(html, /<meta name="apple-mobile-web-app-title" content="Cuotia">/);
    assert.match(html, /<meta name="theme-color" content="#0B4A3A">/);
  }
}));

test("cada residente instala su propia app, que abre en su enlace; nada de otras casas", () => withServer(async (s) => {
  const token = s.a14.accessToken;
  const res = await fetch(`${s.base}/r/${token}/manifest.webmanifest`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /application\/manifest\+json/);
  const m = await res.json();
  assert.deepEqual([m.name, m.short_name, m.start_url, m.scope, m.id, m.display], ["Cuotia · Casa 14", "Casa 14", `/r/${token}`, `/r/${token}`, `/r/${token}`, "standalone"]);
  assert.ok(m.icons.some((i) => i.sizes === "192x192") && m.icons.some((i) => i.sizes === "512x512"));
  assert.ok(m.start_url.startsWith(m.scope), "la página de inicio cae dentro del alcance");
  for (const sub of ["/pagar", "/recibo/du_1"]) assert.ok(`/r/${token}${sub}`.startsWith(m.scope), `${sub} sigue dentro de la app`);
  assert.doesNotMatch(JSON.stringify(m), /Diana|Carlos|Los Robles/);

  s.A.dues.generate(currentPeriod());
  for (const path of ["", "/pagar"]) {
    const page = await (await fetch(`${s.base}/r/${token}${path}`)).text();
    assert.ok(page.includes(`<link rel="manifest" href="/r/${token}/manifest.webmanifest">`), `la página ${path || "de inicio"} enlaza su propio manifiesto`);
  }
  const due = s.A.dues.listForHouse(s.a14.house.id)[0];
  s.A.payments.recordCash(s.a14.house.id);
  assert.ok((await (await fetch(`${s.base}/r/${token}/recibo/${due.id}`)).text()).includes(`/r/${token}/manifest.webmanifest`), "y el recibo también");

  assert.equal((await fetch(`${s.base}/r/${"x".repeat(32)}/manifest.webmanifest`)).status, 404);
  s.A.houses.setActive(s.a14.house.id, false);
  assert.equal((await fetch(`${s.base}/r/${token}/manifest.webmanifest`)).status, 404, "una casa desactivada ya no se instala");
}));

test("sin conexión: la página de aviso es pública y no lleva datos de nadie", () => withServer(async (s) => {
  const res = await fetch(`${s.base}/offline`);
  assert.equal(res.status, 200);
  const page = await res.text();
  assert.match(page, /Sin conexión/);
  assert.match(page, /data-reload/);
  assert.doesNotMatch(page, /Jardines|Sandra|\/r\//);
}));

/** Runs public/sw.js in a sandbox with a fake cache and network, so its rules can be checked without a browser. */
function loadWorker() {
  const listeners = {};
  const saved = new Map(); // what the fake Cache Storage holds, by URL
  const log = { put: [], deleted: [], added: [] };
  const caches = {
    open: async () => ({ addAll: async (urls) => { log.added.push(...urls); }, put: async (req) => { log.put.push(req.url); saved.set(req.url, { fromCache: true }); } }),
    match: async (req) => saved.get(typeof req === "string" ? `https://cuotia.test${req}` : req.url),
    keys: async () => ["cuotia-static-v0", "cuotia-static-v1", "cuotia-static-v2", "ajeno"],
    delete: async (key) => { log.deleted.push(key); return true; },
  };
  const net = { online: true };
  const context = {
    self: { addEventListener: (type, fn) => { listeners[type] = fn; }, location: { origin: "https://cuotia.test" }, skipWaiting: () => { log.skipped = true; }, clients: { claim: async () => { log.claimed = true; } } },
    caches, URL, Promise,
    fetch: async (req) => { if (!net.online) throw new TypeError("sin red"); return { ok: true, fromNetwork: true, url: req.url, clone() { return this; } }; },
  };
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"), context);
  const fetchEvent = (url, { method = "GET", mode = "no-cors" } = {}) => {
    const event = { request: { url, method, mode }, respondWith(p) { this.answer = p; } };
    listeners.fetch(event);
    return event;
  };
  return { listeners, saved, log, net, fetchEvent, flush: () => new Promise((r) => setTimeout(r, 0)) };
}

test("service worker: nunca guarda páginas ni formularios; sin red muestra la página de aviso", async () => {
  const w = loadWorker();
  w.saved.set("https://cuotia.test/offline", { offlinePage: true });
  const origin = "https://cuotia.test";

  // Pages (navigation): network first, and NEVER written to the cache.
  const page = w.fetchEvent(`${origin}/r/TOKEN-SECRETO-1234567890/pagar`, { mode: "navigate" });
  assert.equal((await page.answer).fromNetwork, true);
  await w.flush();
  assert.deepEqual(w.log.put, [], "una página con datos personales no se guarda");
  w.net.online = false;
  assert.deepEqual(await w.fetchEvent(`${origin}/panel`, { mode: "navigate" }).answer, { offlinePage: true }, "sin red, la página de aviso");
  w.net.online = true;

  // Anything that is not a plain GET, or not ours, is left alone: payments, logins and other sites go straight through.
  assert.equal(w.fetchEvent(`${origin}/panel/pagos/nuevo`, { method: "POST" }).answer, undefined);
  assert.equal(w.fetchEvent(`${origin}/login`, { method: "POST", mode: "navigate" }).answer, undefined);
  assert.equal(w.fetchEvent("https://otro-sitio.test/x.js").answer, undefined);
  assert.equal(w.fetchEvent(`${origin}/health`).answer, undefined, "ni siquiera las respuestas sueltas que no son de /static/");
  assert.equal(w.fetchEvent(`${origin}/panel/pagos.csv`).answer, undefined, "ni el CSV de pagos");

  // Look-and-feel files: saved when fetched, served from the saved copy when offline.
  const css = w.fetchEvent(`${origin}/static/app.css`);
  assert.equal((await css.answer).fromNetwork, true);
  await w.flush();
  assert.deepEqual(w.log.put, [`${origin}/static/app.css`]);
  w.net.online = false;
  assert.deepEqual(await w.fetchEvent(`${origin}/static/app.css`).answer, { fromCache: true });
  assert.ok(w.log.put.every((u) => u.includes("/static/")), "solo se guardó lo de /static/");
});

test("service worker: al instalar guarda lo justo y al activarse borra versiones viejas, no cachés ajenos", async () => {
  const w = loadWorker();
  let installed;
  w.listeners.install({ waitUntil: (p) => { installed = p; } });
  await installed;
  assert.ok(w.log.added.includes("/offline") && w.log.added.includes("/static/app.css"));
  assert.ok(w.log.added.every((u) => u === "/offline" || u.startsWith("/static/")), "nada de páginas del panel");
  assert.equal(w.log.skipped, true);

  let activated;
  w.listeners.activate({ waitUntil: (p) => { activated = p; } });
  await activated;
  assert.deepEqual(w.log.deleted.sort(), ["cuotia-static-v0", "cuotia-static-v2"], "borra las versiones viejas de Cuotia y respeta el resto");
  assert.equal(w.log.claimed, true);
});

test("el service worker y el manifiesto se sirven de forma que las actualizaciones lleguen", () => withServer(async (s) => {
  const sw = await fetch(`${s.base}/sw.js`);
  assert.equal(sw.status, 200);
  assert.match(sw.headers.get("content-type"), /javascript/);
  assert.equal(sw.headers.get("cache-control"), "no-cache", "si el navegador lo guardara, un arreglo no llegaría");
  const js = await (await fetch(`${s.base}/static/app.js`)).text();
  assert.match(js, /serviceWorker\.register\("\/sw\.js"\)/);
  assert.match((await fetch(`${s.base}/manifest.webmanifest`)).headers.get("cache-control"), /max-age=3600/);
}));

/** Two months of life: Sandra (14) owes last month AND this one; Diana (03) paid last month and owes this one. */
function twoMonths(s) {
  const now = currentPeriod();
  const before = shiftPeriod(now, -1);
  s.A.dues.generate(before);
  s.A.dues.generate(now);
  const due = (house, period) => s.A.dues.listForHouse(house).find((d) => d.period === period);
  s.A.payments.recordManual({ houseId: s.a03.house.id, dueIds: [due(s.a03.house.id, before).id], method: "cash" });
  return { now, before, due };
}

test("Por cobrar: quién debe, desde cuándo y cuánto, con los botones para actuar", () => withServer(async (s) => {
  const { now, before } = twoMonths(s);
  s.A.houses.update(s.a14.house.id, { code: "14", residentName: "Sandra Duque Arias", phone: "300 123 4567" });
  s.B.dues.generate(now);
  assert.equal((await fetch(`${s.base}/panel/cobros`, { redirect: "manual" })).status, 303, "pide iniciar sesión");
  const { cookie } = await signIn(s.base, "marta@ejemplo.com", "clave-de-marta");
  const page = await (await fetch(`${s.base}/panel/cobros`, { headers: { cookie } })).text();

  assert.match(page, /<h1>Por cobrar<\/h1>/);
  assert.match(page, /\$90\.000/, "total: 60.000 de Sandra + 30.000 de Diana");
  assert.match(page, /2 casas con cuotas pendientes/);
  assert.match(page, /1 casa tiene cuotas vencidas/);
  assert.ok(page.indexOf("Sandra Duque Arias") < page.indexOf("Diana Pérez"), "quien arrastra meses va primero");
  assert.doesNotMatch(page, /Carlos Mejía/, "ni casas de otro conjunto");
  const sandra = page.slice(page.indexOf("Sandra Duque Arias"), page.indexOf("Diana Pérez"));
  assert.match(sandra, /mchip bad/, "el mes anterior se ve en rojo");
  assert.match(sandra, /\$60\.000/);
  assert.ok(sandra.includes(`/panel/pagos/nuevo?casa=${s.a14.house.id}`), "botón Registrar pago de esa casa");
  assert.match(sandra, /wa\.me\/573001234567\?text=[^"]*Hola%20Sandra/, "WhatsApp directo con el mensaje ya escrito");
  const diana = page.slice(page.indexOf("Diana Pérez"));
  assert.match(diana, /wa\.me\/\?text=/, "sin celular, WhatsApp deja elegir a quién");
  assert.match(page, /Recordar a todos por WhatsApp/);
  assert.match(page, /class="badge warn"[^>]*>2</, "el menú cuenta las casas con deuda");
  assert.match(page, /Por cobrar<\/span><span class="badge warn"/);

  // Filters and search narrow the list without scripts.
  const names = (html) => ["Sandra Duque Arias", "Diana Pérez"].filter((n) => html.includes(`<b>${n}</b>`));
  assert.deepEqual(names(await (await fetch(`${s.base}/panel/cobros?f=atrasadas`, { headers: { cookie } })).text()), ["Sandra Duque Arias"]);
  assert.deepEqual(names(await (await fetch(`${s.base}/panel/cobros?f=mes`, { headers: { cookie } })).text()), ["Diana Pérez"]);
  assert.deepEqual(names(await (await fetch(`${s.base}/panel/cobros?q=diana`, { headers: { cookie } })).text()), ["Diana Pérez"]);
  assert.match(await (await fetch(`${s.base}/panel/cobros?q=zzz`, { headers: { cookie } })).text(), /Ninguna casa coincide/);
  assert.deepEqual(names(await (await fetch(`${s.base}/panel/cobros?f=raro`, { headers: { cookie } })).text()), ["Sandra Duque Arias", "Diana Pérez"], "un filtro desconocido se ignora");

  // When everyone has paid, a friendly empty state.
  for (const g of s.A.dues.listPending()) s.A.payments.recordManual({ houseId: g.houseId, dueIds: [g.id], method: "cash" });
  assert.match(await (await fetch(`${s.base}/panel/cobros`, { headers: { cookie } })).text(), /¡Todo al día!/);
  assert.doesNotMatch(await (await fetch(`${s.base}/panel/cobros`, { headers: { cookie } })).text(), /class="badge warn"/);
  assert.ok(before < now);
}));

test("Resumen: elegir el mes, ver lo atrasado y registrar el pago desde la propia fila", () => withServer(async (s) => {
  const { now, before, due } = twoMonths(s);
  const { cookie } = await signIn(s.base, "marta@ejemplo.com", "clave-de-marta");
  const get = async (path) => (await fetch(`${s.base}${path}`, { headers: { cookie } })).text();
  const page = await get("/panel");

  // The month navigator: back one month, no "next" beyond the current one.
  assert.ok(page.includes(`href="/panel?mes=${before}"`), "mes anterior");
  assert.match(page, /class="mn-btn off"/, "no hay un mes siguiente al actual");
  assert.match(page, /aria-label="Elegir mes"/);

  // This month's rows: each pending one has its own button, already pointing at that due; paid ones don't.
  const rows = page.match(/<tbody>[\s\S]*?<\/tbody>/)[0].split("</tr>").filter((r) => r.includes("<tr>"));
  assert.equal(rows.length, 2);
  for (const r of rows) assert.match(r, /Registrar pago/, "las dos deben este mes");
  const sandraRow = rows.find((r) => r.includes("Sandra"));
  assert.ok(sandraRow.includes(`/panel/pagos/nuevo?casa=${s.a14.house.id}&amp;cuota=${due(s.a14.house.id, now).id}`), "el botón de la fila abre el formulario con esa cuota marcada");
  assert.match(sandraRow, /Debe 2 meses/, "quien arrastra meses lo dice, no solo 'Pendiente'");
  assert.match(rows.find((r) => r.includes("Diana")), /Pendiente/);

  // The arrears card and the "collect first" list.
  assert.match(page, /Atrasadas/);
  assert.match(page, /\$30\.000<\/span>\s*<span class="small">1 casa tiene cuotas vencidas/);
  assert.match(page, /href="\/panel\/cobros\?f=atrasadas"/);
  assert.match(page, /Para cobrar primero/);
  assert.match(page, /Ver quién debe/);

  // Last month: banner, "Atrasada" for who still owes it, and a way back.
  const old = await get(`/panel?mes=${before}`);
  assert.match(old, /Estás viendo/);
  assert.match(old, /href="\/panel">Volver a este mes/);
  assert.match(old, /Atrasada/);
  assert.match(old, /Pagado/);
  assert.ok(old.includes(`/panel/pagos/nuevo?casa=${s.a14.house.id}&amp;cuota=${due(s.a14.house.id, before).id}`), "se puede cobrar un mes atrasado desde su propia vista");
  assert.ok(old.includes(`href="/panel"`) || old.includes("mn-btn off"), "ya no hay más meses atrás");
  assert.doesNotMatch(old, /Generar cuotas de/, "no se generan cuotas de un mes que ya pasó");

  // Anything that isn't a month with dues falls back to the current one.
  for (const bad of ["2020-01", "basura", "2026-13", ""]) assert.doesNotMatch(await get(`/panel?mes=${bad}`), /Estás viendo/, bad);
}));

test("Casas: dice quién está al día y quién debe, con el botón para cobrar, y se puede buscar", () => withServer(async (s) => {
  twoMonths(s);
  const { cookie } = await signIn(s.base, "marta@ejemplo.com", "clave-de-marta");
  const page = await (await fetch(`${s.base}/panel/casas`, { headers: { cookie } })).text();
  assert.match(page, /1 con deuda|2 con deuda/);
  const row = (html, name) => html.split('<li class="house-row"').find((r) => r.includes(name));
  assert.match(row(page, "Sandra Duque Arias"), /Debe 2 meses/);
  assert.match(row(page, "Sandra Duque Arias"), /Registrar pago/);
  assert.match(row(page, "Diana Pérez"), /Pendiente/);
  s.A.payments.recordManual({ houseId: s.a14.house.id, dueIds: s.A.dues.listPending().filter((d) => d.houseId === s.a14.house.id).map((d) => d.id), method: "cash" });
  const after = await (await fetch(`${s.base}/panel/casas`, { headers: { cookie } })).text();
  assert.match(row(after, "Sandra Duque Arias"), /Al día/);
  assert.doesNotMatch(row(after, "Sandra Duque Arias"), /Registrar pago/, "quien no debe nada no tiene botón de cobrar");

  const found = await (await fetch(`${s.base}/panel/casas?q=sandra`, { headers: { cookie } })).text();
  assert.match(found, /Sandra Duque Arias/);
  assert.doesNotMatch(found, /<b>Diana Pérez<\/b>/);
  assert.match(await (await fetch(`${s.base}/panel/casas?q=zzz`, { headers: { cookie } })).text(), /Ninguna casa coincide/);
}));

test("Registrar pago: elegir la casa con un toque, marcar la cuota que se pide o todas, y volver a la lista", () => withServer(async (s) => {
  const { now, before, due } = twoMonths(s);
  const { cookie } = await signIn(s.base, "marta@ejemplo.com", "clave-de-marta");
  const get = async (path) => (await fetch(`${s.base}${path}`, { headers: { cookie } })).text();
  const checked = (html) => (html.match(/name="cuota" value="(du_[a-f0-9]+)"( checked)?/g) ?? []).filter((m) => m.endsWith("checked")).map((m) => m.match(/du_[a-f0-9]+/)[0]);
  const sandra = s.a14.house.id;
  const [old, current] = [due(sandra, before).id, due(sandra, now).id];

  const picker = await get("/panel/pagos/nuevo");
  assert.match(picker, /Escribe para buscar o toca la casa que pagó/);
  assert.doesNotMatch(picker, /<select name="casa"/, "ya no es una lista desplegable");
  assert.match(await get("/panel/pagos/nuevo?q=diana"), /Diana Pérez/);
  assert.doesNotMatch(await get("/panel/pagos/nuevo?q=diana"), /Sandra/);

  assert.deepEqual(checked(await get(`/panel/pagos/nuevo?casa=${sandra}`)), [old], "sin pedir nada, la cuota más antigua");
  assert.deepEqual(checked(await get(`/panel/pagos/nuevo?casa=${sandra}&cuota=${current}`)), [current], "la que pidió el botón de la fila");
  assert.deepEqual(checked(await get(`/panel/pagos/nuevo?casa=${sandra}&todas=1`)).sort(), [old, current].sort(), "marcar todas");
  assert.deepEqual(checked(await get(`/panel/pagos/nuevo?casa=${sandra}&cuota=du_inventada`)), [], "una cuota que no existe no marca nada");
  const form = await get(`/panel/pagos/nuevo?casa=${sandra}`);
  assert.match(form, /Atrasada/, "el mes viejo se marca como atrasado");
  assert.match(form, /Marcar todas \(\$60\.000\)/);
  assert.match(form, /Debe <\/small> <b>\$60\.000|<b>\$60\.000<\/b>/);

  // A house that owes nothing (or another conjunto's) opens the picker, not a form.
  assert.doesNotMatch(await get(`/panel/pagos/nuevo?casa=${s.b01.house.id}`), /name="casa"/);
}));

test("Primeros pasos: aparecen mientras falte lo esencial y desaparecen al tenerlo", () => withServer(async (s) => {
  const { cookie } = await signIn(s.base, "marta@ejemplo.com", "clave-de-marta");
  const fresh = await (await fetch(`${s.base}/panel`, { headers: { cookie } })).text();
  assert.match(fresh, /Primeros pasos/, "todavía no hay ningún pago");
  assert.match(fresh, /Registra el primer pago/);
  assert.match(fresh, /Agrega las casas[\s\S]{0,200}<\/li>/);
  twoMonths(s);
  s.A.payments.recordManual({ houseId: s.a14.house.id, dueIds: [s.A.dues.listPending().find((d) => d.houseId === s.a14.house.id).id], method: "cash" });
  assert.doesNotMatch(await (await fetch(`${s.base}/panel`, { headers: { cookie } })).text(), /Primeros pasos/, "con casas, llave y un pago, ya no estorba");
}));

test("búsqueda al instante: cada lista trae lo que el navegador necesita, y sin JavaScript sigue funcionando la búsqueda del servidor", () => withServer(async (s) => {
  twoMonths(s);
  s.A.payments.record({ externalId: "p_sin_casa", payerName: "Pedro Duque", payerNorm: "PEDRO DUQUE", amountCents: 3_000_000, bank: "nequi", paidAt: new Date().toISOString() });
  const { cookie } = await signIn(s.base, "marta@ejemplo.com", "clave-de-marta");
  const get = async (path) => (await fetch(`${s.base}${path}`, { headers: { cookie } })).text();

  // Registrar pago: the search box is first, focused, and every house is a searchable item with a link Enter can follow.
  const pick = await get("/panel/pagos/nuevo");
  assert.match(pick, /<input type="search" name="q"[^>]*autofocus[^>]*data-live-filter="#lista-pick" data-live-empty="#sin-pick"/);
  assert.match(pick, /<ul class="list stack pick" id="lista-pick">/);
  assert.match(pick, /<li class="debt" data-search="14 Sandra Duque Arias">/);
  assert.match(pick, /<li class="debt" data-search="03 Diana Pérez">/);
  assert.match(pick, /href="\/panel\/pagos\/nuevo\?casa=[^"]+" data-pick>Elegir/);
  assert.match(pick, /<p class="muted" id="sin-pick" hidden>/);

  // Por cobrar and Casas.
  const cobros = await get("/panel/cobros");
  assert.match(cobros, /data-live-filter="#lista-cobros" data-live-empty="#sin-cobros"/);
  assert.match(cobros, /<ul class="list stack debts" id="lista-cobros">/);
  assert.match(cobros, /data-search="14 Sandra Duque Arias"/);
  const casas = await get("/panel/casas");
  assert.match(casas, /data-live-filter="#lista-casas" data-live-empty="#sin-casas"/);
  assert.match(casas, /<li class="house-row" data-search="03 Diana Pérez">/);

  // Por asignar: the search box above the house select starts hidden (it only appears when the script runs).
  const home = await get("/panel");
  assert.match(home, /<input type="search" class="combo-search" hidden data-select-filter="#casa-pg_[a-f0-9]+"/);
  assert.match(home, /<select id="casa-pg_[a-f0-9]+" name="house" required/);
  assert.equal((home.match(/data-select-filter="#(casa-pg_[a-f0-9]+)"/) ?? [])[1], (home.match(/<select id="(casa-pg_[a-f0-9]+)"/) ?? [])[1], "el buscador apunta a su select");

  // The search buttons stay in the HTML (the script hides them); the server still answers ?q= for no-JS browsers.
  assert.match(pick, /data-search-button>Buscar/);
  assert.match(await get("/panel/cobros?q=diana"), /<b>Diana Pérez<\/b>/);
  assert.doesNotMatch(await get("/panel/cobros?q=diana"), /<b>Sandra Duque Arias<\/b>/);
}));

test("búsqueda al instante: sin acentos, sin importar mayúsculas, varias palabras en cualquier orden", async () => {
  const sandbox = {
    document: { addEventListener() {}, querySelectorAll: () => [], querySelector: () => null },
    navigator: {}, location: {}, addEventListener() {},
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL("../public/app.js", import.meta.url), "utf8"), sandbox);
  const { fold, matches } = sandbox.cuotia;

  assert.equal(fold("  Pérez Ñandú  "), "  perez nandu  ");
  assert.equal(fold(null), "");
  const row = "03 Diana Pérez";
  for (const q of ["", "  ", "03", "diana", "DIANA", "perez", "pérez", "dia per", "per dia", "iana", "3 d"]) assert.equal(matches(q, row), true, JSON.stringify(q));
  for (const q of ["sandra", "04", "diana lopez", "pereza", "zzz"]) assert.equal(matches(q, row), false, JSON.stringify(q));
  assert.equal(matches("nandu", "Casa 7 · Familia Ñandú"), true, "la ñ también");
  assert.equal(matches("14", "14 Sandra"), true);
  assert.equal(matches("1", "14 Sandra"), true, "el código se busca por partes: escribir 1 ya muestra la 14");

  // The server (no-JS) and the browser must answer every search the same way.
  const { matchesSearch, foldText } = await import("../src/text.js");
  const texts = ["03 Diana Pérez", "042 Diana Vélez Ñandú", "14 Sandra Duque Arias", "7 Familia O'Brien-Gómez", ""];
  const queries = ["", "  ", "03", "diana", "DIANA", "perez", "pérez", "dia per", "per dia", "nandu", "ñandú", "sandra duque", "duque sandra", "obrien", "o'brien", "gomez", "zzz", "diana lopez", "1", "4 d"];
  for (const t of texts) for (const q of queries) assert.equal(matchesSearch(q, t), matches(q, t), `${JSON.stringify(q)} en ${JSON.stringify(t)}`);
  assert.equal(foldText("  Pérez Ñandú  "), fold("  Pérez Ñandú  "));
});

test("+ Octubre: agregar a una casa un mes que nunca se generó y registrar su pago con su fecha", () => withServer(async (s) => {
  const now = currentPeriod();
  const before = shiftPeriod(now, -1);
  s.A.dues.generate(now); // Cuotia started this month: October was never generated
  const { cookie } = await signIn(s.base, "marta@ejemplo.com", "clave-de-marta");
  const csrf = await csrfOf(s.base, cookie, "/panel/pagos/nuevo");
  const get = async (path) => (await fetch(`${s.base}${path}`, { headers: { cookie } })).text();
  assert.equal(s.A.dues.listForHouse(s.a14.house.id).length, 1);

  // The form offers the months this house has no due for, as one-tap buttons.
  const open = await get(`/panel/pagos/nuevo?casa=${s.a14.house.id}`);
  assert.match(open, /¿Pagó también un mes que no aparece\?/);
  assert.ok(open.includes(`action="/panel/casas/${s.a14.house.id}/mes"`));
  assert.ok(open.includes(`name="mes" value="${before}">+ `), "el botón del mes anterior");
  assert.doesNotMatch(open, new RegExp(`name="mes" value="${now}"`), "el mes en curso ya existe: no se ofrece");

  // Tapping it creates that month for THIS house only and comes back with it ticked.
  const res = await form(`${s.base}/panel/casas/${s.a14.house.id}/mes`, { _csrf: csrf, mes: before }, cookie);
  const target = new URL(res.headers.get("location"), s.base);
  assert.equal(target.pathname, "/panel/pagos/nuevo");
  assert.equal(target.searchParams.get("casa"), s.a14.house.id);
  assert.equal(target.searchParams.get("m"), "mesok");
  const created = s.A.dues.listForHouse(s.a14.house.id).find((d) => d.period === before);
  assert.deepEqual(target.searchParams.getAll("cuota"), [created.id]);
  assert.equal(s.A.dues.listForHouse(s.a03.house.id).length, 1, "Diana no recibió octubre");
  assert.equal(s.B.dues.listByPeriod(before).length, 0);

  const ready = await get(`${target.pathname}${target.search}`);
  assert.match(ready, /Mes agregado y marcado/);
  assert.match(ready, new RegExp(`value="${created.id}" checked`), "octubre ya viene marcado");
  assert.doesNotMatch(ready, new RegExp(`name="mes" value="${before}"`), "ya no se ofrece agregarlo otra vez");
  assert.match(ready, /Atrasada/);

  // Pay October with its real date: it lands in October, the house now owes only this month.
  const pay = new URLSearchParams({ _csrf: csrf, casa: s.a14.house.id, medio: "cash", fecha: `${before}-05` });
  pay.append("cuota", created.id);
  assert.match((await post(`${s.base}/panel/pagos/nuevo`, pay, { ...FORM, cookie })).headers.get("location"), /m=manual/);
  assert.equal(s.A.payments.list({ period: before }).total, 1, "el pago cae en octubre, no en este mes");
  assert.deepEqual(s.A.dues.listPending().filter((d) => d.houseId === s.a14.house.id).map((d) => d.period), [now]);
  assert.ok((await get(`/panel?mes=${before}`)).includes("Pagado"), "el mes ya se puede mirar en el Resumen");

  // Guards: future months, far-past months, garbage, someone else's house, no token.
  for (const bad of [shiftPeriod(now, 1), shiftPeriod(now, -25), "2026-13", "octubre", ""]) {
    assert.match((await form(`${s.base}/panel/casas/${s.a03.house.id}/mes`, { _csrf: csrf, mes: bad }, cookie)).headers.get("location"), /m=mesbad/, JSON.stringify(bad));
  }
  assert.match((await form(`${s.base}/panel/casas/${s.b01.house.id}/mes`, { _csrf: csrf, mes: before }, cookie)).headers.get("location"), /m=err/);
  assert.equal((await form(`${s.base}/panel/casas/${s.a03.house.id}/mes`, { mes: before }, cookie)).status, 403);
  assert.equal(s.A.dues.listForHouse(s.a03.house.id).length, 1, "ningún intento fallido creó nada");
  assert.equal(s.B.dues.listForHouse(s.b01.house.id).length, 0);
}));

test("agregar un mes anterior para todas las casas desde el Resumen", () => withServer(async (s) => {
  const now = currentPeriod();
  const before = shiftPeriod(now, -1);
  s.A.dues.generate(now);
  s.A.houses.setActive(s.a03.house.id, false);
  const { cookie } = await signIn(s.base, "marta@ejemplo.com", "clave-de-marta");
  const csrf = await csrfOf(s.base, cookie, "/panel");
  const page = await (await fetch(`${s.base}/panel`, { headers: { cookie } })).text();
  assert.match(page, /¿Falta un mes anterior \(por ejemplo octubre\)\?/);
  assert.ok(page.includes(`name="mes" value="${before}">+ `));
  assert.doesNotMatch(page, new RegExp(`name="mes" value="${now}"`), "el mes en curso no se ofrece");

  const first = await form(`${s.base}/panel/cuotas/generar`, { _csrf: csrf, mes: before }, cookie);
  assert.equal(first.headers.get("location"), `/panel?mes=${before}&m=gen&n=1`, "solo la casa activa");
  assert.equal(s.A.dues.listByPeriod(before).length, 1);
  assert.equal(s.B.dues.listByPeriod(before).length, 0, "el otro conjunto no se toca");
  assert.equal((await form(`${s.base}/panel/cuotas/generar`, { _csrf: csrf, mes: before }, cookie)).headers.get("location"), `/panel?mes=${before}&m=gen&n=0`, "repetirlo no duplica");

  // The new month is now in the selector, and who didn't pay it shows up as overdue.
  assert.ok((await (await fetch(`${s.base}/panel`, { headers: { cookie } })).text()).includes(`href="/panel?mes=${before}"`));
  const debts = await (await fetch(`${s.base}/panel/cobros?f=atrasadas`, { headers: { cookie } })).text();
  assert.match(debts, /Sandra Duque Arias/);
  assert.doesNotMatch(debts, /Diana Pérez/, "la casa desactivada no debe nada");

  for (const bad of [shiftPeriod(now, 1), shiftPeriod(now, -25), "basura"]) {
    assert.equal((await form(`${s.base}/panel/cuotas/generar`, { _csrf: csrf, mes: bad }, cookie)).headers.get("location"), "/panel?m=mesbad", bad);
  }
  assert.match((await form(`${s.base}/panel/cuotas/generar`, { _csrf: csrf }, cookie)).headers.get("location"), /^\/panel\?m=gen&n=0$/, "sin mes = el actual");
  assert.equal((await form(`${s.base}/panel/cuotas/generar`, { mes: before }, cookie)).status, 403);
}));

test("sin JavaScript la búsqueda del servidor también ignora acentos y acepta varias palabras", () => withServer(async (s) => {
  s.A.houses.update(s.a14.house.id, { code: "14", residentName: "Sandra Ñandú Duque", phone: null });
  s.A.dues.generate(currentPeriod());
  const { cookie } = await signIn(s.base, "marta@ejemplo.com", "clave-de-marta");
  const names = (html) => ["Sandra Ñandú Duque", "Diana Pérez"].filter((n) => html.includes(n));
  for (const path of ["/panel/cobros", "/panel/casas", "/panel/pagos/nuevo"]) {
    const find = async (q) => names(await (await fetch(`${s.base}${path}?q=${encodeURIComponent(q)}`, { headers: { cookie } })).text());
    assert.deepEqual(await find("nandu"), ["Sandra Ñandú Duque"], `${path} nandu`);
    assert.deepEqual(await find("duque sandra"), ["Sandra Ñandú Duque"], `${path} palabras en otro orden`);
    assert.deepEqual(await find("PEREZ"), ["Diana Pérez"], `${path} PEREZ`);
    assert.deepEqual(await find("zzz"), [], `${path} zzz`);
  }
}));

test("fechas de pago: se guardan por conjunto, se validan y el residente las ve", () => withServer(async (s) => {
  const { cookie } = await signIn(s.base, "marta@ejemplo.com", "clave-de-marta");
  const csrf = await csrfOf(s.base, cookie, "/panel/ajustes");
  const save = (fields) => form(`${s.base}/panel/ajustes/fechas`, { _csrf: csrf, ...fields }, cookie);

  assert.match((await save({ desde: "1", hasta: "10" })).headers.get("location"), /m=fechas$/);
  const tenants = s.store.tenants;
  assert.deepEqual([tenants.get(s.a.id).openDay, tenants.get(s.a.id).dueDay], [1, 10]);
  assert.deepEqual([tenants.get(s.b.id).openDay, tenants.get(s.b.id).dueDay], [null, null], "el otro conjunto no cambia");

  const ajustes = await (await fetch(`${s.base}/panel/ajustes`, { headers: { cookie } })).text();
  assert.match(ajustes, /name="hasta"[^>]*value="10"/);
  s.A.dues.generate(currentPeriod());
  s.B.dues.generate(currentPeriod());
  const resident = await (await fetch(`${s.base}/r/${s.a14.accessToken}`)).text();
  assert.match(resident, /Paga del 1 al 10 de /);
  assert.doesNotMatch(await (await fetch(`${s.base}/r/${s.b01.accessToken}`)).text(), /Paga del/);

  for (const bad of [{ desde: "11", hasta: "10" }, { desde: "0", hasta: "10" }, { desde: "1", hasta: "29" }, { desde: "x", hasta: "5" }, { desde: "1.5", hasta: "5" }]) {
    assert.match((await save(bad)).headers.get("location"), /m=fechasbad/, JSON.stringify(bad));
  }
  assert.equal(tenants.get(s.a.id).dueDay, 10, "los intentos malos no cambiaron nada");
  assert.equal((await form(`${s.base}/panel/ajustes/fechas`, { desde: "2", hasta: "3" }, cookie)).status, 403, "sin token no se guarda");

  assert.match((await save({ desde: "", hasta: "" })).headers.get("location"), /m=fechas$/);
  assert.equal(tenants.get(s.a.id).dueDay, null, "vacío = sin fechas");
}));

const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("imagen de prueba")]);
const uploadProof = (s, token, bytes, { name = "foto.png", type = "image/png", nota = "", headers = {} } = {}) => {
  const fd = new FormData();
  fd.append("nota", nota);
  fd.append("archivo", new Blob([bytes], { type }), name);
  return fetch(`${s.base}/r/${token}/comprobante`, { method: "POST", body: fd, redirect: "manual", headers });
};

test("comprobante: el residente lo sube, el tesorero lo ve y lo confirma al registrar el pago", () => withServer(async (s) => {
  s.A.dues.generate(currentPeriod());
  s.B.dues.generate(currentPeriod());
  const page = await (await fetch(`${s.base}/r/${s.a14.accessToken}/comprobante`)).text();
  assert.match(page, /enctype="multipart\/form-data"/);
  assert.doesNotMatch(page, /http-equiv="refresh"/, "sin refresco: borraría el archivo elegido");
  assert.match(await (await fetch(`${s.base}/r/${s.a14.accessToken}/pagar`)).text(), /Subir comprobante/);

  // Not a photo or PDF (HTML, SVG), empty and missing files are refused; nothing is stored.
  assert.equal((await uploadProof(s, s.a14.accessToken, "<script>alert(1)</script>", { name: "x.png", type: "image/png" })).status, 400);
  assert.equal((await uploadProof(s, s.a14.accessToken, "<svg></svg>", { name: "x.svg", type: "image/svg+xml" })).status, 400);
  assert.equal((await uploadProof(s, s.a14.accessToken, Buffer.alloc(0))).status, 400);
  assert.equal((await uploadProof(s, s.a14.accessToken, Buffer.concat([PNG_BYTES, Buffer.alloc(5 * 1024 * 1024)]))).status, 413, "más de 5 MB");
  assert.equal(s.A.proofs.countPending(), 0);
  assert.equal((await uploadProof(s, s.a14.accessToken, PNG_BYTES, { headers: { origin: "https://malo.example" } })).status, 403);
  assert.equal((await uploadProof(s, "x".repeat(30), PNG_BYTES)).status, 404);

  const ok = await uploadProof(s, s.a14.accessToken, PNG_BYTES, { nota: "Pagué por Nequi" });
  assert.equal(ok.status, 303);
  assert.match(ok.headers.get("location"), /\/comprobante\?m=enviado$/);
  assert.equal(s.A.proofs.countPending(), 1);
  assert.equal(s.B.proofs.countPending(), 0, "el otro conjunto no lo tiene");
  assert.match(await (await fetch(`${s.base}/r/${s.a14.accessToken}`)).text(), /está en revisión/);

  // The treasurer sees it, with the file served locked down.
  const { cookie } = await signIn(s.base, "marta@ejemplo.com", "clave-de-marta");
  const panelHtml = await (await fetch(`${s.base}/panel`, { headers: { cookie } })).text();
  assert.match(panelHtml, /Comprobantes por revisar/);
  assert.match(panelHtml, /Pagué por Nequi/);
  const [pf] = s.A.proofs.listPending();
  const file = await fetch(`${s.base}/panel/comprobantes/${pf.id}/archivo`, { headers: { cookie } });
  assert.equal(file.status, 200);
  assert.equal(file.headers.get("content-type"), "image/png");
  assert.equal(file.headers.get("x-content-type-options"), "nosniff");
  assert.match(file.headers.get("content-security-policy"), /default-src 'none'/);
  assert.ok(Buffer.from(await file.arrayBuffer()).equals(PNG_BYTES));
  const anon = await fetch(`${s.base}/panel/comprobantes/${pf.id}/archivo`, { redirect: "manual" });
  assert.equal(anon.headers.get("location"), "/login", "sin sesión no hay archivo");

  // The other conjunto's treasurer can neither see nor reject it.
  const other = await signIn(s.base, "luis@ejemplo.com", "clave-de-luis");
  assert.equal((await fetch(`${s.base}/panel/comprobantes/${pf.id}/archivo`, { headers: { cookie: other.cookie } })).status, 404);
  const otherCsrf = await csrfOf(s.base, other.cookie, "/panel/ajustes");
  const bad = await form(`${s.base}/panel/comprobantes/${pf.id}/rechazar`, { _csrf: otherCsrf }, other.cookie);
  assert.ok([302, 303, 404, 500].includes(bad.status));
  assert.equal(s.A.proofs.countPending(), 1, "no lo rechazó");

  // Recording the payment with the proof attached accepts it; undoing the payment puts it back in the queue.
  const csrf = await csrfOf(s.base, cookie, "/panel/pagos/nuevo");
  const form1 = await (await fetch(`${s.base}/panel/pagos/nuevo?casa=${s.a14.house.id}&comprobante=${pf.id}`, { headers: { cookie } })).text();
  assert.ok(form1.includes(`name="comprobante" value="${pf.id}"`));
  const due = s.A.dues.listForHouse(s.a14.house.id)[0];
  const pay = new URLSearchParams({ _csrf: csrf, casa: s.a14.house.id, medio: "transfer", fecha: `${currentPeriod()}-01`, comprobante: pf.id });
  pay.append("cuota", due.id);
  const paid = await post(`${s.base}/panel/pagos/nuevo`, pay, { ...FORM, cookie });
  assert.match(paid.headers.get("location"), /m=manual$/);
  assert.equal(s.A.proofs.meta(pf.id).status, "accepted");
  const paymentId = s.A.proofs.meta(pf.id).paymentId;
  assert.match(await (await fetch(`${s.base}/panel/pagos`, { headers: { cookie } })).text(), /Ver comprobante/);

  await form(`${s.base}/panel/pagos/${paymentId}/deshacer`, { _csrf: csrf }, cookie);
  assert.equal(s.A.proofs.meta(pf.id).status, "pending", "al deshacer el pago, el comprobante vuelve a la bandeja");

  // Rejecting one also tells the resident.
  assert.match((await form(`${s.base}/panel/comprobantes/${pf.id}/rechazar`, { _csrf: csrf }, cookie)).headers.get("location"), /m=comprech/);
  assert.equal(s.A.proofs.meta(pf.id).status, "rejected");
  assert.match(await (await fetch(`${s.base}/r/${s.a14.accessToken}`)).text(), /no pudo confirmar/);

  // A proof can't back a payment of another house.
  const again = s.A.proofs.create({ houseId: s.a14.house.id, mime: "image/png", data: PNG_BYTES });
  assert.throws(() => s.A.payments.recordManual({ houseId: s.a03.house.id, dueIds: [s.A.dues.listForHouse(s.a03.house.id)[0].id], proofId: again.id }), /comprobante/);
  assert.throws(() => s.B.proofs.create({ houseId: s.a14.house.id, mime: "image/png", data: PNG_BYTES }), /no existe|otro conjunto|casa/i);
  for (let i = 0; i < 3; i++) try { s.A.proofs.create({ houseId: s.a14.house.id, mime: "image/png", data: PNG_BYTES }); } catch {}
  assert.throws(() => s.A.proofs.create({ houseId: s.a14.house.id, mime: "image/png", data: PNG_BYTES }), /esperando revisión/);
}));

test("equipo: el tesorero invita, la otra persona crea su cuenta con el enlace y entra con su propio 2FA", () => withServer(async (s) => {
  const { cookie } = await signIn(s.base, "marta@ejemplo.com", "clave-de-marta");
  const csrf = await csrfOf(s.base, cookie, "/panel/ajustes");
  assert.match(await (await fetch(`${s.base}/panel/ajustes`, { headers: { cookie } })).text(), /<h2>Equipo<\/h2>/);

  // Bad and taken emails are refused.
  assert.match((await form(`${s.base}/panel/equipo/invitar`, { _csrf: csrf, correo: "nada" }, cookie)).headers.get("location"), /m=eqbad/);
  assert.match((await form(`${s.base}/panel/equipo/invitar`, { _csrf: csrf, correo: "luis@ejemplo.com" }, cookie)).headers.get("location"), /m=eqexiste/);
  assert.equal((await form(`${s.base}/panel/equipo/invitar`, { correo: "pedro@ejemplo.com" }, cookie)).status, 403, "sin token no invita");

  const res = await form(`${s.base}/panel/equipo/invitar`, { _csrf: csrf, correo: "pedro@ejemplo.com", nombre: "Pedro Gómez" }, cookie);
  assert.equal(res.status, 200);
  const link = /http:\/\/localhost:3000(\/invitacion\/[A-Za-z0-9_-]+)/.exec(await res.text())[1];

  // The link is public but only works once and only for what it says.
  assert.equal((await fetch(`${s.base}/invitacion/${"x".repeat(30)}`)).status, 404);
  const open = await (await fetch(`${s.base}${link}`)).text();
  assert.match(open, /Te invitaron a Jardines de Ibiza/);
  assert.match(open, /value="pedro@ejemplo.com" readonly/);
  assert.equal((await form(`${s.base}${link}`, { nombre: "Pedro", clave: "corta", clave2: "corta" })).status, 400);
  assert.equal((await form(`${s.base}${link}`, { nombre: "Pedro", clave: "una-clave-larga-1", clave2: "otra-distinta-22" })).status, 400);
  const done = await form(`${s.base}${link}`, { nombre: "Pedro Gómez", clave: "clave-de-pedro-1", clave2: "clave-de-pedro-1" });
  assert.match(done.headers.get("location"), /\/login\?m=invitado/);
  assert.equal((await fetch(`${s.base}${link}`)).status, 404, "ya se usó");

  // He signs in like anyone: password, then he must enroll his own 2-step code; he lands in HIS conjunto only.
  const pedro = await signIn(s.base, "pedro@ejemplo.com", "clave-de-pedro-1");
  const panelHtml = await (await fetch(`${s.base}/panel/ajustes`, { headers: { cookie: pedro.cookie } })).text();
  assert.match(panelHtml, /Jardines de Ibiza/);
  assert.doesNotMatch(panelHtml, /Los Robles/);
  assert.match(panelHtml, /Pedro Gómez/);

  // Removing him signs him out and keeps the data; he can't remove himself; Luis (other conjunto) can't touch him.
  const pedroId = s.store.users.byEmail("pedro@ejemplo.com").id;
  const other = await signIn(s.base, "luis@ejemplo.com", "clave-de-luis");
  const otherCsrf = await csrfOf(s.base, other.cookie, "/panel/ajustes");
  assert.match((await form(`${s.base}/panel/equipo/${pedroId}/quitar`, { _csrf: otherCsrf }, other.cookie)).headers.get("location"), /m=equltimo/);
  assert.ok(s.store.users.byEmail("pedro@ejemplo.com"), "Luis no pudo quitarlo");
  const own = s.store.users.byEmail("marta@ejemplo.com").id;
  assert.match((await form(`${s.base}/panel/equipo/${own}/quitar`, { _csrf: csrf }, cookie)).headers.get("location"), /m=eqyo/);
  assert.match((await form(`${s.base}/panel/equipo/${pedroId}/quitar`, { _csrf: csrf }, cookie)).headers.get("location"), /m=eqquit/);
  assert.equal(s.store.users.byEmail("pedro@ejemplo.com"), null);
  assert.equal((await fetch(`${s.base}/panel`, { headers: { cookie: pedro.cookie }, redirect: "manual" })).headers.get("location"), "/login");
}));

test("cómo se confirman los pagos: el tesorero elige manual o automático y el residente lee el mensaje que corresponde", () => withServer(async (s) => {
  // This conjunto HAS a pagoradar secret saved, yet the treasurer registers payments by hand.
  s.A.dues.generate(currentPeriod());
  const { cookie } = await signIn(s.base, "marta@ejemplo.com", "clave-de-marta");
  const csrf = await csrfOf(s.base, cookie, "/panel/ajustes");
  const pay = async () => (await fetch(`${s.base}/r/${s.a14.accessToken}/pagar`)).text();

  assert.equal(s.store.tenants.get(s.a.id).payMode, "auto", "sin elegir nada, un secreto guardado significa automático");
  assert.match(await pay(), /cuando el banco lo confirme/);

  assert.match((await form(`${s.base}/panel/ajustes/modo`, { _csrf: csrf, modo: "manual" }, cookie)).headers.get("location"), /m=modo$/);
  const manual = await pay();
  assert.doesNotMatch(manual, /cuando el banco lo confirme|Esperando tu pago/);
  assert.match(manual, /Después de pagar/);
  assert.match(manual, /cuando el tesorero registre tu pago/);
  assert.match(await (await fetch(`${s.base}/panel/ajustes`, { headers: { cookie } })).text(), /value="manual" checked/);
  assert.equal(s.store.tenants.get(s.b.id).payMode, "auto", "el otro conjunto no cambió");

  assert.match((await form(`${s.base}/panel/ajustes/modo`, { _csrf: csrf, modo: "raro" }, cookie)).headers.get("location"), /m=modobad/);
  assert.equal(s.store.tenants.get(s.a.id).payMode, "manual");
  assert.equal((await form(`${s.base}/panel/ajustes/modo`, { modo: "auto" }, cookie)).status, 403);

  await form(`${s.base}/panel/ajustes/modo`, { _csrf: csrf, modo: "auto" }, cookie);
  assert.match(await pay(), /cuando el banco lo confirme/);
}));
