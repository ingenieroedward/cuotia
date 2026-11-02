import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createApp } from "../src/app.js";
import { encryptSecret, hashPassword, signPagoradarBody, totpCode, totpStep } from "../src/security.js";
import { currentPeriod } from "../src/text.js";
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
  assert.match(page, /Recordar por WhatsApp/);
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
  assert.match(casas, /Casas desactivadas/);
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
  for (const [name, hex] of [["ink", "#0b1b2b"], ["lime", "#c6f25c"], ["ground", "#f3f5f8"], ["surface", "#ffffff"], ["muted", "#566274"], ["line", "#e3e8ee"]]) {
    assert.match(css, new RegExp(`--${name}:\\s*${hex}`), name);
  }
}));

test("importar casas: pega una lista, crea casas con su enlace y sus cuotas, y avisa lo que no pudo", () => withServer(async (s) => {
  const { cookie } = await signIn(s.base, "marta@ejemplo.com", "clave-de-marta");
  const csrf = await csrfOf(s.base, cookie, "/panel/casas/importar");
  assert.ok(csrf);
  assert.match(await (await fetch(`${s.base}/panel/casas/importar`, { headers: { cookie } })).text(), /Importar casas/);
  assert.match(await (await fetch(`${s.base}/panel/casas`, { headers: { cookie } })).text(), /Importar varias casas/);

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
