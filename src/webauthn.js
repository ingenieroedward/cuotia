/**
 * Passkeys (WebAuthn) without a library: a small CBOR reader, the authenticator-data parser and the two ceremonies
 * (register a credential, check a sign-in). Attestation is not trusted or verified ("none"): we only keep the public key.
 * A passkey sign-in always requires user verification (fingerprint, face or device PIN), so it counts as both login steps.
 */
import { createHash, createPublicKey, timingSafeEqual, verify } from "node:crypto";

export const COSE_ES256 = -7;
export const COSE_RS256 = -257;
export const ALLOWED_ALGS = [COSE_ES256, COSE_RS256];

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

export const b64u = (buf) => Buffer.from(buf).toString("base64url");
export const fromB64u = (s) => Buffer.from(String(s ?? ""), "base64url");
const sha256 = (data) => createHash("sha256").update(data).digest();
const sameBytes = (a, b) => a.length === b.length && timingSafeEqual(a, b);
const sameText = (a, b) => typeof a === "string" && typeof b === "string" && sameBytes(Buffer.from(a), Buffer.from(b));

/** Reads one CBOR item at `pos`: { value, end }. Only what WebAuthn uses (definite lengths, no floats). */
export function readCbor(buf, pos = 0, depth = 0) {
  if (depth > 8 || pos >= buf.length) throw new Error("CBOR inválido");
  const first = buf[pos];
  const major = first >> 5;
  const info = first & 31;
  let p = pos + 1;
  let n = info;
  if (info === 24) { n = buf[p]; p += 1; }
  else if (info === 25) { n = buf.readUInt16BE(p); p += 2; }
  else if (info === 26) { n = buf.readUInt32BE(p); p += 4; }
  else if (info === 27) { const big = buf.readBigUInt64BE(p); if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("CBOR inválido"); n = Number(big); p += 8; }
  else if (info > 27 && major !== 7) throw new Error("CBOR inválido");
  if (major === 0) return { value: n, end: p };
  if (major === 1) return { value: -1 - n, end: p };
  if (major === 2 || major === 3) {
    if (p + n > buf.length) throw new Error("CBOR inválido");
    const slice = buf.subarray(p, p + n);
    return { value: major === 2 ? Buffer.from(slice) : slice.toString("utf8"), end: p + n };
  }
  if (major === 4) {
    const out = [];
    for (let i = 0; i < n; i++) { const r = readCbor(buf, p, depth + 1); out.push(r.value); p = r.end; }
    return { value: out, end: p };
  }
  if (major === 5) {
    const out = new Map();
    for (let i = 0; i < n; i++) {
      const k = readCbor(buf, p, depth + 1); const v = readCbor(buf, k.end, depth + 1);
      out.set(k.value, v.value); p = v.end;
    }
    return { value: out, end: p };
  }
  if (major === 6) return readCbor(buf, p, depth + 1);
  if (major === 7) {
    if (info === 20) return { value: false, end: p };
    if (info === 21) return { value: true, end: p };
    if (info === 22 || info === 23) return { value: null, end: p };
  }
  throw new Error("CBOR inválido");
}

/** rpIdHash(32) flags(1) signCount(4) [aaguid(16) credIdLen(2) credId COSE-key]. */
export function parseAuthData(buf) {
  if (buf.length < 37) throw new Error("authenticatorData inválido");
  const out = { rpIdHash: buf.subarray(0, 32), flags: buf[32], signCount: buf.readUInt32BE(33) };
  if (out.flags & FLAG_AT) {
    if (buf.length < 55) throw new Error("authenticatorData inválido");
    const len = buf.readUInt16BE(53);
    if (len < 1 || len > 1023 || 55 + len >= buf.length) throw new Error("authenticatorData inválido");
    out.credentialId = Buffer.from(buf.subarray(55, 55 + len));
    out.cose = readCbor(buf, 55 + len).value;
  }
  return out;
}

