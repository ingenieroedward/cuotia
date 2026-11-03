/**
 * A tiny S3 client without libraries: AWS Signature V4 plus the three calls the backups need (put, list, delete).
 * It speaks to any S3-compatible service (Cloudflare R2, Backblaze B2…) in path style: `<endpoint>/<bucket>/<key>`.
 */
import { createHash, createHmac } from "node:crypto";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

const sha256hex = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
// RFC 3986 encoding (what SigV4 asks for): encodeURIComponent plus the characters it leaves alone.
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
export const EMPTY_SHA256 = sha256hex("");

/**
 * Signs a request. Returns the headers to send (`host` is signed but never sent: fetch adds it) and the signature.
 * `s3: false` skips the x-amz-content-sha256 header (only the official test vectors need that).
 */
export function signRequest({ method, url, payloadHash = EMPTY_SHA256, region, service = "s3", accessKeyId, secretAccessKey, now = new Date(), s3 = true }) {
  const u = new URL(url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const headers = { host: u.host, "x-amz-date": amzDate, ...(s3 ? { "x-amz-content-sha256": payloadHash } : {}) };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${String(headers[n]).trim()}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalUri = u.pathname.split("/").map((seg) => enc(decodeURIComponent(seg))).join("/") || "/";
  const canonicalQuery = [...u.searchParams].map(([k, v]) => [enc(k), enc(v)]).sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("&");
  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), service), "aws4_request");
  const signature = createHmac("sha256", key).update(stringToSign).digest("hex");
  const { host: _host, ...send } = headers;
  return { signature, canonicalHash: sha256hex(canonicalRequest), headers: { ...send, authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` } };
}

const objectUrl = (cfg, key = "", query = "") => `${cfg.endpoint.replace(/\/+$/, "")}/${cfg.bucket}${key ? `/${key.split("/").map(enc).join("/")}` : ""}${query ? `?${query}` : ""}`;

async function call(cfg, method, url, { payloadHash = EMPTY_SHA256, headers = {}, body, fetchFn = fetch, timeoutMs = 60_000 } = {}) {
  const { headers: signed } = signRequest({ method, url, payloadHash, region: cfg.region, accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey });
  const res = await fetchFn(url, { method, headers: { ...signed, ...headers }, ...(body ? { body, duplex: "half" } : {}), signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
    throw new Error(`${cfg.name}: el servicio respondió ${res.status}${text ? ` (${text})` : ""}`);
  }
  return res;
}

/** Uploads a file. `payloadHash` is the SHA-256 (hex) of its bytes, computed before so the request is signed in full. */
export async function putFile(cfg, key, file, { size, payloadHash, fetchFn } = {}) {
  await call(cfg, "PUT", objectUrl(cfg, key), {
    payloadHash, fetchFn, timeoutMs: 15 * 60_000,
    headers: { "content-length": String(size), "content-type": "application/octet-stream" },
    body: Readable.toWeb(createReadStream(file)),
  });
}

/** Keys under a prefix (follows the continuation token, at most 10 pages of 1000). */
export async function listKeys(cfg, prefix, { fetchFn } = {}) {
  const keys = [];
  let token = "";
  for (let page = 0; page < 10; page++) {
    const query = `list-type=2&prefix=${enc(prefix)}${token ? `&continuation-token=${enc(token)}` : ""}`;
    const xml = await (await call(cfg, "GET", objectUrl(cfg, "", query), { fetchFn })).text();
    for (const m of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) keys.push(m[1].replaceAll("&amp;", "&"));
    const next = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1];
    if (!next || !/<IsTruncated>true<\/IsTruncated>/.test(xml)) break;
    token = next.replaceAll("&amp;", "&");
  }
  return keys;
}

export async function deleteKey(cfg, key, { fetchFn } = {}) {
  await call(cfg, "DELETE", objectUrl(cfg, key), { fetchFn });
}
