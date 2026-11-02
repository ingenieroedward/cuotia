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

import { base32Decode, base32Encode, csrfToken, csrfValid, decryptSecret, encryptSecret, matchTotp, newTotpSecret, totpCode } from "../src/security.js";

test("TOTP: vector del RFC 6238, ventana de ±1 paso y rechazo de basura", () => {
  const secret = base32Encode(Buffer.from("12345678901234567890"));
  assert.equal(totpCode(secret, 1), "287082", "T=59 s del RFC 6238");
  assert.equal(base32Decode(secret).toString(), "12345678901234567890");

  const s = newTotpSecret();
  const now = 1_700_000_000_000;
  const step = Math.floor(now / 30_000);
  assert.equal(matchTotp(s, totpCode(s, step), now), step);
  assert.equal(matchTotp(s, totpCode(s, step - 1), now), step - 1, "reloj atrasado un paso");
  assert.equal(matchTotp(s, totpCode(s, step + 2), now), null, "fuera de la ventana");
  assert.equal(matchTotp(s, "abcdef", now), null);
  assert.equal(matchTotp(s, "", now), null);
  assert.equal(matchTotp(s, ` ${totpCode(s, step).slice(0, 3)} ${totpCode(s, step).slice(3)} `, now), step, "acepta espacios");
});

test("el secreto se cifra con MASTER_KEY y no se puede leer con otra clave", () => {
  const key = "ab".repeat(32);
  const enc = encryptSecret("JBSWY3DPEHPK3PXP", key);
  assert.ok(!enc.includes("JBSWY3DP"));
  assert.equal(decryptSecret(enc, key), "JBSWY3DPEHPK3PXP");
  assert.notEqual(encryptSecret("JBSWY3DPEHPK3PXP", key), enc, "cada cifrado usa un IV nuevo");
  assert.throws(() => decryptSecret(enc, "cd".repeat(32)));
  assert.throws(() => encryptSecret("x", "corta"), /MASTER_KEY/);
});

test("token anti-CSRF atado a la sesión", () => {
  assert.equal(csrfValid("sesion-1", csrfToken("sesion-1")), true);
  assert.equal(csrfValid("sesion-2", csrfToken("sesion-1")), false);
  assert.equal(csrfValid("sesion-1", ""), false);
  assert.equal(csrfValid(undefined, "x"), false);
});

import { bogotaDateTime, csvCell, lastPeriods, periodRange } from "../src/text.js";

test("ayudas de fechas y CSV", () => {
  assert.deepEqual(periodRange("2026-11"), ["2026-11-01T05:00:00.000Z", "2026-12-01T05:00:00.000Z"]);
  assert.equal(bogotaDateTime("2026-11-03T15:22:53Z"), "2026-11-03 10:22");
  assert.equal(bogotaDateTime("2026-12-01T03:00:00Z"), "2026-11-30 22:00");
  assert.deepEqual(lastPeriods("2026-02", 4), ["2026-02", "2026-01", "2025-12", "2025-11"]);
  assert.equal(csvCell('Ana "la" Pérez'), '"Ana ""la"" Pérez"');
  assert.equal(csvCell("=HYPERLINK(\"http://malo\")"), "\"'=HYPERLINK(\"\"http://malo\"\")\"", "una fórmula no se ejecuta en Excel");
  for (const bad of ["+1", "-1", "@x", "\tx"]) assert.ok(csvCell(bad).startsWith(`"'`), bad);
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell(30000), '"30000"');
});

import { loadConfig } from "../src/config.js";
import { safeEqual } from "../src/security.js";
import { slugify } from "../src/text.js";

test("configuración: el token inicial se genera o se fija, y no puede ser débil", () => {
  const env = { MASTER_KEY: "a".repeat(64) };
  const a = loadConfig(env);
  const b = loadConfig(env);
  assert.ok(a.setupToken.length >= 30 && a.setupToken !== b.setupToken, "uno distinto en cada arranque");
  assert.equal(loadConfig({ ...env, SETUP_TOKEN: "fijo-de-16-caracteres" }).setupToken, "fijo-de-16-caracteres");
  assert.ok(loadConfig({ ...env, SETUP_TOKEN: "" }).setupToken.length >= 30, "vacío = generado");
  assert.throws(() => loadConfig({ ...env, SETUP_TOKEN: "corto" }), /al menos 16/);
  assert.throws(() => loadConfig({}), /MASTER_KEY/);
});

test("slugify y comparación segura", () => {
  assert.equal(slugify("Jardines de Ibiza"), "jardines-de-ibiza");
  assert.equal(slugify("  ¡Los Álamos, Etapa 2!  "), "los-alamos-etapa-2");
  assert.equal(slugify("???"), "conjunto");
  assert.ok(slugify("x".repeat(100)).length <= 40);
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
});
