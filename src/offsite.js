/**
 * Off-server backups: a consistent copy of the database (VACUUM INTO), encrypted with a key derived from MASTER_KEY, uploaded to
 * every configured S3-compatible destination (Cloudflare R2, Backblaze B2…). The cloud only ever holds ciphertext: names,
 * phones and payment history are unreadable without MASTER_KEY, which is the same key the owner must already keep safe.
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { backupName, backupTo } from "./backup.js";
import { deleteKey, listKeys, putFile, EMPTY_SHA256 } from "./s3.js";

const MAGIC = Buffer.from("CUOTIABK1\n");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_PATTERN = /cuotia-\d{8}-\d{6}\.db\.enc$/;

const backupKey = (masterKeyHex) => Buffer.from(hkdfSync("sha256", Buffer.from(masterKeyHex, "hex"), Buffer.from("cuotia-backup"), Buffer.from("backup-v1"), 32));

/** Reads a file in one pass and returns its SHA-256 (hex): the upload is signed with it. */
export async function sha256File(file) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

/** AES-256-GCM, streamed: MAGIC + iv + ciphertext + tag. Never loads the whole file in memory. */
export async function encryptFile(src, dest, masterKeyHex) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", backupKey(masterKeyHex), iv);
  const out = createWriteStream(dest);
  out.write(Buffer.concat([MAGIC, iv]));
  await pipeline(createReadStream(src), cipher, out, { end: false });
  out.end(cipher.getAuthTag());
  await new Promise((resolve, reject) => { out.on("finish", resolve); out.on("error", reject); });
}

/** The reverse. Throws if the file was altered or the key is not the one it was made with (the tag does not verify). */
export async function decryptFile(src, dest, masterKeyHex) {
  const size = statSync(src).size;
  if (size < MAGIC.length + IV_BYTES + TAG_BYTES) throw new Error("El archivo no es un respaldo de Cuotia");
  const fh = await open(src, "r");
  let head;
  let tag;
  try {
    head = Buffer.alloc(MAGIC.length + IV_BYTES);
    await fh.read(head, 0, head.length, 0);
    tag = Buffer.alloc(TAG_BYTES);
    await fh.read(tag, 0, TAG_BYTES, size - TAG_BYTES);
  } finally {
    await fh.close();
  }
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("El archivo no es un respaldo de Cuotia");
  const decipher = createDecipheriv("aes-256-gcm", backupKey(masterKeyHex), head.subarray(MAGIC.length));
  decipher.setAuthTag(tag);
  try {
    await pipeline(createReadStream(src, { start: head.length, end: size - TAG_BYTES - 1 }), decipher, createWriteStream(dest));
  } catch {
    rmSync(dest, { force: true });
    throw new Error("No se pudo descifrar: la MASTER_KEY no es la del respaldo o el archivo está dañado");
  }
}

