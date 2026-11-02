import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createApp } from "../src/app.js";
import { hashPassword, signPagoradarBody } from "../src/security.js";
import { currentPeriod } from "../src/text.js";
import { paymentEvent, SECRET, twoConjuntos } from "./fixtures.js";

async function start() {
  const ctx = twoConjuntos();
  const config = { publicUrl: "http://localhost:3000", secureCookies: false, pagoradarWebhookSecret: SECRET };
  await ctx.store.users.create({ tenantId: ctx.a.id, email: "marta@ejemplo.com", passwordHash: await hashPassword("clave-de-marta") });
  await ctx.store.users.create({ tenantId: ctx.b.id, email: "luis@ejemplo.com", passwordHash: await hashPassword("clave-de-luis") });
  const server = createServer(createApp({ config, store: ctx.store }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { ...ctx, base, close: () => server.close() };
}

const post = (url, body, headers = {}) => fetch(url, { method: "POST", body, redirect: "manual", headers, });
async function login(base, email, password) {
  const res = await post(`${base}/login`, new URLSearchParams({ email, password }), { "Content-Type": "application/x-www-form-urlencoded" });
  return { res, cookie: res.headers.get("set-cookie")?.split(";")[0] };
}

test("/health responde y las respuestas llevan cabeceras de seguridad", async () => {
  const s = await start();
  const res = await fetch(`${s.base}/health`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-security-policy"), /default-src 'self'/);
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  s.close();
});

test("webhook: firma inválida 400; firma válida registra el pago", async () => {
  const s = await start();
  s.A.dues.generate(currentPeriod());
  const body = JSON.stringify(paymentEvent({ tenantRef: s.a.id, payerName: "Sandra Duque Arias" }));

  assert.equal((await post(`${s.base}/webhooks/pagoradar`, body, { "Pagoradar-Signature": "t=1,v1=00" })).status, 400);
  assert.equal((await post(`${s.base}/webhooks/pagoradar`, body)).status, 400, "sin firma");
  assert.equal(s.A.summary(currentPeriod()).paidCount, 0);

  const ok = await post(`${s.base}/webhooks/pagoradar`, body, { "Pagoradar-Signature": signPagoradarBody(body, SECRET) });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).status, "assigned");
  assert.equal(s.A.summary(currentPeriod()).paidCount, 1);

  // pagoradar retries: the second delivery is acknowledged but changes nothing.
  const again = await post(`${s.base}/webhooks/pagoradar`, body, { "Pagoradar-Signature": signPagoradarBody(body, SECRET) });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).status, "duplicate");
  s.close();
});

test("el panel exige sesión y solo muestra el conjunto del tesorero", async () => {
  const s = await start();
  const period = currentPeriod();
  s.A.dues.generate(period);
  s.B.dues.generate(period);

  const anon = await fetch(`${s.base}/panel`, { redirect: "manual" });
  assert.equal(anon.status, 303);
  assert.equal(anon.headers.get("location"), "/login");

  const bad = await login(s.base, "marta@ejemplo.com", "mala");
  assert.equal(bad.res.status, 401);

  const { res, cookie } = await login(s.base, "marta@ejemplo.com", "clave-de-marta");
  assert.equal(res.status, 303);
  assert.match(res.headers.get("set-cookie"), /HttpOnly/);
  assert.match(res.headers.get("set-cookie"), /SameSite=Strict/);

  const page = await (await fetch(`${s.base}/panel`, { headers: { cookie } })).text();
  assert.match(page, /Jardines de Ibiza/);
  assert.match(page, /Sandra Duque Arias/);
  assert.doesNotMatch(page, /Carlos Mejía/, "no ve casas de otro conjunto");
  assert.doesNotMatch(page, /Los Robles/);

  const other = await login(s.base, "luis@ejemplo.com", "clave-de-luis");
  const otherPage = await (await fetch(`${s.base}/panel`, { headers: { cookie: other.cookie } })).text();
  assert.match(otherPage, /Los Robles/);
  assert.doesNotMatch(otherPage, /Sandra Duque Arias/);

  await post(`${s.base}/logout`, "", { cookie });
  assert.equal((await fetch(`${s.base}/panel`, { headers: { cookie }, redirect: "manual" })).status, 303, "la sesión cerrada ya no sirve");
  s.close();
});

test("login rechaza formularios de otro sitio", async () => {
  const s = await start();
  const res = await post(`${s.base}/login`, new URLSearchParams({ email: "marta@ejemplo.com", password: "clave-de-marta" }), {
    "Content-Type": "application/x-www-form-urlencoded", Origin: "https://malo.example",
  });
  assert.equal(res.status, 403);
  s.close();
});

test("el residente ve su cuota con su enlace personal y nada más", async () => {
  const s = await start();
  s.A.dues.generate(currentPeriod());
  const page = await (await fetch(`${s.base}/r/${s.a14.accessToken}`)).text();
  assert.match(page, /Casa 14/);
  assert.match(page, /\$30\.000/);
  assert.match(page, /@ibiza/, "muestra la llave Bre-B del conjunto");
  assert.doesNotMatch(page, /Diana/, "no ve a otras casas");

  assert.equal((await fetch(`${s.base}/r/${"x".repeat(32)}`)).status, 404);
  s.close();
});

test("el CSS se sirve y no hay rutas fuera de la lista", async () => {
  const s = await start();
  const css = await fetch(`${s.base}/static/app.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type"), /text\/css/);
  assert.equal((await fetch(`${s.base}/static/../src/store.js`)).status, 404);
  s.close();
});