/** A COSE public key (ES256 or RS256) as SPKI DER, the format node:crypto reads back. */
export function coseToSpki(cose) {
  if (!(cose instanceof Map)) throw new Error("Llave pública inválida");
  const kty = cose.get(1);
  const alg = cose.get(3);
  let jwk;
  if (kty === 2 && alg === COSE_ES256 && cose.get(-1) === 1 && cose.get(-2)?.length === 32 && cose.get(-3)?.length === 32) {
    jwk = { kty: "EC", crv: "P-256", x: b64u(cose.get(-2)), y: b64u(cose.get(-3)) };
  } else if (kty === 3 && alg === COSE_RS256 && cose.get(-1)?.length >= 256 && cose.get(-2)?.length >= 1) {
    jwk = { kty: "RSA", n: b64u(cose.get(-1)), e: b64u(cose.get(-2)) };
  } else {
    throw new Error("Tipo de llave no admitido");
  }
  return { alg, spki: createPublicKey({ key: jwk, format: "jwk" }).export({ type: "spki", format: "der" }) };
}

function checkClientData(raw, { type, challenge, origin }) {
  let data;
  try { data = JSON.parse(raw.toString("utf8")); } catch { throw new Error("clientData inválido"); }
  if (data.type !== type) throw new Error("Tipo de operación inesperado");
  if (!sameText(data.challenge, challenge)) throw new Error("El desafío no coincide");
  if (!sameText(data.origin, origin)) throw new Error("El origen no coincide");
  if (data.crossOrigin === true) throw new Error("Origen cruzado no permitido");
}

function checkAuthData(auth, rpId, { needsAttested }) {
  if (!sameBytes(auth.rpIdHash, sha256(rpId))) throw new Error("El dominio no coincide");
  if (!(auth.flags & FLAG_UP)) throw new Error("Falta la presencia del usuario");
  if (!(auth.flags & FLAG_UV)) throw new Error("Falta la verificación del usuario (huella, rostro o PIN)");
  if (needsAttested && !(auth.flags & FLAG_AT)) throw new Error("Falta la credencial");
}

/**
 * Checks what the browser returned when creating a passkey. `response` carries base64url `clientDataJSON` and `attestationObject`.
 * Returns what to store: the credential id, its public key (SPKI, base64url), the algorithm and the signature counter.
 */
export function verifyRegistration({ response, challenge, origin, rpId }) {
  const clientData = fromB64u(response?.clientDataJSON);
  checkClientData(clientData, { type: "webauthn.create", challenge, origin });
  const att = readCbor(fromB64u(response?.attestationObject)).value;
  const authData = att instanceof Map ? att.get("authData") : null;
  if (!Buffer.isBuffer(authData)) throw new Error("attestationObject inválido");
  const auth = parseAuthData(authData);
  checkAuthData(auth, rpId, { needsAttested: true });
  const { alg, spki } = coseToSpki(auth.cose);
  return { credentialId: b64u(auth.credentialId), publicKey: b64u(spki), alg, signCount: auth.signCount };
}

/**
 * Checks a sign-in: the signature over authenticatorData || SHA-256(clientDataJSON) with the stored key. A counter that does
 * not move forward (when both are non-zero) means a cloned authenticator and is refused. Returns the new counter.
 */
export function verifyAssertion({ response, challenge, origin, rpId, publicKey, storedSignCount = 0 }) {
  const clientData = fromB64u(response?.clientDataJSON);
  checkClientData(clientData, { type: "webauthn.get", challenge, origin });
  const authData = fromB64u(response?.authenticatorData);
  const auth = parseAuthData(authData);
  checkAuthData(auth, rpId, { needsAttested: false });
  const key = createPublicKey({ key: fromB64u(publicKey), format: "der", type: "spki" });
  const signed = Buffer.concat([authData, sha256(clientData)]);
  if (!verify("sha256", signed, key, fromB64u(response?.signature))) throw new Error("La firma no es válida");
  if ((auth.signCount !== 0 || storedSignCount !== 0) && auth.signCount <= storedSignCount) throw new Error("El contador retrocedió: posible copia del passkey");
  return { signCount: auth.signCount };
}
