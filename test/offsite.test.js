import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { signRequest } from "../src/s3.js";
import { decryptFile, destinationsFromEnv, encryptFile, runOffsiteBackup, testDestinations } from "../src/offsite.js";
import { offsiteDue } from "../src/schedule.js";
import { twoConjuntos } from "./fixtures.js";
import { fakeS3 } from "./fake-s3.js";

const MASTER = "ab".repeat(32);

test("la firma: la solicitud canónica coincide con los dos valores oficiales de Amazon", () => {
  const vanilla = signRequest({ method: "GET", url: "https://example.amazonaws.com/", region: "us-east-1", service: "service", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEi/K7MDENG+bPxRfiCYEXAMPLEKEY", now: new Date("2015-08-30T12:36:00Z"), s3: false });
  assert.equal(vanilla.canonicalHash, "bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63");
  const list = signRequest({ method: "GET", url: "https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J", region: "us-east-1", accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEi/K7MDENG/bPxRfiCYEXAMPLEKEY", now: new Date("2013-05-24T00:00:00Z") });
  assert.equal(list.canonicalHash, "df57d21db20da04d7fa30298dd4488ba3a2b47ca3a489c74750e0f1e7df1b9b7");
  assert.match(list.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.equal(list.headers.host, undefined, "host se firma pero no se envía: lo pone fetch");
});

test("cifrado: ida y vuelta intacta, ilegible por fuera, y cualquier alteración o llave equivocada se detecta", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cuotia-enc-"));
  try {
    const plain = join(dir, "a.db"), sealed = join(dir, "a.db.enc"), back = join(dir, "back.db");
    const data = Buffer.concat([Buffer.from("TEXTO-SECRETO-DE-UN-RESIDENTE "), randomBytes(300_000)]);
    writeFileSync(plain, data);
    await encryptFile(plain, sealed, MASTER);
    const blob = readFileSync(sealed);
    assert.ok(blob.subarray(0, 9).equals(Buffer.from("CUOTIABK1")));
    assert.ok(!blob.includes("TEXTO-SECRETO"), "el nombre no se ve en el archivo cifrado");
    assert.equal(blob.length, data.length + 10 + 12 + 16);
    await decryptFile(sealed, back, MASTER);
    assert.ok(readFileSync(back).equals(data));

    await assert.rejects(decryptFile(sealed, join(dir, "x1.db"), "cd".repeat(32)), /MASTER_KEY/, "otra llave");
    assert.equal(existsSync(join(dir, "x1.db")), false, "no deja un archivo a medias");
    const tampered = Buffer.from(blob); tampered[tampered.length - 100] ^= 1;
    writeFileSync(join(dir, "t.enc"), tampered);
    await assert.rejects(decryptFile(join(dir, "t.enc"), join(dir, "x2.db"), MASTER), /dañado/);
    writeFileSync(join(dir, "n.enc"), "esto no es un respaldo de Cuotia, ni de lejos, nada");
    await assert.rejects(decryptFile(join(dir, "n.enc"), join(dir, "x3.db"), MASTER), /no es un respaldo/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("destinos desde el entorno: completos se usan, incompletos se avisan y nunca se usan a medias", () => {
  const full = (n, extra = {}) => ({ [`BACKUP${n}_NAME`]: `d${n}`, [`BACKUP${n}_ENDPOINT`]: "https://x.r2.cloudflarestorage.com", [`BACKUP${n}_BUCKET`]: "b", [`BACKUP${n}_KEY_ID`]: "k", [`BACKUP${n}_SECRET`]: "s", ...extra });
  assert.deepEqual(destinationsFromEnv({}), { destinations: [], warnings: [] });
  const two = destinationsFromEnv({ ...full(1, { BACKUP1_REGION: "us-west-004", BACKUP1_PREFIX: "/mi carpeta/uno" }), ...full(2) });
  assert.deepEqual(two.destinations.map((d) => [d.name, d.region, d.prefix]), [["d1", "us-west-004", "mi-carpeta/uno/"], ["d2", "auto", "cuotia/"]]);
  const half = destinationsFromEnv({ BACKUP1_ENDPOINT: "https://x", BACKUP1_BUCKET: "b" });
  assert.equal(half.destinations.length, 0);
  assert.match(half.warnings[0], /falta BACKUP1_KEY_ID, BACKUP1_SECRET/);
  assert.match(destinationsFromEnv(full(1, { BACKUP1_ENDPOINT: "http://evil.example.com" })).warnings[0], /https/);
  assert.equal(destinationsFromEnv(full(1, { BACKUP1_ENDPOINT: "http://127.0.0.1:9000" })).destinations.length, 1, "http solo para una máquina local (pruebas)");
});

test("cuándo toca el respaldo: de noche si pasaron 20 h, a cualquier hora si pasaron 36, y ya si nunca hubo", () => {
  const at = (iso) => new Date(iso);
  assert.equal(offsiteDue(null, at("2026-11-03T15:00:00Z")), true);
  assert.equal(offsiteDue("2026-11-03T08:00:00Z", at("2026-11-03T15:00:00Z")), false, "hace 7 horas");
  assert.equal(offsiteDue("2026-11-02T08:00:00Z", at("2026-11-03T15:00:00Z")), false, "pasaron 31 h pero son las 10 a. m.: se espera a la noche");
  assert.equal(offsiteDue("2026-11-02T08:00:00Z", at("2026-11-03T08:00:00Z")), true, "las 3 a. m. de Colombia con 24 h");
  assert.equal(offsiteDue("2026-11-02T08:00:00Z", at("2026-11-03T22:00:00Z")), true, "más de 36 h: se pone al día a cualquier hora");
  assert.equal(offsiteDue("2026-11-04T08:00:00Z", at("2026-11-03T08:00:00Z")), false, "una fecha futura no dispara nada");
});

test("respaldo externo: copia consistente y cifrada a dos nubes, una falla y la otra no se detiene, se conservan solo las últimas y se puede restaurar", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cuotia-off-"));
  const good = await fakeS3();
  const bad = await fakeS3({ bucket: "otro", fail: true });
  try {
    const { store, A, a14 } = twoConjuntos();
    A.houses.update(a14.house.id, { code: "14", residentName: "Sandra Duque Arias", phone: "3001234567" });
    for (const stamp of ["20260101-010101", "20260102-010101", "20260103-010101", "20260104-010101", "20260105-010101"]) good.objects.set(`cuotia/cuotia-${stamp}.db.enc`, Buffer.from("viejo"));
    good.objects.set("cuotia/notas.txt", Buffer.from("no es un respaldo nuestro"));
    const config = { masterKey: MASTER, backupDir: dir, backupKeep: 3, backups: [good.cfg("R2"), bad.cfg("B2")] };

    const status = await runOffsiteBackup({ store, config, now: new Date("2026-11-03T08:00:00Z") });
    assert.deepEqual(status.results.map((r) => [r.name, r.ok]), [["R2", true], ["B2", false]]);
    assert.match(status.results[1].error, /B2: el servicio respondió 500/);
    assert.equal(status.file, "cuotia-20261103-080000.db.enc");
    assert.equal(good.seen.badSignature + good.seen.badHash + bad.seen.badSignature + bad.seen.badHash, 0, "todas las firmas y hashes eran válidos");

    // Retention: the newest 3 backups stay, the older ones go, and what isn't ours is untouched.
    assert.deepEqual([...good.objects.keys()].sort(), ["cuotia/cuotia-20260104-010101.db.enc", "cuotia/cuotia-20260105-010101.db.enc", "cuotia/cuotia-20261103-080000.db.enc", "cuotia/notas.txt"]);
    assert.equal(status.results[0].kept, 3);

    // What was uploaded is ciphertext, and it restores to a real database with the data.
    const sealed = good.objects.get("cuotia/cuotia-20261103-080000.db.enc");
    assert.ok(!sealed.includes("Sandra"), "el nombre no viaja en claro");
    writeFileSync(join(dir, "descargado.db.enc"), sealed);
    await decryptFile(join(dir, "descargado.db.enc"), join(dir, "restaurado.db"), MASTER);
    const restored = new DatabaseSync(join(dir, "restaurado.db"));
    assert.equal(restored.prepare("SELECT resident_name AS n FROM houses WHERE code = '14'").get().n, "Sandra Duque Arias");
    assert.equal(restored.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    restored.close();

    // Nothing is left behind on the server's disk, and the result is remembered.
    assert.deepEqual(readdirSync(join(dir, "offsite")), []);
    assert.equal(store.settings.get("offsite_last_ok"), "2026-11-03T08:00:00.000Z");
    assert.equal(JSON.parse(store.settings.get("offsite_last")).results.length, 2);

    // Without destinations nothing happens; the connection test round-trips a tiny file and cleans up.
    assert.deepEqual(await runOffsiteBackup({ store, config: { ...config, backups: [] } }), { skipped: true, results: [] });
    const tested = await testDestinations({ config });
    assert.deepEqual(tested.map((r) => [r.name, r.ok]), [["R2", true], ["B2", false]]);
    assert.ok(![...good.objects.keys()].some((k) => k.includes("prueba")), "el archivo de prueba se borra");

    // A wrong secret is refused by the (real-style) verifier and reported, not hidden.
    const wrong = await runOffsiteBackup({ store, config: { ...config, backups: [{ ...good.cfg("R2 mala"), secretAccessKey: "otra" }] }, now: new Date("2026-11-04T08:00:00Z") });
    assert.equal(wrong.results[0].ok, false);
    assert.match(wrong.results[0].error, /403/);
    assert.equal(store.settings.get("offsite_last_ok"), "2026-11-03T08:00:00.000Z", "un intento fallido no cuenta como respaldo bueno");
    assert.ok(good.seen.badSignature > 0);
  } finally {
    await good.close(); await bad.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
