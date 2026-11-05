/**
 * Web Push without a library: VAPID (RFC 8292) + payload encryption aes128gcm (RFC 8291), only node:crypto.
 * Browsers' push services (Google, Mozilla, Apple, Microsoft) deliver the encrypted message to the installed app.
 */
import { createECDH, createHmac, createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, hkdfSync, randomBytes, sign } from "node:crypto";

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const fromB64u = (s) => Buffer.from(String(s), "base64url");

/** A fresh VAPID key pair: the public key is the 65-byte uncompressed point, both base64url. */
export function newVapidKeys() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

/** Push services we are willing to call. The endpoint is chosen by the browser, so anything else is refused (no SSRF). */
const PUSH_HOSTS = [/(^|\.)googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];
export function validEndpoint(endpoint) {
  try {
    const u = new URL(String(endpoint));
    return u.protocol === "https:" && !u.port && endpoint.length <= 600 && PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}
/** A browser subscription's keys: p256dh is a 65-byte uncompressed point, auth 16 bytes. */
export function validKeys(p256dh, auth) {
  const k = fromB64u(p256dh);
  return k.length === 65 && k[0] === 4 && fromB64u(auth).length === 16;
}

/** The `Authorization` header that proves the sender: an ES256 JWT for the push service's origin. */
export function vapidHeader(endpoint, { publicKey, privateKey }, subject, now = Date.now()) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const pub = fromB64u(publicKey);
  const key = createPrivateKey({
    key: { kty: "EC", crv: "P-256", d: privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: "jwk",
  });
  const signature = sign("sha256", Buffer.from(`${head}.${claims}`), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${head}.${claims}.${b64u(signature)}, k=${publicKey}`;
}

/** RFC 8291 §3: encrypts `payload` for the subscription. `ephemeral` and `salt` are only fixed in tests. */
export function encryptPayload(payload, { p256dh, auth }, { ephemeral, salt } = {}) {
  const ua = fromB64u(p256dh);
  const authSecret = fromB64u(auth);
  const as = createECDH("prime256v1");
  if (ephemeral) as.setPrivateKey(fromB64u(ephemeral)); else as.generateKeys();
  const asPublic = as.getPublicKey();
  const shared = as.computeSecret(ua);
  const saltBuf = salt ? fromB64u(salt) : randomBytes(16);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), ua, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, saltBuf, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, saltBuf, Buffer.from("Content-Encoding: nonce\0"), 12));
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const record = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  saltBuf.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, record]);
}

/** The receiving side, only to prove in tests that what we encrypt can be read back. */
export function decryptPayload(body, { uaPrivate, uaPublic, auth }) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const record = body.subarray(21 + idlen);
  const ua = createECDH("prime256v1");
  ua.setPrivateKey(fromB64u(uaPrivate));
  const shared = ua.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), fromB64u(uaPublic), asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, fromB64u(auth), keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(record.subarray(record.length - 16));
  const plain = Buffer.concat([d.update(record.subarray(0, record.length - 16)), d.final()]);
  return plain.subarray(0, plain.lastIndexOf(2)).toString("utf8");
}

/**
 * Sends one notification. Resolves `{ ok, gone, status, detail }`: `gone` means the subscription no longer exists (404/410)
 * and should be forgotten; `status` is the push service's HTTP answer (0 = no answer) and `detail` the start of its reply,
 * so a rejection can be explained. Never throws: a failed notification must not break the request that caused it.
 */
export async function sendPush(sub, message, vapid, { subject, fetchFn = fetch, ttl = 24 * 3600 } = {}) {
  try {
    if (!validEndpoint(sub.endpoint)) return { ok: false, gone: true, status: 0, detail: "dirección no permitida" };
    const body = encryptPayload(JSON.stringify(message), sub);
    const res = await fetchFn(sub.endpoint, {
      method: "POST", body,
      headers: {
        Authorization: vapidHeader(sub.endpoint, vapid, subject),
        // "high": these are messages a person is waiting for (a payment confirmed, a reminder). "normal" lets Android hold them
        // back while the phone is idle, which looks like "the notification never arrived".
        "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: String(ttl), Urgency: "high",
      },
      signal: AbortSignal.timeout(8000),
    });
    const ok = res.status >= 200 && res.status < 300;
    let detail = "";
    if (!ok) { try { detail = String(await res.text()).replace(/\s+/g, " ").trim().slice(0, 160); } catch { /* no body */ } }
    return { ok, gone: res.status === 404 || res.status === 410, status: res.status, detail };
  } catch (e) {
    return { ok: false, gone: false, status: 0, detail: String(e?.cause?.code || e?.name || "error").slice(0, 60) };
  }
}
