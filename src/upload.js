/** Proof-of-payment uploads (multipart/form-data) without a library. */

export const MAX_PROOF_BYTES = 5 * 1024 * 1024;

/** What a file really is, judged by its first bytes (never by the name or the type the browser claims). */
export function sniffProof(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (buf.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  return null;
}

/**
 * Parses a multipart/form-data body. Returns `{ fields, files }`: text fields by name, and files by name as
 * `{ filename, data }`. Returns null when the body isn't well-formed multipart.
 */
export function parseMultipart(body, contentType) {
  const m = /^multipart\/form-data;\s*boundary=(?:"([^"]{1,200})"|([^;\s]{1,200}))/i.exec(String(contentType ?? ""));
  if (!m) return null;
  const delimiter = Buffer.from(`--${m[1] ?? m[2]}`);
  const fields = {};
  const files = {};
  let pos = body.indexOf(delimiter);
  if (pos < 0) return null;
  let closed = false;
  while (pos >= 0 && !closed) {
    pos += delimiter.length;
    if (body.subarray(pos, pos + 2).toString("latin1") === "--") { closed = true; break; }
    if (body.subarray(pos, pos + 2).toString("latin1") !== "\r\n") return null;
    pos += 2;
    const headEnd = body.indexOf("\r\n\r\n", pos);
    if (headEnd < 0) return null;
    const head = body.subarray(pos, headEnd).toString("utf8");
    const next = body.indexOf(Buffer.concat([Buffer.from("\r\n"), delimiter]), headEnd + 4);
    if (next < 0) return null;
    const data = body.subarray(headEnd + 4, next);
    const disposition = /^content-disposition:[^\r\n]*$/im.exec(head)?.[0] ?? "";
    const name = /[;\s]name="([^"]{1,100})"/i.exec(disposition)?.[1];
    const filename = /filename="([^"]{0,255})"/i.exec(disposition)?.[1];
    if (name) {
      if (filename !== undefined) files[name] = { filename, data };
      else fields[name] = data.toString("utf8");
    }
    pos = next + 2;
  }
  return closed ? { fields, files } : null;
}
