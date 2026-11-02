import test from "node:test";
import assert from "node:assert/strict";
import { AttemptLimiter, hashPassword, signPagoradarBody, verifyPagoradarSignature, verifyPassword } from "../src/security.js";
import { namesMatch, normalizeName, peso } from "../src/text.js";

test("la contraseña se verifica y no se guarda en claro", async () => {
  const h = await hashPassword("clave-larga-123");
  assert.ok(!h.includes("clave-larga-123"));
  assert.equal(await verifyPassword("clave-larga-123", h), true);
  assert.equal(await verifyPassword("otra", h), false);
  assert.equal(await verifyPassword("x", "basura"), false);
});

test("firma del webhook: válida, alterada, vencida y sin secreto", () => {
  const body = '{"type":"payment.received"}';
  const now = Date.now();
  const t = Math.floor(now / 1000);
  const header = signPagoradarBody(body, "s3cret", t);
  assert.equal(verifyPagoradarSignature(body, header, "s3cret", { now }), true);
  assert.equal(verifyPagoradarSignature(body + " ", header, "s3cret", { now }), false, "cuerpo alterado");
  assert.equal(verifyPagoradarSignature(body, header, "otro", { now }), false, "secreto distinto");
  assert.equal(verifyPagoradarSignature(body, header, "s3cret", { now: now + 10 * 60_000 }), false, "vencida");
  assert.equal(verifyPagoradarSignature(body, undefined, "s3cret", { now }), false);
  assert.equal(verifyPagoradarSignature(body, header, "", { now }), false);
});

test("limitador de intentos", () => {
  const l = new AttemptLimiter({ max: 3, windowMs: 1000 });
  for (let i = 0; i < 3; i++) l.fail("k", 0);
  assert.equal(l.blocked("k", 500), true);
  assert.equal(l.blocked("k", 2000), false, "la ventana expira");
  l.fail("k", 2000);
  l.clear("k");
  assert.equal(l.blocked("k", 2000), false);
});

test("nombres y montos", () => {
  assert.equal(normalizeName(" José  Díaz-Pérez "), "JOSE DIAZ PEREZ");
  assert.equal(namesMatch("Sandra Duque Arias", "SANDRA M. DUQUE"), true);
  assert.equal(namesMatch("Sandra Duque Arias", "Camila Herrera"), false);
  assert.equal(namesMatch("Diana", "Diana Pérez"), true, "un solo nombre alcanza si es el único");
  assert.equal(peso(3_000_000), "$30.000");
  assert.equal(peso(135_000_000), "$1.350.000");
});