/** Backups configured through BACKUP1_* … BACKUP3_* (see .env.example). A half-filled one is reported, never half-used. */
export function destinationsFromEnv(env = process.env) {
  const destinations = [];
  const warnings = [];
  for (const n of [1, 2, 3]) {
    const get = (k) => (env[`BACKUP${n}_${k}`] ?? "").trim();
    const fields = { endpoint: get("ENDPOINT"), bucket: get("BUCKET"), accessKeyId: get("KEY_ID"), secretAccessKey: get("SECRET") };
    if (!Object.values(fields).some(Boolean) && !get("NAME")) continue;
    const missing = Object.entries({ ENDPOINT: fields.endpoint, BUCKET: fields.bucket, KEY_ID: fields.accessKeyId, SECRET: fields.secretAccessKey }).filter(([, v]) => !v).map(([k]) => `BACKUP${n}_${k}`);
    if (missing.length) { warnings.push(`Respaldo ${n} incompleto: falta ${missing.join(", ")}`); continue; }
    if (!/^https:\/\//.test(fields.endpoint) && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(fields.endpoint)) { warnings.push(`BACKUP${n}_ENDPOINT debe empezar por https://`); continue; }
    const prefix = (get("PREFIX") || "cuotia/").replace(/^\/+/, "").replace(/\/*$/, "/").replace(/[^A-Za-z0-9._/-]/g, "-");
    destinations.push({ name: get("NAME") || `destino ${n}`, region: get("REGION") || "auto", prefix, ...fields });
  }
  return { destinations, warnings };
}

/** The last result, as the operator panel shows it. */
export const lastOffsite = (store) => {
  try { return JSON.parse(store.settings.get("offsite_last") ?? "null"); } catch { return null; }
};

/**
 * One run: copy, encrypt, upload to every destination (a failing one never stops the others), keep only the newest `keep`
 * files in each, remove the temporary files and remember what happened. Never throws.
 */
export async function runOffsiteBackup({ store, config, now = new Date(), fetchFn } = {}) {
  const destinations = config.backups ?? [];
  if (destinations.length === 0) return { skipped: true, results: [] };
  const dir = join(config.backupDir ?? tmpdir(), "offsite");
  const plain = join(dir, backupName(now));
  const sealed = `${plain}.enc`;
  let status;
  try {
    mkdirSync(dir, { recursive: true });
    backupTo(store.db, plain);
    await encryptFile(plain, sealed, config.masterKey);
    rmSync(plain, { force: true });
    const size = statSync(sealed).size;
    const payloadHash = await sha256File(sealed);
    const name = `${backupName(now)}.enc`;
    const results = [];
    for (const dest of destinations) {
      try {
        await putFile(dest, `${dest.prefix}${name}`, sealed, { size, payloadHash, fetchFn });
        const keys = (await listKeys(dest, dest.prefix, { fetchFn })).filter((k) => KEY_PATTERN.test(k)).sort();
        const old = keys.slice(0, Math.max(0, keys.length - Math.max(1, config.backupKeep ?? 30)));
        for (const k of old) await deleteKey(dest, k, { fetchFn });
        results.push({ name: dest.name, ok: true, kept: keys.length - old.length });
      } catch (e) {
        results.push({ name: dest.name, ok: false, error: String(e.message).slice(0, 200) });
      }
    }
    status = { at: now.toISOString(), bytes: size, file: name, results };
  } catch (e) {
    status = { at: now.toISOString(), bytes: 0, file: null, results: destinations.map((d) => ({ name: d.name, ok: false, error: `No se pudo preparar la copia: ${String(e.message).slice(0, 160)}` })) };
  } finally {
    rmSync(plain, { force: true });
    rmSync(sealed, { force: true });
  }
  try {
    store.settings.set("offsite_last", JSON.stringify(status));
    if (status.results.some((r) => r.ok)) store.settings.set("offsite_last_ok", status.at);
  } catch { /* the copy is made; remembering it is a nicety */ }
  return status;
}

/** A real round trip with a tiny object, so the owner learns the keys and the bucket work before relying on them. */
export async function testDestinations({ config, fetchFn, now = new Date() } = {}) {
  const dir = join(config.backupDir ?? tmpdir(), "offsite");
  mkdirSync(dir, { recursive: true });
  const probe = join(dir, `prueba-${now.getTime()}.txt`);
  const results = [];
  try {
    writeFileSync(probe, "prueba de conexión de Cuotia");
    const size = statSync(probe).size;
    const payloadHash = await sha256File(probe);
    for (const dest of config.backups ?? []) {
      const key = `${dest.prefix}prueba-conexion.txt`;
      try {
        await putFile(dest, key, probe, { size, payloadHash, fetchFn });
        await listKeys(dest, dest.prefix, { fetchFn });
        await deleteKey(dest, key, { fetchFn });
        results.push({ name: dest.name, ok: true });
      } catch (e) {
        results.push({ name: dest.name, ok: false, error: String(e.message).slice(0, 200) });
      }
    }
  } finally {
    rmSync(probe, { force: true });
  }
  return results;
}

export { EMPTY_SHA256 };
