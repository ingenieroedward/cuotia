import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { signRequest } from "../src/s3.js";

/** A tiny S3 that verifies every signature the way a real one does, and keeps what it is given. */
export async function fakeS3({ accessKeyId = "AKIATEST", secretAccessKey = "secreto-de-prueba", bucket = "cuotia-bucket", fail = false } = {}) {
  const objects = new Map();
  const seen = { badSignature: 0, badHash: 0, requests: 0 };
  const server = createServer(async (req, res) => {
    seen.requests += 1;
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, `http://${req.headers.host}`);
    const auth = /Signature=([0-9a-f]{64})/.exec(req.headers.authorization ?? "")?.[1];
    const date = req.headers["x-amz-date"];
    const now = new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`);
    const expected = signRequest({ method: req.method, url: `http://${req.headers.host}${req.url}`, payloadHash: req.headers["x-amz-content-sha256"], region: "auto", accessKeyId, secretAccessKey, now }).signature;
    if (auth !== expected) { seen.badSignature += 1; res.writeHead(403); return res.end("<Error>SignatureDoesNotMatch</Error>"); }
    if (req.method === "PUT" && createHash("sha256").update(body).digest("hex") !== req.headers["x-amz-content-sha256"]) { seen.badHash += 1; res.writeHead(400); return res.end("bad hash"); }
    if (fail) { res.writeHead(500); return res.end("boom"); }
    const [, b, ...rest] = decodeURIComponent(url.pathname).split("/");
    if (b !== bucket) { res.writeHead(404); return res.end("no bucket"); }
    const key = rest.join("/");
    if (req.method === "PUT") { objects.set(key, body); res.writeHead(200); return res.end(); }
    if (req.method === "DELETE") { objects.delete(key); res.writeHead(204); return res.end(); }
    if (req.method === "GET") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const xml = `<ListBucketResult><IsTruncated>false</IsTruncated>${[...objects.keys()].filter((k) => k.startsWith(prefix)).sort().map((k) => `<Contents><Key>${k}</Key></Contents>`).join("")}</ListBucketResult>`;
      res.writeHead(200, { "content-type": "application/xml" });
      return res.end(xml);
    }
    res.writeHead(405); return res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const cfg = (name) => ({ name, endpoint: `http://127.0.0.1:${server.address().port}`, bucket, region: "auto", prefix: "cuotia/", accessKeyId, secretAccessKey });
  return { objects, seen, cfg, close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); } };
}

