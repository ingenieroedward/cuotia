import test from "node:test";
import assert from "node:assert/strict";
import { createECDH, createPublicKey, randomBytes, verify } from "node:crypto";
import { decryptPayload, encryptPayload, newVapidKeys, sendPush, validEndpoint, validKeys, vapidHeader } from "../src/webpush.js";

const b64u = (b) => Buffer.from(b).toString("base64url");

test("el cifrado coincide con el ejemplo oficial del estándar (RFC 8291, apéndice A)", () => {
  const body = encryptPayload("When I grow up, I want to be a watermelon",
    { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" },
    { ephemeral: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", salt: "DGv6ra1nlYgDCS1FRnbzlw" });
  assert.equal(body.toString("base64url"),
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");
});

test("lo que se cifra, el destinatario lo puede leer; con otra clave no", () => {
  const ua = createECDH("prime256v1"); ua.generateKeys();
  const auth = b64u(randomBytes(16));
  const sub = { p256dh: b64u(ua.getPublicKey()), auth };
  const text = JSON.stringify({ title: "Comprobante nuevo", body: "La casa 14 subió un comprobante", url: "/panel#comprobantes" });
  const body = encryptPayload(text, sub);
  assert.equal(decryptPayload(body, { uaPrivate: b64u(ua.getPrivateKey()), uaPublic: sub.p256dh, auth }), text);
  const other = createECDH("prime256v1"); other.generateKeys();
  assert.throws(() => decryptPayload(body, { uaPrivate: b64u(other.getPrivateKey()), uaPublic: b64u(other.getPublicKey()), auth }));
});

test("la firma VAPID se verifica con la llave pública y nombra solo el servicio de destino", () => {
  const keys = newVapidKeys();
  const header = vapidHeader("https://fcm.googleapis.com/fcm/send/abc", keys, "https://cuotia.ejemplo.com", Date.parse("2026-11-03T12:00:00Z"));
  const [, t, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  assert.equal(k, keys.publicKey);
  const [head, claims, sig] = t.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(claims, "base64url")), { aud: "https://fcm.googleapis.com", exp: Math.floor(Date.parse("2026-11-03T12:00:00Z") / 1000) + 43200, sub: "https://cuotia.ejemplo.com" });
  const pub = Buffer.from(keys.publicKey, "base64url");
  const publicKey = createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: "jwk" });
  assert.ok(verify("sha256", Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url")));
});

test("solo se llama a los servicios de push conocidos (el navegador elige la dirección, no se confía)", () => {
  for (const ok of ["https://fcm.googleapis.com/fcm/send/x", "https://updates.push.services.mozilla.com/wpush/v2/x", "https://web.push.apple.com/x", "https://wns2-par02p.notify.windows.com/w/?token=x"]) assert.ok(validEndpoint(ok), ok);
  for (const bad of ["http://fcm.googleapis.com/x", "https://127.0.0.1/x", "https://localhost/x", "https://169.254.169.254/latest", "https://evil.example.com/fcm.googleapis.com", "https://fcm.googleapis.com.evil.com/x", "https://fcm.googleapis.com:8443/x", "no es una url", ""]) assert.ok(!validEndpoint(bad), bad);
  const ua = createECDH("prime256v1"); ua.generateKeys();
  assert.ok(validKeys(b64u(ua.getPublicKey()), b64u(randomBytes(16))));
  assert.ok(!validKeys(b64u(randomBytes(65)), b64u(randomBytes(16))), "no empieza con 0x04");
  assert.ok(!validKeys(b64u(ua.getPublicKey()), b64u(randomBytes(8))));
  assert.ok(!validKeys("", ""));
});

test("sendPush: éxito, suscripción vencida (410) y errores de red sin lanzar", async () => {
  const ua = createECDH("prime256v1"); ua.generateKeys();
  const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/x", p256dh: b64u(ua.getPublicKey()), auth: b64u(randomBytes(16)) };
  const keys = newVapidKeys();
  const calls = [];
  const reply = (status) => async (url, init) => { calls.push({ url, init }); return { status }; };
  assert.deepEqual(await sendPush(sub, { title: "x" }, keys, { subject: "https://c.ejemplo.com", fetchFn: reply(201) }), { ok: true, gone: false, status: 201, detail: "" });
  assert.equal(calls[0].init.headers["Content-Encoding"], "aes128gcm");
  assert.match(calls[0].init.headers.Authorization, /^vapid t=.+, k=.+$/);
  assert.deepEqual(await sendPush(sub, { title: "x" }, keys, { subject: "https://c.ejemplo.com", fetchFn: reply(410) }), { ok: false, gone: true, status: 410, detail: "" });
  assert.deepEqual(await sendPush(sub, { title: "x" }, keys, { subject: "https://c.ejemplo.com", fetchFn: reply(500) }), { ok: false, gone: false, status: 500, detail: "" });
  assert.deepEqual(await sendPush(sub, { title: "x" }, keys, { subject: "https://c.ejemplo.com", fetchFn: async () => { throw new Error("sin red"); } }), { ok: false, gone: false, status: 0, detail: "Error" });
  const before = calls.length;
  assert.deepEqual(await sendPush({ ...sub, endpoint: "https://127.0.0.1/x" }, {}, keys, { fetchFn: reply(201) }), { ok: false, gone: true, status: 0, detail: "dirección no permitida" });
  assert.equal(calls.length, before, "a una dirección no permitida no se envía nada");
});

test("sendPush: prioridad alta (que no se retrase con el teléfono en reposo) y explica por qué rechazó el servicio", async () => {
  const ua = createECDH("prime256v1"); ua.generateKeys();
  const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/x", p256dh: b64u(ua.getPublicKey()), auth: b64u(randomBytes(16)) };
  const keys = newVapidKeys();
  let seen;
  const rejects = (status, body) => async (url, init) => { seen = init; return { status, text: async () => body }; };
  const r = await sendPush(sub, { title: "x" }, keys, { subject: "https://c.ejemplo.com", fetchFn: rejects(403, '{"error":  "BadJwtToken"}\n') });
  assert.equal(seen.headers.Urgency, "high");
  assert.equal(seen.headers.TTL, String(24 * 3600));
  assert.deepEqual(r, { ok: false, gone: false, status: 403, detail: '{"error": "BadJwtToken"}' });
  const long = await sendPush(sub, { title: "x" }, keys, { subject: "https://c.ejemplo.com", fetchFn: rejects(400, "x".repeat(900)) });
  assert.equal(long.detail.length, 160, "el detalle se recorta");
});
