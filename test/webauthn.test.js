import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { b64u, readCbor, verifyAssertion, verifyRegistration } from "../src/webauthn.js";
import { cbor, fakeAuthenticator } from "./fake-authenticator.js";

const rpId = "cuotia.ejemplo.com";
const origin = "https://cuotia.ejemplo.com";
const challenge = () => b64u(randomBytes(32));

test("CBOR: lee enteros, texto, bytes, listas y mapas, y rechaza lo mal formado", () => {
  const sample = new Map([["fmt", "none"], [1, 2], [-1, -7], ["datos", [Buffer.from("ab"), 300, 70000]], ["ok", true]]);
  const back = readCbor(cbor(sample)).value;
  assert.equal(back.get("fmt"), "none");
  assert.equal(back.get(-1), -7);
  assert.deepEqual(back.get("datos"), [Buffer.from("ab"), 300, 70000]);
  assert.equal(back.get("ok"), true);
  assert.deepEqual(readCbor(Buffer.from("a26161016162820203", "hex")).value, new Map([["a", 1], ["b", [2, 3]]]), "ejemplo del RFC 8949");
  for (const bad of ["", "ff", "5f", "62616", "a1", "bf"]) assert.throws(() => readCbor(Buffer.from(bad, "hex")), /CBOR inválido|out of range|RangeError/i, bad);
  assert.throws(() => readCbor(Buffer.concat([Buffer.alloc(20, 0x81), Buffer.from([0])])), /CBOR inválido/, "demasiado anidado");
});

for (const alg of ["ES256", "RS256"]) {
  test(`passkey ${alg}: se registra, inicia sesión y detecta cada falsificación`, () => {
    const dev = fakeAuthenticator({ rpId, origin, alg });
    const c1 = challenge();
    const reg = verifyRegistration({ response: dev.create({ challenge: c1 }).response, challenge: c1, origin, rpId });
    assert.equal(reg.credentialId, dev.id);
    assert.equal(reg.alg, alg === "RS256" ? -257 : -7);
    assert.equal(reg.signCount, 0);

    const login = (fields, extra = {}) => verifyAssertion({ response: dev.get(fields).response, challenge: fields.challenge, origin, rpId, publicKey: reg.publicKey, storedSignCount: 0, ...extra });
    const c2 = challenge();
    assert.deepEqual(login({ challenge: c2 }), { signCount: 1 });

    // Each forgery is refused with its own reason.
    assert.throws(() => verifyAssertion({ response: dev.get({ challenge: c2 }).response, challenge: challenge(), origin, rpId, publicKey: reg.publicKey }), /desafío/);
    assert.throws(() => login({ challenge: c2, o: "https://falso.example.com" }), /origen/);
    assert.throws(() => login({ challenge: c2, rp: "otro.ejemplo.com" }), /dominio/);
    assert.throws(() => login({ challenge: c2, flags: 0x01 }), /verificación del usuario/, "sin huella, rostro o PIN");
    assert.throws(() => login({ challenge: c2, flags: 0x04 }), /presencia/);
    assert.throws(() => login({ challenge: c2, type: "webauthn.create" }), /Tipo de operación/);
    assert.throws(() => login({ challenge: c2, key: dev.otherKey() }), /firma/, "firmado por otra llave");
    assert.throws(() => login({ challenge: c2, count: 5 }, { storedSignCount: 9 }), /contador/);
    assert.throws(() => login({ challenge: c2, count: 9 }, { storedSignCount: 9 }), /contador/, "igual tampoco");
    assert.equal(login({ challenge: c2, count: 10 }, { storedSignCount: 9 }).signCount, 10);
    assert.equal(login({ challenge: c2, count: 0 }, { storedSignCount: 0 }).signCount, 0, "los que siempre mandan 0 (iCloud) pasan");

    // The registration is just as strict.
    for (const [fields, why] of [[{ o: "https://falso.example.com" }, /origen/], [{ rp: "otro.ejemplo.com" }, /dominio/], [{ flags: 0x41 }, /verificación/], [{ flags: 0x05 }, /credencial/]]) {
      const c = challenge();
      assert.throws(() => verifyRegistration({ response: dev.create({ challenge: c, ...fields }).response, challenge: c, origin, rpId }), why);
    }
    assert.throws(() => verifyRegistration({ response: dev.create({ challenge: challenge() }).response, challenge: challenge(), origin, rpId }), /desafío/);
  });
}

test("una llave que no es ES256 ni RS256 no se acepta, y el attestationObject dañado tampoco", () => {
  const dev = fakeAuthenticator({ rpId, origin });
  const c = challenge();
  const created = dev.create({ challenge: c });
  assert.throws(() => verifyRegistration({ response: { ...created.response, attestationObject: b64u(Buffer.from("no es cbor")) }, challenge: c, origin, rpId }));
  assert.throws(() => verifyRegistration({ response: { ...created.response, clientDataJSON: b64u(Buffer.from("{rota")) }, challenge: c, origin, rpId }), /clientData/);
  assert.throws(() => verifyRegistration({ response: {}, challenge: c, origin, rpId }));
});
