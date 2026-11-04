import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);

export const sha256 = (s) => createHash("sha256").update(s).digest("hex");
/** Constant-time string comparison (hashes first, so lengths don't leak). */
export const safeEqual = (a, b) => timingSafeEqual(createHash("sha256").update(String(a)).digest(), createHash("sha256").update(String(b)).digest());
export const newToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

/** "scrypt$salt$key" (hex). */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyPassword(password, stored) {
  const [kind, saltHex, keyHex] = String(stored).split("$");
  if (kind !== "scrypt" || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, "hex");
  const key = await scrypt(String(password), Buffer.from(saltHex, "hex"), expected.length);
  return key.length === expected.length && timingSafeEqual(key, expected);
}

let dummy;
/** Burns the same time as a real check so an unknown email can't be told apart by speed. */
export async function fakeVerify(password) {
  dummy ??= await hashPassword("no-existe");
  await verifyPassword(password, dummy);
}

/**
 * pagoradar signs `Pagoradar-Signature: t=<unix>,v1=<hex>` with v1 = HMAC-SHA256(secret, "<t>.<body>").
 * Same check as pagoradar's own SDK; the body must be the exact bytes received.
 */
export function verifyPagoradarSignature(rawBody, header, secret, { toleranceSec = 300, now = Date.now() } = {}) {
  const parts = Object.fromEntries(String(header ?? "").split(",").map((p) => p.trim().split("=", 2)));
  const t = Number(parts.t);
  if (!secret || !Number.isFinite(t) || !parts.v1 || Math.abs(now / 1000 - t) > toleranceSec) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex"));
  const given = Buffer.from(parts.v1);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Builds a valid header for `body` (used by tests and local simulations). */
export function signPagoradarBody(body, secret, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
}

/** Blocks guessing: at most `max` failed attempts per key inside `windowMs`. */
export class AttemptLimiter {
  constructor({ max = 5, windowMs = 15 * 60_000 } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
  }
  #recent(key, now) {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    this.hits.set(key, list);
    return list;
  }
  blocked(key, now = Date.now()) {
    return this.#recent(key, now).length >= this.max;
  }
  fail(key, now = Date.now()) {
    this.#recent(key, now).push(now);
  }
  clear(key) {
    this.hits.delete(key);
  }
}

// ---- Encrypting secrets at rest (the TOTP secret) with MASTER_KEY (64 hex chars) ----

const keyBuf = (hex) => {
  if (!/^[0-9a-f]{64}$/i.test(String(hex))) throw new Error("MASTER_KEY debe ser de 64 caracteres hexadecimales (openssl rand -hex 32)");
  return Buffer.from(hex, "hex");
};

/** AES-256-GCM; output "iv.tag.ciphertext" in base64url. */
export function encryptSecret(plain, masterKeyHex) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyBuf(masterKeyHex), iv);
  const data = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString("base64url")).join(".");
}

export function decryptSecret(stored, masterKeyHex) {
  const [iv, tag, data] = String(stored).split(".").map((p) => Buffer.from(p, "base64url"));
  const d = createDecipheriv("aes-256-gcm", keyBuf(masterKeyHex), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString("utf8");
}

// ---- TOTP (RFC 6238: HMAC-SHA1, 6 digits, 30 s), compatible with Google/Microsoft Authenticator, 1Password... ----

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of String(str).toUpperCase().replace(/[\s=-]/g, "")) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error("Base32 inválido");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const newTotpSecret = () => base32Encode(randomBytes(20));
export const totpStep = (now = Date.now()) => Math.floor(now / 1000 / 30);

export function totpCode(secretB32, step = totpStep()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", base32Decode(secretB32)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, "0");
}

/** The step the code belongs to (±1 step of clock drift), or null. */
export function matchTotp(secretB32, code, now = Date.now()) {
  const given = String(code ?? "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(given)) return null;
  const base = totpStep(now);
  for (const step of [base, base - 1, base + 1]) {
    const expected = Buffer.from(totpCode(secretB32, step));
    if (timingSafeEqual(expected, Buffer.from(given))) return step;
  }
  return null;
}

/** Form token tied to the session: an attacker's page can't know it (the cookie is HttpOnly). */
export const csrfToken = (sessionToken) => createHmac("sha256", String(sessionToken)).update("cuotia-csrf").digest("base64url");
export function csrfValid(sessionToken, given) {
  if (!sessionToken || !given) return false;
  const a = Buffer.from(csrfToken(sessionToken));
  const b = Buffer.from(String(given));
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---- Recovery codes: ten single-use codes the person keeps on paper. Only a keyed hash is stored. ----
const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L: they get misread when copied by hand
/** `count` codes like "K7M2P-9XQ4T" (10 characters, about 49 bits each). */
export function newRecoveryCodes(count = 10) {
  const one = () => [5, 5].map((n) => Array.from({ length: n }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]).join("")).join("-");
  return Array.from({ length: count }, one);
}
/** What a person typed, reduced to the 10 characters (case, spaces and dashes don't matter). Null when it can't be a code. */
export function normalizeRecoveryCode(input) {
  const clean = String(input ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return clean.length === 10 && [...clean].every((c) => RECOVERY_ALPHABET.includes(c)) ? clean : null;
}
/** Keyed with MASTER_KEY, so a copy of the database alone can't be used to test guesses. */
export const recoveryHash = (code, masterKeyHex) => createHmac("sha256", Buffer.from(masterKeyHex, "hex")).update(`cuotia-recovery:${code}`).digest("hex");
