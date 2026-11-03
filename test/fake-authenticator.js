import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { b64u } from "../src/webauthn.js";

const sha256 = (d) => createHash("sha256").update(d).digest();

/** A tiny CBOR writer (what an authenticator needs: ints, bytes, text, maps). */
export function cbor(v) {
  const head = (major, n) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
    const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
  };
  if (typeof v === "boolean") return Buffer.from([v ? 0xf5 : 0xf4]);
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === "string") { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]); }
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  throw new Error("tipo no admitido");
}

/**
 * A software passkey. `create` and `get` build exactly what a browser returns, with knobs to forge the bad cases.
 * `alg` is "ES256" (default) or "RS256".
 */
export function fakeAuthenticator({ rpId, origin, alg = "ES256" } = {}) {
  const pair = alg === "RS256"
    ? generateKeyPairSync("rsa", { modulusLength: 2048 })
    : generateKeyPairSync("ec", { namedCurve: "P-256" });
  const credentialId = randomBytes(32);
  let counter = 0;
  const jwk = pair.publicKey.export({ format: "jwk" });
  const cose = alg === "RS256"
    ? new Map([[1, 3], [3, -257], [-1, Buffer.from(jwk.n, "base64url")], [-2, Buffer.from(jwk.e, "base64url")]])
    : new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]]);

  const authData = ({ flags, withCredential = false, rp = rpId, count = counter }) => {
    const head = Buffer.alloc(37);
    sha256(rp).copy(head, 0);
    head[32] = flags;
    head.writeUInt32BE(count, 33);
    if (!withCredential) return head;
    const len = Buffer.alloc(2); len.writeUInt16BE(credentialId.length);
    return Buffer.concat([head, Buffer.alloc(16), len, credentialId, cbor(cose)]);
  };

  return {
    id: b64u(credentialId),
    create({ challenge, o = origin, rp = rpId, flags = 0x45 }) {
      const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge, origin: o, crossOrigin: false }));
      const attestationObject = cbor(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", authData({ flags, withCredential: true, rp })]]));
      return { id: b64u(credentialId), rawId: b64u(credentialId), type: "public-key", response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ["internal"] } };
    },
    get({ challenge, o = origin, rp = rpId, flags = 0x05, count, type = "webauthn.get", key = pair.privateKey, userHandle = null }) {
      counter = count ?? counter + 1;
      const clientDataJSON = Buffer.from(JSON.stringify({ type, challenge, origin: o, crossOrigin: false }));
      const data = authData({ flags, rp });
      const signature = sign("sha256", Buffer.concat([data, sha256(clientDataJSON)]), key);
      return { id: b64u(credentialId), rawId: b64u(credentialId), type: "public-key", response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(data), signature: b64u(signature), userHandle: userHandle ? b64u(userHandle) : null } };
    },
    otherKey: () => (alg === "RS256" ? generateKeyPairSync("rsa", { modulusLength: 2048 }) : generateKeyPairSync("ec", { namedCurve: "P-256" })).privateKey,
  };
}
