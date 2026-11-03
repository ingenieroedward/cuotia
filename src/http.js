const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

class Raw {
  constructor(s) {
    this.s = s;
  }
  toString() {
    return this.s;
  }
}
export const raw = (s) => new Raw(String(s));

const esc = (v) => {
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(esc).join("");
  if (v === null || v === undefined || v === false) return "";
  return String(v).replace(/[&<>"']/g, (c) => ESCAPES[c]);
};

/** Tagged template that escapes every interpolation unless it is itself `html`/`raw()` output. */
export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => {
    out += esc(v) + strings[i + 1];
  });
  return raw(out);
}

const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  // Not "no-referrer": browsers then send `Origin: null` on form posts and our same-origin check would refuse every login.
  // "same-origin" still keeps a resident's /r/<token> link from leaking to other sites.
  "Referrer-Policy": "same-origin",
};

export function send(res, status, body, headers = {}) {
  // A Buffer (a font, say) goes out untouched; anything else is text.
  const payload = Buffer.isBuffer(body) ? body : body instanceof Raw ? body.s : String(body);
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS, ...headers });
  res.end(payload);
}

export function sendJson(res, status, obj, headers = {}) {
  send(res, status, JSON.stringify(obj), { "Content-Type": "application/json; charset=utf-8", ...headers });
}

export function redirect(res, location, headers = {}) {
  res.writeHead(303, { Location: location, "Cache-Control": "no-store", ...SECURITY_HEADERS, ...headers });
  res.end();
}

/** The exact request body as text (the webhook signature covers these bytes). Rejects bodies over `limit`. */
export async function readBody(req, limit = 256 * 1024) {
  return (await readBuffer(req, limit)).toString("utf8");
}

/** The raw request body (an upload). Rejects bodies over `limit` with status 413. */
export async function readBuffer(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Cuerpo demasiado grande"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** A malformed %-sequence (a damaged or hostile cookie) must not crash the request: keep the raw text, it just won't match a session. */
const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = safeDecode(part.slice(i + 1).trim());
  }
  return out;
}

/** Browsers send Origin on form posts; one from another site is refused. No Origin (curl, tests) passes. */
export function sameOrigin(req, publicUrl) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(publicUrl).origin;
  } catch {
    return false;
  }
}
