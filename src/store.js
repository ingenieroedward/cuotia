import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MESSAGE_KEYS, validateTemplate } from "./messages.js";
import { MANUAL_LABELS, PAY_KINDS, namesMatch, normalizeName, periodRange } from "./text.js";
import { newToken, sha256 } from "./security.js";

/**
 * One SQLite DB, many conjuntos (tenants). Isolation rule: every query about a conjunto's data goes through
 * `store.forTenant(id)`, which closes over the tenant id, so a handler can't forget the `tenant_id` filter.
 * Only `tenants`, `users`, `sessions` and `residentByToken` are global.
 *
 * Migrations are SQL strings applied in order by PRAGMA user_version. Never edit an earlier one: add the next.
 */
const MIGRATIONS = [
  /* V1 */ `
  CREATE TABLE tenants (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    pay_key TEXT,
    pay_holder TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'tesorero',
    created_at TEXT NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE houses (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    code TEXT NOT NULL,
    resident_name TEXT NOT NULL,
    phone TEXT,
    access_hash TEXT NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    UNIQUE (tenant_id, code)
  );
  CREATE TABLE aliases (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
    name_norm TEXT NOT NULL,
    UNIQUE (tenant_id, house_id, name_norm)
  );
  CREATE INDEX aliases_by_name ON aliases (tenant_id, name_norm);
  CREATE TABLE concepts (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    name TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    active INTEGER NOT NULL DEFAULT 1,
    UNIQUE (tenant_id, name)
  );
  CREATE TABLE payments (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    external_id TEXT NOT NULL UNIQUE,
    payer_name TEXT NOT NULL,
    payer_norm TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    bank TEXT,
    method TEXT,
    paid_at TEXT NOT NULL,
    house_id TEXT REFERENCES houses(id),
    status TEXT NOT NULL CHECK (status IN ('assigned', 'unassigned')),
    created_at TEXT NOT NULL
  );
  CREATE INDEX payments_by_status ON payments (tenant_id, status, paid_at);
  CREATE TABLE dues (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    house_id TEXT NOT NULL REFERENCES houses(id),
    concept_id TEXT NOT NULL REFERENCES concepts(id),
    period TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid')),
    payment_id TEXT REFERENCES payments(id),
    paid_at TEXT,
    UNIQUE (house_id, concept_id, period)
  );
  CREATE INDEX dues_by_period ON dues (tenant_id, period);
  `,
  /* V2: two-step login. The TOTP secret is stored encrypted (security.js); totp_last_step blocks replaying a code. */
  `
  ALTER TABLE users ADD COLUMN totp_secret TEXT;
  ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN totp_last_step INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN stage TEXT NOT NULL DEFAULT 'full';
  `,
  /* V3: each conjunto has its own pagoradar webhook secret (stored encrypted), and we note when its last signed event arrived. */
  `
  ALTER TABLE tenants ADD COLUMN pagoradar_secret TEXT;
  ALTER TABLE tenants ADD COLUMN pagoradar_last_at TEXT;
  `,
  /* V4: the treasurer's name, for the greeting ("Hola, Marta"). */
  `
  ALTER TABLE users ADD COLUMN display_name TEXT;
  `,
  /* V5: a free note on manual payments ("lo trajo la esposa", "consignación del 2 de nov"). */
  `
  ALTER TABLE payments ADD COLUMN note TEXT;
  `,
  /* V6: the payment window of each conjunto: pay from day open_day to day due_day of the month (NULL = not set). */
  `
  ALTER TABLE tenants ADD COLUMN open_day INTEGER;
  ALTER TABLE tenants ADD COLUMN due_day INTEGER;
  `,
  /* V7: proofs of payment (photo or PDF) that a resident uploads; the treasurer confirms them by recording the payment. */
  `
  CREATE TABLE proofs (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    house_id TEXT NOT NULL REFERENCES houses(id),
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    data BLOB NOT NULL,
    note TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
    payment_id TEXT,
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );
  CREATE INDEX proofs_by_tenant ON proofs (tenant_id, status, created_at);
  CREATE INDEX proofs_by_house ON proofs (house_id, created_at);
  `,
  /* V8: invitations for more people on the same conjunto (the link is the credential; only its hash is stored). */
  `
  CREATE TABLE invitations (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    email TEXT NOT NULL,
    display_name TEXT,
    token_hash TEXT NOT NULL UNIQUE,
    invited_by TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  );
  CREATE INDEX invitations_by_tenant ON invitations (tenant_id, used_at);
  `,
  /* V9: how the conjunto confirms payments, 'auto' (pagoradar) or 'manual' (the treasurer records each one). NULL = decide by whether a secret is saved. */
  `
  ALTER TABLE tenants ADD COLUMN pay_mode TEXT CHECK (pay_mode IN ('auto', 'manual'));
  `,
  /* V10: phone notifications (Web Push). `settings` holds instance-wide values (the VAPID key pair, private half encrypted);
     each subscription is one browser/device of one person of one conjunto. */
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE push_subscriptions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX push_by_tenant ON push_subscriptions (tenant_id);
  `,
  /* V11: "cuentas claras": what the conjunto spends (with the receipt) and the balance it starts from.
     `show_accounts` lets the treasurer decide whether residents may see the accounts. Expenses are voided, never deleted. */
  `
  ALTER TABLE tenants ADD COLUMN opening_cents INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tenants ADD COLUMN show_accounts INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE expenses (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    spent_on TEXT NOT NULL,
    period TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    category TEXT NOT NULL,
    description TEXT NOT NULL,
    proof_mime TEXT,
    proof BLOB,
    created_by TEXT,
    created_at TEXT NOT NULL,
    voided_at TEXT
  );
  CREATE INDEX expenses_by_tenant ON expenses (tenant_id, period);
  `,
  /* V12: residents' phones (a house installs the app and allows notifications) and the reminders already sent, so each
     one goes out once per house and month. */
  `
  CREATE TABLE house_push_subscriptions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    house_id TEXT NOT NULL REFERENCES houses(id),
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX house_push_by_house ON house_push_subscriptions (tenant_id, house_id);
  CREATE TABLE reminders_sent (
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    house_id TEXT NOT NULL REFERENCES houses(id),
    period TEXT NOT NULL,
    kind TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, house_id, period, kind)
  );
  `,
  /* V13: paz y salvo certificates. Each one has a short code anyone can check at /verificar (it shows only the conjunto,
     the house number, the kind and the day: never a name). One per house, kind and day. */
  `
  CREATE TABLE certificates (
    code TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    house_id TEXT NOT NULL REFERENCES houses(id),
    kind TEXT NOT NULL,
    issued_on TEXT NOT NULL,
    issued_by TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (tenant_id, house_id, kind, issued_on)
  );
  `,
  /* V14: audit log. Append-only (nothing updates or deletes a row). It keeps the person's name as it was, because the
     user may be removed later; `summary` is a fixed sentence and never carries a secret, a password or a file. */
  `
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    at TEXT NOT NULL,
    user_id TEXT,
    user_name TEXT NOT NULL,
    action TEXT NOT NULL,
    summary TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT
  );
  CREATE INDEX audit_by_tenant ON audit_log (tenant_id, id);
  `,
  /* V15: what a conjunto charges. 'monthly' concepts (vigilancia, administración) get a due for every active house every
     month; 'once' concepts are a special charge (cuota extraordinaria, multa) made for a month and some houses. */
  `
  ALTER TABLE concepts ADD COLUMN kind TEXT NOT NULL DEFAULT 'monthly' CHECK (kind IN ('monthly', 'once'));
  `,
  /* V16: the operator (the owner of the platform): people who create conjuntos and who belong to none. They have their own
     table and sessions so nothing of a conjunto's login can ever reach /operador, and the reverse. */
  `
  CREATE TABLE operators (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT,
    password_hash TEXT NOT NULL,
    totp_secret TEXT,
    totp_enabled INTEGER NOT NULL DEFAULT 0,
    totp_last_step INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE operator_sessions (
    token_hash TEXT PRIMARY KEY,
    operator_id TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    stage TEXT NOT NULL
  );
  `,
  /* V17: more ways to pay besides the Bre-B key (Nequi, Daviplata, Bancolombia…), shown to residents on their pay screen. */
  `
  CREATE TABLE pay_methods (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    kind TEXT NOT NULL CHECK (kind IN ('nequi', 'daviplata', 'bancolombia', 'otro')),
    label TEXT,
    account TEXT NOT NULL,
    account_type TEXT CHECK (account_type IN ('ahorros', 'corriente')),
    holder TEXT,
    note TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX pay_methods_by_tenant ON pay_methods (tenant_id, position);
  `,
  /* V18: the WhatsApp messages a conjunto has edited (the original text lives in the code; a row exists only when it was changed). */
  `
  CREATE TABLE message_templates (
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    key TEXT NOT NULL,
    body TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, key)
  );
  `,
  /* V19: passkeys (WebAuthn). A user may register several; `credential_id` is what the browser sends back at sign-in. The
     challenges are single-use and short-lived. */
  `
  CREATE TABLE passkeys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credential_id TEXT NOT NULL UNIQUE,
    public_key TEXT NOT NULL,
    alg INTEGER NOT NULL,
    sign_count INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL,
    transports TEXT,
    created_at TEXT NOT NULL,
    last_used_at TEXT
  );
  CREATE INDEX passkeys_by_user ON passkeys (user_id);
  CREATE TABLE webauthn_challenges (
    challenge TEXT PRIMARY KEY,
    purpose TEXT NOT NULL CHECK (purpose IN ('register', 'login')),
    user_id TEXT,
    expires_at TEXT NOT NULL
  );
  `,
  /* V20: public transparency page. The conjunto may publish its month totals and expenses at /t/<token>. Only the token's hash is
     used to look it up; the token itself is kept encrypted so the treasurer can copy the link again. NULL = not published. */
  `
  ALTER TABLE tenants ADD COLUMN public_token_hash TEXT;
  ALTER TABLE tenants ADD COLUMN public_token_enc TEXT;
  CREATE UNIQUE INDEX tenants_public_token ON tenants (public_token_hash) WHERE public_token_hash IS NOT NULL;
  `,
];

export const EXPENSE_CATEGORIES = ["Vigilancia", "Servicios públicos", "Mantenimiento", "Aseo y jardinería", "Papelería y administración", "Imprevistos", "Otros"];

const nowIso = () => new Date().toISOString();

const newId = (prefix) => `${prefix}_${randomBytes(8).toString("hex")}`;

const tenantRow = (r) => !r ? null : {
  id: r.id, slug: r.slug, name: r.name, payKey: r.pay_key, payHolder: r.pay_holder, createdAt: r.created_at ?? null,
  // The secret itself never travels in the DTO: views get only whether it is set.
  pagoradarConfigured: !!r.pagoradar_secret, pagoradarLastAt: r.pagoradar_last_at,
  openDay: r.open_day ?? null, dueDay: r.due_day ?? null,
  // What residents are told: payments confirmed by the bank, or registered by the treasurer.
  payMode: r.pay_mode ?? (r.pagoradar_secret ? "auto" : "manual"),
  openingCents: Number(r.opening_cents ?? 0), showAccounts: !!r.show_accounts, publicOn: !!r.public_token_hash,
};
const houseRow = (r) => !r ? null : { id: r.id, tenantId: r.tenant_id, code: r.code, residentName: r.resident_name, phone: r.phone, active: !!r.active };
const dueRow = (r) => ({
  id: r.id, houseId: r.house_id, conceptId: r.concept_id, period: r.period, amountCents: r.amount_cents,
  status: r.status, paymentId: r.payment_id, paidAt: r.paid_at,
  houseCode: r.house_code, residentName: r.resident_name, conceptName: r.concept_name,
});
/** The name shown in "Hola, …": the one given, else the part of the email before the first dot, dash or plus. */
const greetingName = (name, email) => {
  const given = String(name ?? "").trim().split(/\s+/)[0];
  if (given) return given;
  const local = String(email ?? "").split("@")[0].split(/[._+-]/)[0];
  return local ? local[0].toUpperCase() + local.slice(1) : "";
};
const userRow = (r) => !r ? null : {
  id: r.id, tenantId: r.tenant_id, email: r.email, passwordHash: r.password_hash, role: r.role,
  totpSecret: r.totp_secret, totpEnabled: !!r.totp_enabled, name: greetingName(r.display_name, r.email),
};
const paymentRow = (r) => !r ? null : {
  id: r.id, externalId: r.external_id, payerName: r.payer_name, payerNorm: r.payer_norm, amountCents: r.amount_cents,
  bank: r.bank, method: r.method, paidAt: r.paid_at, houseId: r.house_id, status: r.status,
  note: r.note ?? null,
  // Registered by hand in Cuotia (no pagoradar notice behind it), as opposed to a bank notice.
  manual: /^(cash|manual)_/.test(r.external_id),
};

export function openStore(path = ":memory:") {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

  const version = db.prepare("PRAGMA user_version").get().user_version;
  MIGRATIONS.slice(version).forEach((sql, i) => {
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${version + i + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  });

  const tx = (fn) => {
    db.exec("BEGIN");
    try {
      const r = fn();
      db.exec("COMMIT");
      return r;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };

  const tenants = {
    create({ slug, name, payKey = null, payHolder = null }) {
      const id = newId("ten");
      db.prepare("INSERT INTO tenants (id, slug, name, pay_key, pay_holder, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, slug, name, payKey, payHolder, nowIso());
      return tenants.get(id);
    },
    get: (id) => tenantRow(db.prepare("SELECT * FROM tenants WHERE id = ?").get(id)),
    bySlug: (slug) => tenantRow(db.prepare("SELECT * FROM tenants WHERE slug = ?").get(slug)),
    list: () => db.prepare("SELECT * FROM tenants ORDER BY name").all().map(tenantRow),
    /** The encrypted pagoradar webhook secret of this conjunto (or null). Decrypt with `decryptSecret` only to verify a signature. */
    pagoradarSecret: (id) => db.prepare("SELECT pagoradar_secret FROM tenants WHERE id = ?").get(id)?.pagoradar_secret ?? null,
    setPagoradarSecret: (id, encrypted) => void db.prepare("UPDATE tenants SET pagoradar_secret = ? WHERE id = ?").run(encrypted, id),
    /** Global lookup for the public transparency page: the unguessable token is the credential. */
    byPublicToken: (token) => tenantRow(db.prepare("SELECT * FROM tenants WHERE public_token_hash = ?").get(sha256(String(token)))),
    /** The encrypted token (to show the link again), or null when the page is not published. */
    publicTokenEnc: (id) => db.prepare("SELECT public_token_enc FROM tenants WHERE id = ? AND public_token_hash IS NOT NULL").get(id)?.public_token_enc ?? null,
    setPublicToken: (id, token, encrypted) => void db.prepare("UPDATE tenants SET public_token_hash = ?, public_token_enc = ? WHERE id = ?").run(sha256(String(token)), encrypted, id),
    clearPublicToken: (id) => void db.prepare("UPDATE tenants SET public_token_hash = NULL, public_token_enc = NULL WHERE id = ?").run(id),
    /** The Bre-B key and holder residents see. Empty means "not set". */
    setAccounts: (id, { openingCents, showAccounts }) => void db.prepare("UPDATE tenants SET opening_cents = ?, show_accounts = ? WHERE id = ?").run(openingCents, showAccounts ? 1 : 0, id),
    setPayMode: (id, mode) => void db.prepare("UPDATE tenants SET pay_mode = ? WHERE id = ?").run(mode === "auto" || mode === "manual" ? mode : null, id),
    setDates: (id, { openDay, dueDay }) => void db.prepare("UPDATE tenants SET open_day = ?, due_day = ? WHERE id = ?").run(openDay ?? null, dueDay ?? null, id),
    setPayment: (id, { payKey, payHolder }) => void db.prepare("UPDATE tenants SET pay_key = ?, pay_holder = ? WHERE id = ?").run(String(payKey ?? "").trim() || null, String(payHolder ?? "").trim() || null, id),
    /** A correctly signed event arrived (even a test one): the panel shows the connection as alive. */
    touchPagoradar: (id) => void db.prepare("UPDATE tenants SET pagoradar_last_at = ? WHERE id = ?").run(nowIso(), id),
  };

  const users = {
    create({ tenantId, email, passwordHash, role = "tesorero", name = null }) {
      const id = newId("usr");
      db.prepare("INSERT INTO users (id, tenant_id, email, password_hash, role, display_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, tenantId, email.trim().toLowerCase(), passwordHash, role, name?.trim() || null, nowIso());
      return id;
    },
    byEmail(email) {
      return userRow(db.prepare("SELECT * FROM users WHERE email = ?").get(String(email).trim().toLowerCase()));
    },
    byId: (id) => userRow(db.prepare("SELECT * FROM users WHERE id = ?").get(id)),
    setPasswordHash: (userId, hash) => void db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, userId),
    /** Lost phone: forgets the authenticator, so the next sign-in enrolls a new one. */
    resetTotp: (userId) => void db.prepare("UPDATE users SET totp_secret = NULL, totp_enabled = 0, totp_last_step = 0 WHERE id = ?").run(userId),
    /** Stores a not-yet-confirmed (encrypted) secret; it only counts after `enableTotp`. */
    setTotpSecret: (userId, encrypted) => void db.prepare("UPDATE users SET totp_secret = ?, totp_enabled = 0, totp_last_step = 0 WHERE id = ?").run(encrypted, userId),
    enableTotp: (userId) => void db.prepare("UPDATE users SET totp_enabled = 1 WHERE id = ?").run(userId),
    /** True once per time step: a code that was already used is refused, even inside its validity window. */
    claimTotpStep(userId, step) {
      return Number(db.prepare("UPDATE users SET totp_last_step = ? WHERE id = ? AND totp_last_step < ?").run(step, userId, step).changes) === 1;
    },
  };

  const operatorRow = (r) => !r ? null : {
    id: r.id, email: r.email, name: r.display_name || r.email.split("@")[0], passwordHash: r.password_hash,
    totpSecret: r.totp_secret, totpEnabled: !!r.totp_enabled,
  };
  /** The platform's owners. Not tenant data: nothing here belongs to a conjunto. */
  const operators = {
    count: () => Number(db.prepare("SELECT COUNT(*) AS n FROM operators").get().n),
    create({ email, passwordHash, name = null }) {
      const id = newId("op");
      db.prepare("INSERT INTO operators (id, email, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(id, String(email).trim().toLowerCase(), name?.trim() || null, passwordHash, nowIso());
      return id;
    },
    byEmail: (email) => operatorRow(db.prepare("SELECT * FROM operators WHERE email = ?").get(String(email ?? "").trim().toLowerCase())),
    byId: (id) => operatorRow(db.prepare("SELECT * FROM operators WHERE id = ?").get(id)),
    setPasswordHash: (id, hash) => void db.prepare("UPDATE operators SET password_hash = ? WHERE id = ?").run(hash, id),
    resetTotp: (id) => void db.prepare("UPDATE operators SET totp_secret = NULL, totp_enabled = 0, totp_last_step = 0 WHERE id = ?").run(id),
    setTotpSecret: (id, encrypted) => void db.prepare("UPDATE operators SET totp_secret = ?, totp_enabled = 0, totp_last_step = 0 WHERE id = ?").run(encrypted, id),
    enableTotp: (id) => void db.prepare("UPDATE operators SET totp_enabled = 1 WHERE id = ?").run(id),
    claimTotpStep: (id, step) => Number(db.prepare("UPDATE operators SET totp_last_step = ? WHERE id = ? AND totp_last_step < ?").run(step, id, step).changes) === 1,
  };
  const operatorSessions = {
    create(operatorId, { stage = "full", ttlMs = 12 * 3600_000 } = {}) {
      const token = newToken();
      db.prepare("INSERT INTO operator_sessions (token_hash, operator_id, expires_at, stage) VALUES (?, ?, ?, ?)").run(sha256(token), operatorId, new Date(Date.now() + ttlMs).toISOString(), stage);
      return token;
    },
    resolve(token) {
      if (!token) return null;
      const r = db.prepare("SELECT s.stage, o.* FROM operator_sessions s JOIN operators o ON o.id = s.operator_id WHERE s.token_hash = ? AND s.expires_at > ?").get(sha256(token), nowIso());
      return r ? { stage: r.stage, operator: operatorRow(r) } : null;
    },
    /** After a valid code: a new full session replaces the pending one (the token changes at privilege change). */
    promote(token, ttlMs = 12 * 3600_000) {
      const s = operatorSessions.resolve(token);
      if (!s) return null;
      operatorSessions.delete(token);
      return operatorSessions.create(s.operator.id, { stage: "full", ttlMs });
    },
    delete: (token) => void db.prepare("DELETE FROM operator_sessions WHERE token_hash = ?").run(sha256(token)),
    deleteForOperator: (operatorId, exceptToken = null) => void db.prepare("DELETE FROM operator_sessions WHERE operator_id = ? AND token_hash != ?").run(operatorId, exceptToken ? sha256(exceptToken) : ""),
    purgeExpired: () => void db.prepare("DELETE FROM operator_sessions WHERE expires_at <= ?").run(nowIso()),
  };

  /** A sign-in credential looked up by the id the browser sends: global by design (it identifies a user, like a session). */
  const passkeys = {
    byCredentialId(credentialId) {
      const r = db.prepare("SELECT p.*, u.tenant_id FROM passkeys p JOIN users u ON u.id = p.user_id WHERE p.credential_id = ?").get(String(credentialId ?? ""));
      return r ? { id: r.id, userId: r.user_id, tenantId: r.tenant_id, publicKey: r.public_key, alg: r.alg, signCount: Number(r.sign_count) } : null;
    },
    touch: (id, signCount) => void db.prepare("UPDATE passkeys SET sign_count = ?, last_used_at = ? WHERE id = ?").run(signCount, nowIso(), id),
  };
  /** Single-use challenges for the two ceremonies; they die in 3 minutes or at first use. */
  const webauthnChallenges = {
    create({ purpose, userId = null }) {
      db.prepare("DELETE FROM webauthn_challenges WHERE expires_at <= ?").run(nowIso());
      const challenge = randomBytes(32).toString("base64url");
      db.prepare("INSERT INTO webauthn_challenges (challenge, purpose, user_id, expires_at) VALUES (?, ?, ?, ?)").run(challenge, purpose, userId, new Date(Date.now() + 3 * 60_000).toISOString());
      return challenge;
    },
    /** `{ userId }` the first time a live challenge of that purpose is shown, null every other time. */
    consume(challenge, purpose) {
      return tx(() => {
        const r = db.prepare("SELECT user_id FROM webauthn_challenges WHERE challenge = ? AND purpose = ? AND expires_at > ?").get(String(challenge ?? ""), purpose, nowIso());
        db.prepare("DELETE FROM webauthn_challenges WHERE challenge = ?").run(String(challenge ?? ""));
        return r ? { userId: r.user_id } : null;
      });
    },
  };

  /** Checks a paz y salvo by its code. Global by design (the code is the credential) and it reveals no name. */
  const certificates = {
    byCode(code) {
      const r = db.prepare(
        `SELECT c.kind, c.issued_on, h.code AS house_code, t.name AS tenant_name FROM certificates c
         JOIN houses h ON h.id = c.house_id JOIN tenants t ON t.id = c.tenant_id WHERE c.code = ?`,
      ).get(String(code ?? "").trim().toUpperCase());
      return r ? { kind: r.kind, issuedOn: r.issued_on, houseCode: r.house_code, tenantName: r.tenant_name } : null;
    },
  };

  /** Instance-wide values (the VAPID keys). Not tenant data. */
  const settings = {
    get: (key) => db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? null,
    set: (key, value) => void db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value),
    /** The old keys are gone: every subscription was made for them and is now useless. */
    resetPush: () => { db.prepare("DELETE FROM push_subscriptions").run(); db.prepare("DELETE FROM house_push_subscriptions").run(); },
  };

  const INVITE_TTL_MS = 7 * 24 * 3600_000;
  /** An invitation that can still be used, by the secret in its link. Global by design, like `residentByToken`. */
  const invitations = {
    byToken(token) {
      if (!token) return null;
      const r = db.prepare("SELECT * FROM invitations WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?").get(sha256(token), nowIso());
      return r ? { id: r.id, tenantId: r.tenant_id, email: r.email, name: r.display_name, tenant: tenants.get(r.tenant_id) } : null;
    },
    /** The invited person chooses their password: creates the user in the inviting conjunto and burns the link. */
    accept(token, { passwordHash, name }) {
      return tx(() => {
        const inv = invitations.byToken(token);
        if (!inv) throw new Error("La invitación no existe o ya venció");
        if (users.byEmail(inv.email)) throw new Error("Ese correo ya tiene una cuenta");
        const userId = users.create({ tenantId: inv.tenantId, email: inv.email, passwordHash, name: name || inv.name });
        db.prepare("UPDATE invitations SET used_at = ? WHERE id = ?").run(nowIso(), inv.id);
        return { userId, tenantId: inv.tenantId };
      });
    },
  };

  const sessions = {
    /** Returns the raw token (only its hash is stored). */
    /**
     * stage "pending" = password accepted, waiting for the 2-step code; "setup" = must enroll a TOTP first;
     * "full" = fully signed in. A pending/setup session is short and opens nothing but the /2fa page.
     */
    create(userId, { stage = "full", ttlMs = 12 * 3600_000 } = {}) {
      const token = newToken();
      db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, stage) VALUES (?, ?, ?, ?)").run(sha256(token), userId, new Date(Date.now() + ttlMs).toISOString(), stage);
      return token;
    },
    resolve(token) {
      if (!token) return null;
      const r = db.prepare(
        `SELECT u.id AS user_id, u.email, u.role, u.tenant_id, u.display_name, s.stage FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?`,
      ).get(sha256(token), nowIso());
      if (!r) return null;
      return { stage: r.stage, user: { id: r.user_id, email: r.email, role: r.role, tenantId: r.tenant_id, name: greetingName(r.display_name, r.email) }, tenant: tenants.get(r.tenant_id) };
    },
    /** After a valid code: a fresh full session replaces the pending one, so the cookie value changes at privilege change. */
    promote(token, ttlMs = 12 * 3600_000) {
      const s = sessions.resolve(token);
      if (!s) return null;
      sessions.delete(token);
      return sessions.create(s.user.id, { stage: "full", ttlMs });
    },
    delete: (token) => void db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token)),
    /** Signs a person out everywhere (after a password change or reset), optionally keeping the session making the change. */
    deleteForUser: (userId, exceptToken = null) => void db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").run(userId, exceptToken ? sha256(exceptToken) : ""),
    purgeExpired: () => void db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(nowIso()),
  };

  /** A resident opens their personal link: the unguessable token is the credential. Global lookup by design. */
  function residentByToken(token) {
    if (!token) return null;
    const r = db.prepare("SELECT * FROM houses WHERE access_hash = ? AND active = 1").get(sha256(token));
    return r ? { tenant: tenants.get(r.tenant_id), house: houseRow(r) } : null;
  }

  function forTenant(tenantId) {
    if (!tenants.get(tenantId)) throw new Error(`Conjunto desconocido: ${tenantId}`);
    const houseOf = (houseId) => db.prepare("SELECT * FROM houses WHERE id = ? AND tenant_id = ?").get(houseId, tenantId);
    const ownHouse = (houseId) => {
      const h = houseOf(houseId);
      if (!h) throw new Error("Esa casa no existe en este conjunto");
      return h;
    };

    const houses = {
      create({ code, residentName, phone = null }) {
        const id = newId("hs");
        const token = newToken(24);
        db.prepare("INSERT INTO houses (id, tenant_id, code, resident_name, phone, access_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, tenantId, code, residentName, phone, sha256(token), nowIso());
        return { house: houseRow(houseOf(id)), accessToken: token };
      },
      get: (id) => houseRow(houseOf(id)),
      list: () => db.prepare("SELECT * FROM houses WHERE tenant_id = ? AND active = 1 ORDER BY code").all(tenantId).map(houseRow),
      listInactive: () => db.prepare("SELECT * FROM houses WHERE tenant_id = ? AND active = 0 ORDER BY code").all(tenantId).map(houseRow),
      /** Edits the data of a house. A code already used by another house throws a UNIQUE error. */
      update(houseId, { code, residentName, phone = null }) {
        ownHouse(houseId);
        db.prepare("UPDATE houses SET code = ?, resident_name = ?, phone = ? WHERE id = ? AND tenant_id = ?").run(code, residentName, phone, houseId, tenantId);
        return houseRow(houseOf(houseId));
      },
      /**
       * Deactivating keeps all history (dues, payments) but stops the personal link, new dues and automatic matching.
       * Its unpaid dues stop counting as pending; its paid ones keep counting.
       */
      /**
       * Right to erasure (Ley 1581) for a house that was dada de baja: the history of dues and payments stays for the
       * accounting but loses every personal detail. Cannot be undone, so it is refused for an active house.
       */
      anonymize(houseId) {
        return tx(() => {
          const h = ownHouse(houseId);
          if (h.active) throw new Error("Primero da de baja la casa");
          db.prepare("UPDATE houses SET resident_name = 'Residente anterior', phone = NULL WHERE id = ? AND tenant_id = ?").run(houseId, tenantId);
          db.prepare("DELETE FROM aliases WHERE house_id = ? AND tenant_id = ?").run(houseId, tenantId);
          db.prepare("DELETE FROM proofs WHERE house_id = ? AND tenant_id = ?").run(houseId, tenantId);
          db.prepare("DELETE FROM house_push_subscriptions WHERE house_id = ? AND tenant_id = ?").run(houseId, tenantId);
          db.prepare("UPDATE payments SET payer_name = 'Pagador anónimo', payer_norm = 'ANONIMO' WHERE house_id = ? AND tenant_id = ?").run(houseId, tenantId);
        });
      },
      setActive(houseId, active) {
        ownHouse(houseId);
        db.prepare("UPDATE houses SET active = ? WHERE id = ? AND tenant_id = ?").run(active ? 1 : 0, houseId, tenantId);
      },
      /** The old personal link stops working; the new token is returned once (only its hash is stored). */
      rotateToken(houseId) {
        ownHouse(houseId);
        const token = newToken(24);
        db.prepare("UPDATE houses SET access_hash = ? WHERE id = ? AND tenant_id = ?").run(sha256(token), houseId, tenantId);
        return token;
      },
    };

    const aliases = {
      add(houseId, name) {
        ownHouse(houseId);
        const norm = normalizeName(name);
        if (!norm) return false;
        const r = db.prepare("INSERT OR IGNORE INTO aliases (id, tenant_id, house_id, name_norm) VALUES (?, ?, ?, ?)").run(newId("al"), tenantId, houseId, norm);
        return Number(r.changes) === 1;
      },
      list: (houseId) => db.prepare("SELECT id, name_norm FROM aliases WHERE tenant_id = ? AND house_id = ? ORDER BY name_norm").all(tenantId, houseId).map((r) => ({ id: r.id, name: r.name_norm })),
      remove(houseId, aliasId) {
        ownHouse(houseId);
        return Number(db.prepare("DELETE FROM aliases WHERE id = ? AND house_id = ? AND tenant_id = ?").run(aliasId, houseId, tenantId).changes) === 1;
      },
      /** The one active house that uses this name, or null when none or several do (never guess). */
      houseFor(norm) {
        const rows = db.prepare(
          `SELECT DISTINCT a.house_id FROM aliases a JOIN houses h ON h.id = a.house_id
           WHERE a.tenant_id = ? AND a.name_norm = ? AND h.active = 1`,
        ).all(tenantId, norm);
        return rows.length === 1 ? rows[0].house_id : null;
      },
    };

    const CONCEPT_MIN_CENTS = 100_000; // $1.000
    const CONCEPT_MAX_CENTS = 10_000_000_000; // $100.000.000
    const checkConcept = (name, amountCents) => {
      const clean = String(name ?? "").trim();
      if (clean.length < 2 || clean.length > 60) throw new Error("El nombre debe tener entre 2 y 60 letras");
      if (!Number.isSafeInteger(amountCents) || amountCents < CONCEPT_MIN_CENTS || amountCents > CONCEPT_MAX_CENTS) throw new Error("El valor debe estar entre $1.000 y $100.000.000");
      return clean;
    };
    const conceptRow = (r) => ({ id: r.id, name: r.name, amountCents: r.amount_cents, kind: r.kind, active: !!r.active });
    const concepts = {
      create({ name, amountCents, kind = "monthly" }) {
        const clean = checkConcept(name, amountCents);
        if (db.prepare("SELECT 1 FROM concepts WHERE tenant_id = ? AND LOWER(name) = LOWER(?)").get(tenantId, clean)) throw new Error("Ya existe un cobro con ese nombre");
        const id = newId("cn");
        db.prepare("INSERT INTO concepts (id, tenant_id, name, amount_cents, kind) VALUES (?, ?, ?, ?, ?)").run(id, tenantId, clean, amountCents, kind === "once" ? "once" : "monthly");
        return id;
      },
      /** What is charged every month: the active monthly concepts. */
      list: () => db.prepare("SELECT * FROM concepts WHERE tenant_id = ? AND active = 1 AND kind = 'monthly' ORDER BY name").all(tenantId).map(conceptRow),
      /** Everything this conjunto has ever charged, with how many dues each one made and how many are still unpaid. */
      all: () => db.prepare(
        `SELECT c.*, COUNT(d.id) AS dues, COALESCE(SUM(d.status = 'pending'), 0) AS pending, COALESCE(SUM(CASE WHEN d.status = 'pending' THEN d.amount_cents ELSE 0 END), 0) AS pending_cents,
                MIN(d.period) AS period
         FROM concepts c LEFT JOIN dues d ON d.concept_id = c.id WHERE c.tenant_id = ? GROUP BY c.id ORDER BY c.kind, c.name`,
      ).all(tenantId).map((r) => ({ ...conceptRow(r), dues: Number(r.dues), pending: Number(r.pending), pendingCents: Number(r.pending_cents), period: r.period })),
      /** A new amount: only the dues made from now on use it; the ones already made keep what they were charged. */
      setAmount(id, amountCents) {
        const row = db.prepare("SELECT * FROM concepts WHERE id = ? AND tenant_id = ? AND kind = 'monthly'").get(id, tenantId);
        if (!row) throw new Error("Ese cobro no existe en este conjunto");
        checkConcept(row.name, amountCents);
        db.prepare("UPDATE concepts SET amount_cents = ? WHERE id = ? AND tenant_id = ?").run(amountCents, id, tenantId);
      },
      /** Stops (or resumes) a monthly concept: no new dues are made for it; the existing ones stay. Never the last active one. */
      setActive(id, active) {
        const row = db.prepare("SELECT * FROM concepts WHERE id = ? AND tenant_id = ? AND kind = 'monthly'").get(id, tenantId);
        if (!row) throw new Error("Ese cobro no existe en este conjunto");
        if (!active && Number(db.prepare("SELECT COUNT(*) AS n FROM concepts WHERE tenant_id = ? AND kind = 'monthly' AND active = 1 AND id != ?").get(tenantId, id).n) === 0) throw new Error("Debe quedar al menos un cobro mensual activo");
        db.prepare("UPDATE concepts SET active = ? WHERE id = ? AND tenant_id = ?").run(active ? 1 : 0, id, tenantId);
      },
      /**
       * A special charge (cuota extraordinaria, multa): one concept and one due for each of the chosen active houses, for
       * one month. All or nothing; the name must be new.
       */
      charge({ name, amountCents, period, houseIds }) {
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new Error("El período debe ser AAAA-MM");
        const ids = [...new Set(houseIds ?? [])];
        if (ids.length === 0) throw new Error("Elige al menos una casa");
        return tx(() => {
          for (const id of ids) if (!ownHouse(id).active) throw new Error("Una de las casas está dada de baja");
          const conceptId = concepts.create({ name, amountCents, kind: "once" });
          const insert = db.prepare("INSERT INTO dues (id, tenant_id, house_id, concept_id, period, amount_cents) VALUES (?, ?, ?, ?, ?, ?)");
          for (const id of ids) insert.run(newId("du"), tenantId, id, conceptId, period, amountCents);
          return { conceptId, created: ids.length };
        });
      },
    };

    const DUE_SELECT = `SELECT d.*, h.code AS house_code, h.resident_name, c.name AS concept_name
      FROM dues d JOIN houses h ON h.id = d.house_id JOIN concepts c ON c.id = d.concept_id`;
    const dues = {
      /** One due per active house and active concept for the period; running it twice creates nothing new. */
      generate(period) {
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new Error("El período debe ser AAAA-MM");
        return tx(() => {
          let created = 0;
          const insert = db.prepare("INSERT OR IGNORE INTO dues (id, tenant_id, house_id, concept_id, period, amount_cents) VALUES (?, ?, ?, ?, ?, ?)");
          for (const h of houses.list()) {
            for (const c of concepts.list()) created += Number(insert.run(newId("du"), tenantId, h.id, c.id, period, c.amountCents).changes);
          }
          return created;
        });
      },
      // A deactivated house's unpaid dues don't show; its paid ones keep counting.
      /** A month's dues for ONE house (all concepts): to record a payment for a month that was never generated, e.g. October. */
      generateForHouse(houseId, period) {
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new Error("El período debe ser AAAA-MM");
        if (!ownHouse(houseId).active) throw new Error("Esa casa está desactivada");
        return tx(() => {
          let created = 0;
          const insert = db.prepare("INSERT OR IGNORE INTO dues (id, tenant_id, house_id, concept_id, period, amount_cents) VALUES (?, ?, ?, ?, ?, ?)");
          for (const c of concepts.list()) created += Number(insert.run(newId("du"), tenantId, houseId, c.id, period, c.amountCents).changes);
          return created;
        });
      },
      listByPeriod: (period) => db.prepare(`${DUE_SELECT} WHERE d.tenant_id = ? AND d.period = ? AND (h.active = 1 OR d.status = 'paid') ORDER BY h.code, c.name`).all(tenantId, period).map(dueRow),
      listForHouse: (houseId) => db.prepare(`${DUE_SELECT} WHERE d.tenant_id = ? AND d.house_id = ? ORDER BY d.period DESC, c.name`).all(tenantId, houseId).map(dueRow),
      /** The months that have dues, newest first ("2026-11", "2026-10"…): what the month selector offers. */
      periods: () => db.prepare("SELECT DISTINCT period FROM dues WHERE tenant_id = ? ORDER BY period DESC LIMIT 36").all(tenantId).map((r) => r.period),
      /** Unpaid dues of active houses, oldest first: what a manual payment can settle. */
      listPending: () => db.prepare(`${DUE_SELECT} WHERE d.tenant_id = ? AND d.status = 'pending' AND h.active = 1 ORDER BY h.code, d.period, c.name`).all(tenantId).map(dueRow),
      /**
       * Which unpaid dues of this house does a payment of exactly `amountCents` cover? Deterministic, and never a guess:
       *  1. one due with exactly that amount (the oldest; among equals, by concept name);
       *  2. else all the unpaid dues of ONE month (the oldest month that adds up), when there are several;
       *  3. else all the house's unpaid dues, when together they add up (what the resident's "Total a pagar" says).
       * Anything else returns [] and the payment waits for the treasurer.
       */
      matchFor(houseId, amountCents) {
        const open = db.prepare(`${DUE_SELECT} WHERE d.tenant_id = ? AND d.house_id = ? AND d.status = 'pending' ORDER BY d.period, c.name`).all(tenantId, houseId).map(dueRow);
        const single = open.find((d) => d.amountCents === amountCents);
        if (single) return [single];
        const byMonth = new Map();
        for (const d of open) byMonth.set(d.period, [...(byMonth.get(d.period) ?? []), d]);
        for (const list of byMonth.values()) if (list.length > 1 && list.reduce((n, d) => n + d.amountCents, 0) === amountCents) return list;
        if (open.length > 1 && open.reduce((n, d) => n + d.amountCents, 0) === amountCents) return open;
        return [];
      },
      /** The oldest unpaid due of this house for exactly this amount. */
      oldestOpen(houseId, amountCents) {
        const r = db.prepare("SELECT * FROM dues WHERE tenant_id = ? AND house_id = ? AND amount_cents = ? AND status = 'pending' ORDER BY period LIMIT 1").get(tenantId, houseId, amountCents);
        return r ? { id: r.id, period: r.period, amountCents: r.amount_cents } : null;
      },
      /** A paid due of this house with the payment that settled it: what a resident's receipt shows. Null if not paid or not theirs. */
      receiptForHouse(houseId, dueId) {
        const r = db.prepare(
          `SELECT d.id, d.period, d.amount_cents, d.paid_at, c.name AS concept_name, h.code AS house_code, h.resident_name,
                  p.method, p.bank, p.payer_name, p.external_id, p.note
           FROM dues d JOIN houses h ON h.id = d.house_id JOIN concepts c ON c.id = d.concept_id JOIN payments p ON p.id = d.payment_id
           WHERE d.id = ? AND d.house_id = ? AND d.tenant_id = ? AND d.status = 'paid'`,
        ).get(dueId, houseId, tenantId);
        return r && {
          id: r.id, period: r.period, amountCents: r.amount_cents, paidAt: r.paid_at, conceptName: r.concept_name,
          houseCode: r.house_code, residentName: r.resident_name, method: r.method, bank: r.bank, payerName: r.payer_name,
          manual: /^(cash|manual)_/.test(r.external_id), note: r.note ?? null,
          number: `${r.period}-${r.id.slice(-4).toUpperCase()}`,
        };
      },
      settle(dueId, paymentId, paidAt) {
        const r = db.prepare("UPDATE dues SET status = 'paid', payment_id = ?, paid_at = ? WHERE id = ? AND tenant_id = ? AND status = 'pending'").run(paymentId, paidAt, dueId, tenantId);
        return Number(r.changes) === 1;
      },
    };

    const payments = {
      /** Idempotent by the pagoradar payment id: a retried webhook creates nothing. */
      record({ externalId, payerName, payerNorm, amountCents, bank = null, method = null, paidAt }) {
        const id = newId("pg");
        const r = db.prepare(
          `INSERT OR IGNORE INTO payments (id, tenant_id, external_id, payer_name, payer_norm, amount_cents, bank, method, paid_at, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unassigned', ?)`,
        ).run(id, tenantId, externalId, payerName, payerNorm, amountCents, bank, method, paidAt, nowIso());
        const row = db.prepare("SELECT * FROM payments WHERE external_id = ?").get(externalId);
        // A duplicate id from another conjunto must never leak or be touched from here.
        if (row.tenant_id !== tenantId) throw new Error("Pago duplicado de otro conjunto");
        return { created: Number(r.changes) === 1, payment: paymentRow(row) };
      },
      get: (id) => paymentRow(db.prepare("SELECT * FROM payments WHERE id = ? AND tenant_id = ?").get(id, tenantId)),
      /**
       * A payment taken by hand, with or without pagoradar: cash, a transfer or anything else the treasurer received.
       * It settles exactly the chosen dues of one house (one payment can cover several months) for their total, so a
       * resident can't end up half-paid. All or nothing: a due that isn't this house's, or isn't pending, aborts it.
       */
      recordManual({ houseId, dueIds, method = "cash", bank = null, paidAt = nowIso(), note = null, proofId = null }) {
        return tx(() => {
          const house = houseRow(ownHouse(houseId));
          if (proofId && !db.prepare("SELECT 1 FROM proofs WHERE id = ? AND tenant_id = ? AND house_id = ? AND status = 'pending'").get(proofId, tenantId, houseId)) throw new Error("Ese comprobante no está pendiente en esa casa");
          const ids = [...new Set(dueIds ?? [])];
          if (ids.length === 0) throw new Error("Elige al menos una cuota");
          if (!MANUAL_LABELS[method]) throw new Error("Medio de pago desconocido");
          const rows = ids.map((id) => db.prepare("SELECT * FROM dues WHERE id = ? AND house_id = ? AND tenant_id = ? AND status = 'pending'").get(id, houseId, tenantId));
          if (rows.some((r) => !r)) throw new Error("Una de las cuotas no está pendiente en esa casa");
          const total = rows.reduce((sum, r) => sum + r.amount_cents, 0);
          const id = newId("pg");
          db.prepare(
            `INSERT INTO payments (id, tenant_id, external_id, payer_name, payer_norm, amount_cents, bank, method, paid_at, house_id, status, note, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'assigned', ?, ?)`,
          ).run(id, tenantId, `manual_${id}`, `${MANUAL_LABELS[method]} · ${house.residentName}`, MANUAL_LABELS[method].toUpperCase(), total,
            String(bank ?? "").trim().slice(0, 40) || null, method, paidAt, houseId, String(note ?? "").trim().slice(0, 120) || null, nowIso());
          for (const r of rows) dues.settle(r.id, id, paidAt);
          if (proofId) db.prepare("UPDATE proofs SET status = 'accepted', payment_id = ?, resolved_at = ? WHERE id = ? AND tenant_id = ?").run(id, nowIso(), proofId, tenantId);
          return { paymentId: id, dueIds: ids, amountCents: total };
        });
      },
      /** A cash payment of the house's oldest open due (kept for the command line and old callers). */
      recordCash(houseId, paidAt = nowIso()) {
        ownHouse(houseId);
        const due = db.prepare("SELECT id FROM dues WHERE tenant_id = ? AND house_id = ? AND status = 'pending' ORDER BY period LIMIT 1").get(tenantId, houseId);
        if (!due) throw new Error("Esa casa no tiene cuotas pendientes");
        const r = payments.recordManual({ houseId, dueIds: [due.id], method: "cash", paidAt });
        return { paymentId: r.paymentId, dueId: due.id, amountCents: r.amountCents };
      },
      /**
       * Payment history, newest first. Filters: `period` ("YYYY-MM", Colombia time), `status`, `houseId`, `q`
       * (payer, house code or resident). Returns the page plus the total count and amount of the whole filter.
       */
      list({ period = null, status = null, houseId = null, q = "", limit = 50, offset = 0 } = {}) {
        const where = ["p.tenant_id = ?"];
        const args = [tenantId];
        if (period && /^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
          const [from, to] = periodRange(period);
          where.push("p.paid_at >= ? AND p.paid_at < ?");
          args.push(from, to);
        }
        if (status === "assigned" || status === "unassigned") {
          where.push("p.status = ?");
          args.push(status);
        }
        if (houseId) {
          where.push("p.house_id = ?");
          args.push(houseId);
        }
        const needle = String(q ?? "").trim().slice(0, 60);
        if (needle) {
          const like = (v) => `%${v.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
          // The payer's name is stored normalized (upper case, no accents or symbols); skip it when the needle has nothing left.
          const norm = normalizeName(needle);
          const parts = ["h.code LIKE ? ESCAPE '\\'", "h.resident_name LIKE ? ESCAPE '\\'"];
          const vals = [like(needle), like(needle)];
          if (norm) { parts.unshift("p.payer_norm LIKE ? ESCAPE '\\'"); vals.unshift(like(norm)); }
          where.push(`(${parts.join(" OR ")})`);
          args.push(...vals);
        }
        const clause = `WHERE ${where.join(" AND ")}`;
        const rows = db.prepare(
          `SELECT p.*, h.code AS house_code, h.resident_name, d.period AS due_period, c.name AS concept_name
           FROM payments p LEFT JOIN houses h ON h.id = p.house_id LEFT JOIN dues d ON d.payment_id = p.id LEFT JOIN concepts c ON c.id = d.concept_id
           ${clause} ORDER BY p.paid_at DESC, p.id LIMIT ? OFFSET ?`,
        ).all(...args, limit, offset);
        const t = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(p.amount_cents), 0) AS cents FROM payments p LEFT JOIN houses h ON h.id = p.house_id ${clause}`).get(...args);
        return {
          total: Number(t.n),
          totalCents: Number(t.cents),
          rows: rows.map((r) => ({ ...paymentRow(r), houseCode: r.house_code, residentName: r.resident_name, duePeriod: r.due_period, conceptName: r.concept_name })),
        };
      },
      /**
       * Undoes an assignment: the due goes back to pending. A bank payment returns to "por asignar" (and the name
       * learned for that house is forgotten); a manual payment, which only exists in Cuotia, is deleted.
       */
      revert(paymentId) {
        return tx(() => {
          const p = payments.get(paymentId);
          if (!p) throw new Error("Ese pago no existe en este conjunto");
          if (p.status !== "assigned") throw new Error("Ese pago no está asignado");
          db.prepare("UPDATE dues SET status = 'pending', payment_id = NULL, paid_at = NULL WHERE tenant_id = ? AND payment_id = ?").run(tenantId, paymentId);
          // A proof that backed this payment goes back to the queue so the treasurer can review it again.
          db.prepare("UPDATE proofs SET status = 'pending', payment_id = NULL, resolved_at = NULL WHERE tenant_id = ? AND payment_id = ?").run(tenantId, paymentId);
          if (p.manual) {
            db.prepare("DELETE FROM payments WHERE id = ? AND tenant_id = ?").run(paymentId, tenantId);
            return { deleted: true };
          }
          db.prepare("DELETE FROM aliases WHERE tenant_id = ? AND house_id = ? AND name_norm = ?").run(tenantId, p.houseId, p.payerNorm);
          db.prepare("UPDATE payments SET house_id = NULL, status = 'unassigned' WHERE id = ? AND tenant_id = ?").run(paymentId, tenantId);
          return { deleted: false };
        });
      },
      /** The proof (id, kind) that backs each of these payments: one query for a whole page of the history. */
      proofsByPayment(paymentIds) {
        const out = new Map();
        for (const pid of paymentIds) {
          const r = db.prepare("SELECT id, mime FROM proofs WHERE tenant_id = ? AND payment_id = ?").get(tenantId, pid);
          if (r) out.set(pid, { id: r.id, mime: r.mime });
        }
        return out;
      },
      countUnassigned: () => Number(db.prepare("SELECT COUNT(*) AS n FROM payments WHERE tenant_id = ? AND status = 'unassigned'").get(tenantId).n),
      listUnassigned: () => db.prepare("SELECT * FROM payments WHERE tenant_id = ? AND status = 'unassigned' ORDER BY paid_at DESC").all(tenantId).map(paymentRow),
      /** Gives an unassigned payment to a house, settles its oldest open due of that amount, and (optionally) remembers the payer's name. */
      assign(paymentId, houseId, { rememberAlias = true } = {}) {
        return tx(() => {
          const p = payments.get(paymentId);
          if (!p) throw new Error("Ese pago no existe en este conjunto");
          if (p.status !== "unassigned") throw new Error("Ese pago ya está asignado");
          ownHouse(houseId);
          db.prepare("UPDATE payments SET house_id = ?, status = 'assigned' WHERE id = ? AND tenant_id = ?").run(houseId, paymentId, tenantId);
          const covered = dues.matchFor(houseId, p.amountCents).filter((d) => dues.settle(d.id, paymentId, p.paidAt));
          if (rememberAlias) aliases.add(houseId, p.payerName);
          return { dueId: covered[0]?.id ?? null, dueIds: covered.map((d) => d.id) };
        });
      },
    };

    /** Which house does this payer belong to? Remembered alias first, then a unique match with a resident's name. */
    function matchHouse(payerName) {
      const byAlias = aliases.houseFor(normalizeName(payerName));
      if (byAlias) return byAlias;
      const hits = houses.list().filter((h) => namesMatch(h.residentName, payerName));
      return hits.length === 1 ? hits[0].id : null;
    }

    function summary(period) {
      const rows = db.prepare(
        `SELECT d.status, COUNT(*) AS n, COALESCE(SUM(d.amount_cents), 0) AS cents FROM dues d JOIN houses h ON h.id = d.house_id
         WHERE d.tenant_id = ? AND d.period = ? AND (h.active = 1 OR d.status = 'paid') GROUP BY d.status`,
      ).all(tenantId, period);
      const pick = (s) => rows.find((r) => r.status === s) ?? { n: 0, cents: 0 };
      const un = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents FROM payments WHERE tenant_id = ? AND status = 'unassigned'").get(tenantId);
      // What came in during the last 7 days, from the dues of this period that were settled in that time.
      const week = db.prepare(
        `SELECT COALESCE(SUM(d.amount_cents), 0) AS cents FROM dues d WHERE d.tenant_id = ? AND d.period = ? AND d.status = 'paid' AND d.paid_at >= ?`,
      ).get(tenantId, period, new Date(Date.now() - 7 * 86400_000).toISOString());
      return {
        period,
        weekCents: Number(week.cents),
        expectedCents: Number(pick("paid").cents) + Number(pick("pending").cents),
        collectedCents: Number(pick("paid").cents),
        paidCount: Number(pick("paid").n),
        pendingCount: Number(pick("pending").n),
        unassignedCount: Number(un.n),
        unassignedCents: Number(un.cents),
      };
    }


    /** The people who can sign in to this conjunto, and the invitations still open. */
    const team = {
      list: () => db.prepare("SELECT * FROM users WHERE tenant_id = ? ORDER BY created_at").all(tenantId).map((r) => ({
        id: r.id, email: r.email, name: greetingName(r.display_name, r.email), totpEnabled: !!r.totp_enabled, createdAt: r.created_at,
      })),
      invitations: () => db.prepare("SELECT * FROM invitations WHERE tenant_id = ? AND used_at IS NULL AND expires_at > ? ORDER BY created_at").all(tenantId, nowIso())
        .map((r) => ({ id: r.id, email: r.email, name: r.display_name, expiresAt: r.expires_at, createdAt: r.created_at })),
      /** Returns the raw token (shown once). One open invitation per email: inviting again replaces the old link. */
      invite({ email, name = null, invitedBy = null }) {
        const clean = String(email ?? "").trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean) || clean.length > 120) throw new Error("Escribe un correo válido");
        if (users.byEmail(clean)) throw new Error("Ese correo ya tiene una cuenta");
        return tx(() => {
          db.prepare("DELETE FROM invitations WHERE tenant_id = ? AND email = ? AND used_at IS NULL").run(tenantId, clean);
          const token = newToken(24);
          db.prepare("INSERT INTO invitations (id, tenant_id, email, display_name, token_hash, invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
            .run(newId("inv"), tenantId, clean, String(name ?? "").trim().slice(0, 80) || null, sha256(token), invitedBy, nowIso(), new Date(Date.now() + INVITE_TTL_MS).toISOString());
          return { token, email: clean };
        });
      },
      cancelInvitation(id) {
        const r = db.prepare("DELETE FROM invitations WHERE id = ? AND tenant_id = ? AND used_at IS NULL").run(id, tenantId);
        if (Number(r.changes) !== 1) throw new Error("Esa invitación no existe en este conjunto");
      },
      /** Takes someone off the conjunto and signs them out everywhere. Never the last person, so the conjunto can't lock itself. */
      remove(userId) {
        return tx(() => {
          const u = db.prepare("SELECT id FROM users WHERE id = ? AND tenant_id = ?").get(userId, tenantId);
          if (!u) throw new Error("Esa persona no es de este conjunto");
          if (Number(db.prepare("SELECT COUNT(*) AS n FROM users WHERE tenant_id = ?").get(tenantId).n) <= 1) throw new Error("Debe quedar al menos una persona con acceso");
          db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
          db.prepare("DELETE FROM users WHERE id = ? AND tenant_id = ?").run(userId, tenantId);
        });
      },
    };

    /** Phones of residents that asked for notifications about their own house. */
    const housePush = {
      add({ houseId, endpoint, p256dh, auth }) {
        if (!db.prepare("SELECT 1 FROM houses WHERE id = ? AND tenant_id = ? AND active = 1").get(houseId, tenantId)) throw new Error("Esa casa no existe en este conjunto");
        db.prepare("INSERT OR REPLACE INTO house_push_subscriptions (id, tenant_id, house_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(newId("hp"), tenantId, houseId, endpoint, p256dh, auth, nowIso());
      },
      list: (houseId) => db.prepare("SELECT endpoint, p256dh, auth FROM house_push_subscriptions WHERE tenant_id = ? AND house_id = ?").all(tenantId, houseId)
        .map((r) => ({ endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth })),
      count: (houseId) => Number(db.prepare("SELECT COUNT(*) AS n FROM house_push_subscriptions WHERE tenant_id = ? AND house_id = ?").get(tenantId, houseId).n),
      /** Which of this conjunto's houses have at least one phone subscribed (for the reminders). */
      houseIds: () => db.prepare("SELECT DISTINCT house_id FROM house_push_subscriptions WHERE tenant_id = ?").all(tenantId).map((r) => r.house_id),
      remove: (endpoint) => void db.prepare("DELETE FROM house_push_subscriptions WHERE tenant_id = ? AND endpoint = ?").run(tenantId, endpoint),
    };

    /** One reminder per house, month and kind: `claim` is true only the first time. */
    const reminders = {
      claim(houseId, period, kind) {
        if (!db.prepare("SELECT 1 FROM houses WHERE id = ? AND tenant_id = ?").get(houseId, tenantId)) throw new Error("Esa casa no existe en este conjunto");
        return Number(db.prepare("INSERT OR IGNORE INTO reminders_sent (tenant_id, house_id, period, kind, sent_at) VALUES (?, ?, ?, ?, ?)").run(tenantId, houseId, period, kind, nowIso()).changes) === 1;
      },
    };

    /** What would be erased by `reset`, so the screen can show it before asking. */
    const resetPreview = () => {
      const n = (sql) => Number(db.prepare(sql).get(tenantId).n);
      return {
        houses: n("SELECT COUNT(*) AS n FROM houses WHERE tenant_id = ?"),
        dues: n("SELECT COUNT(*) AS n FROM dues WHERE tenant_id = ?"),
        payments: n("SELECT COUNT(*) AS n FROM payments WHERE tenant_id = ?"),
        proofs: n("SELECT COUNT(*) AS n FROM proofs WHERE tenant_id = ?"),
        expenses: n("SELECT COUNT(*) AS n FROM expenses WHERE tenant_id = ?"),
        specialCharges: n("SELECT COUNT(*) AS n FROM concepts WHERE tenant_id = ? AND kind = 'once'"),
      };
    };

    /**
     * "Empezar de cero": erases the operating data of this conjunto only, for good. Kept always: the settings (key, dates,
     * pagoradar secret), the monthly concepts, the team and their phones, and the audit log. With `keepHouses` the houses stay
     * (with their personal links and payment names); without it they go too, with their payment names and phone notifications.
     * All or nothing. The caller makes a backup first.
     */
    function reset({ keepHouses = true } = {}) {
      return tx(() => {
        const gone = resetPreview();
        const del = (table, extra = "") => db.prepare(`DELETE FROM ${table} WHERE tenant_id = ?${extra}`).run(tenantId);
        del("reminders_sent");
        del("certificates");
        del("proofs");
        del("expenses");
        del("dues");
        del("payments");
        del("concepts", " AND kind = 'once'");
        if (!keepHouses) {
          del("house_push_subscriptions");
          del("aliases");
          del("houses");
        }
        return { ...gone, keptHouses: keepHouses };
      });
    }

    /** Who did what in this conjunto. Append-only. */
    const audit = {
      record({ userId = null, userName, action, summary, targetType = null, targetId = null }) {
        db.prepare("INSERT INTO audit_log (tenant_id, at, user_id, user_name, action, summary, target_type, target_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(tenantId, nowIso(), userId, String(userName ?? "Cuotia").slice(0, 80), String(action).slice(0, 30), String(summary).slice(0, 300), targetType, targetId);
      },
      /** Newest first. `action` filters one kind; `q` searches the sentence and the person (wildcards are escaped). */
      list({ action = null, q = "", limit = 50, offset = 0 } = {}) {
        const where = ["tenant_id = ?"];
        const args = [tenantId];
        if (action) { where.push("action = ?"); args.push(action); }
        const needle = String(q ?? "").trim().toLowerCase();
        if (needle) {
          where.push("(LOWER(summary) LIKE ? ESCAPE '\\' OR LOWER(user_name) LIKE ? ESCAPE '\\')");
          const like = `%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
          args.push(like, like);
        }
        const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE ${where.join(" AND ")}`).get(...args).n);
        const rows = db.prepare(`SELECT id, at, user_name, action, summary FROM audit_log WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset)
          .map((r) => ({ id: r.id, at: r.at, userName: r.user_name, action: r.action, summary: r.summary }));
        return { rows, total };
      },
    };

    /** Certificates issued for this conjunto's houses (see the global `certificates.byCode` to verify one). */
    const certificates = {
      /** The code of today's certificate for this house and kind, made on the first call and the same afterwards. */
      issue({ houseId, kind, issuedOn, issuedBy = null }) {
        ownHouse(houseId);
        const existing = db.prepare("SELECT code FROM certificates WHERE tenant_id = ? AND house_id = ? AND kind = ? AND issued_on = ?").get(tenantId, houseId, kind, issuedOn);
        if (existing) return existing.code;
        const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // no 0/O, 1/I/L: it is read aloud and typed
        const bytes = randomBytes(10);
        const raw = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
        const code = `${raw.slice(0, 5)}-${raw.slice(5)}`;
        db.prepare("INSERT INTO certificates (code, tenant_id, house_id, kind, issued_on, issued_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(code, tenantId, houseId, kind, issuedOn, issuedBy, nowIso());
        return code;
      },
    };

    /** Other ways to pay (Nequi, Daviplata, Bancolombia…), in the order the treasurer added them. The Bre-B key stays in the tenant. */
    const MAX_PAY_METHODS = 6;
    const payMethodRow = (r) => ({ id: r.id, kind: r.kind, label: r.label, account: r.account, accountType: r.account_type, holder: r.holder, note: r.note });
    const payMethods = {
      list: () => db.prepare("SELECT * FROM pay_methods WHERE tenant_id = ? ORDER BY position, created_at").all(tenantId).map(payMethodRow),
      add({ kind, label = "", account, accountType = null, holder = "", note = "" }) {
        const spec = PAY_KINDS[kind];
        if (!spec) throw new Error("Ese medio de pago no existe");
        let acc = String(account ?? "").trim();
        if (spec.phone) {
          acc = acc.replace(/[\s.-]/g, "");
          if (!/^3\d{9}$/.test(acc)) throw new Error("El celular debe tener 10 dígitos y empezar por 3");
        } else if (kind === "bancolombia") {
          acc = acc.replace(/[\s.-]/g, "");
          if (!/^\d{6,20}$/.test(acc)) throw new Error("El número de cuenta debe tener entre 6 y 20 dígitos");
          if (!spec.types.includes(accountType)) throw new Error("Elige si es cuenta de ahorros o corriente");
        } else if (acc.length < 3 || acc.length > 60) {
          throw new Error("Escribe el número o la llave (3 a 60 caracteres)");
        }
        const name = String(label ?? "").trim().slice(0, 30);
        if (spec.custom && name.length < 2) throw new Error("Ponle un nombre al medio de pago");
        if (Number(db.prepare("SELECT COUNT(*) AS n FROM pay_methods WHERE tenant_id = ?").get(tenantId).n) >= MAX_PAY_METHODS) throw new Error(`Máximo ${MAX_PAY_METHODS} medios de pago`);
        if (db.prepare("SELECT 1 FROM pay_methods WHERE tenant_id = ? AND kind = ? AND account = ?").get(tenantId, kind, acc)) throw new Error("Ya agregaste ese medio de pago");
        const id = newId("pm");
        const position = Number(db.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS n FROM pay_methods WHERE tenant_id = ?").get(tenantId).n);
        db.prepare("INSERT INTO pay_methods (id, tenant_id, kind, label, account, account_type, holder, note, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(id, tenantId, kind, spec.custom ? name : null, acc, kind === "bancolombia" ? accountType : null, String(holder ?? "").trim().slice(0, 80) || null, String(note ?? "").trim().slice(0, 120) || null, position, nowIso());
        return id;
      },
      remove(id) {
        const r = db.prepare("DELETE FROM pay_methods WHERE id = ? AND tenant_id = ?").run(id, tenantId);
        if (Number(r.changes) !== 1) throw new Error("Ese medio de pago no existe en este conjunto");
      },
    };

    /** Passkeys of this conjunto's people. Each person manages their own. */
    const MAX_PASSKEYS = 5;
    const passkeysOf = {
      list: (userId) => db.prepare("SELECT p.* FROM passkeys p JOIN users u ON u.id = p.user_id WHERE u.tenant_id = ? AND p.user_id = ? ORDER BY p.created_at").all(tenantId, userId)
        .map((r) => ({ id: r.id, name: r.name, credentialId: r.credential_id, createdAt: r.created_at, lastUsedAt: r.last_used_at })),
      add({ userId, credentialId, publicKey, alg, signCount = 0, name, transports = null }) {
        if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND tenant_id = ?").get(userId, tenantId)) throw new Error("Esa persona no es de este conjunto");
        if (Number(db.prepare("SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?").get(userId).n) >= MAX_PASSKEYS) throw new Error(`Máximo ${MAX_PASSKEYS} passkeys por persona`);
        const id = newId("pk");
        try {
          db.prepare("INSERT INTO passkeys (id, user_id, credential_id, public_key, alg, sign_count, name, transports, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .run(id, userId, credentialId, publicKey, alg, signCount, String(name ?? "").trim().slice(0, 40) || "Este dispositivo", transports ? JSON.stringify(transports).slice(0, 100) : null, nowIso());
        } catch (e) {
          if (/UNIQUE/.test(e.message)) throw new Error("Ese passkey ya está registrado");
          throw e;
        }
        return id;
      },
      remove(id, userId) {
        const r = db.prepare("DELETE FROM passkeys WHERE id = ? AND user_id = ? AND user_id IN (SELECT id FROM users WHERE tenant_id = ?)").run(id, userId, tenantId);
        if (Number(r.changes) !== 1) throw new Error("Ese passkey no existe");
      },
    };

    /** The WhatsApp messages this conjunto edited: `all()` is { key: text } for those only; the rest use the original. */
    const templates = {
      all: () => Object.fromEntries(db.prepare("SELECT key, body FROM message_templates WHERE tenant_id = ?").all(tenantId).map((r) => [r.key, r.body])),
      set(key, body) {
        if (!MESSAGE_KEYS.includes(key)) throw new Error("Ese mensaje no existe");
        const v = validateTemplate(key, body);
        if (!v.ok) throw new Error(v.error);
        db.prepare("INSERT INTO message_templates (tenant_id, key, body, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(tenant_id, key) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at").run(tenantId, key, v.body, nowIso());
      },
      reset: (key) => void db.prepare("DELETE FROM message_templates WHERE tenant_id = ? AND key = ?").run(tenantId, key),
    };

    /** What the conjunto spends. A mistake is voided (it stays visible as "anulado"), never erased. */
    const expenses = {
      create({ spentOn, amountCents, category, description, proof = null, userId = null }) {
        if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(String(spentOn)) || spentOn < "2024-01-01") throw new Error("La fecha del gasto no es válida");
        if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > 100_000_000_00) throw new Error("El valor del gasto no es válido");
        if (!EXPENSE_CATEGORIES.includes(category)) throw new Error("Esa categoría no existe");
        const text = String(description ?? "").trim().slice(0, 120);
        if (!text) throw new Error("Escribe en qué se gastó");
        if (proof && (!proof.mime || !proof.data?.length || proof.data.length > 5 * 1024 * 1024)) throw new Error("El soporte no es válido");
        const id = newId("gt");
        db.prepare("INSERT INTO expenses (id, tenant_id, spent_on, period, amount_cents, category, description, proof_mime, proof, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(id, tenantId, spentOn, spentOn.slice(0, 7), amountCents, category, text, proof?.mime ?? null, proof?.data ?? null, userId, nowIso());
        return { id };
      },
      /** The month's expenses (voided ones included, marked), newest first. No file bytes. */
      list: ({ period }) => db.prepare("SELECT id, spent_on, period, amount_cents, category, description, proof_mime, voided_at FROM expenses WHERE tenant_id = ? AND period = ? ORDER BY spent_on DESC, created_at DESC").all(tenantId, period)
        .map((r) => ({ id: r.id, spentOn: r.spent_on, period: r.period, amountCents: r.amount_cents, category: r.category, description: r.description, hasProof: !!r.proof_mime, voided: !!r.voided_at })),
      get(id) {
        const r = db.prepare("SELECT id, spent_on, period, amount_cents, category, description, proof_mime, voided_at FROM expenses WHERE id = ? AND tenant_id = ?").get(id, tenantId);
        return r ? { id: r.id, spentOn: r.spent_on, period: r.period, amountCents: r.amount_cents, category: r.category, description: r.description, hasProof: !!r.proof_mime, voided: !!r.voided_at } : null;
      },
      file(id) {
        const r = db.prepare("SELECT proof_mime, proof FROM expenses WHERE id = ? AND tenant_id = ? AND proof_mime IS NOT NULL").get(id, tenantId);
        return r ? { mime: r.proof_mime, data: Buffer.from(r.proof) } : null;
      },
      void(id) {
        const r = db.prepare("UPDATE expenses SET voided_at = ? WHERE id = ? AND tenant_id = ? AND voided_at IS NULL").run(nowIso(), id, tenantId);
        if (Number(r.changes) !== 1) throw new Error("Ese gasto no existe en este conjunto o ya está anulado");
      },
    };

    /**
     * The books of one month: money in (payments assigned to a house, by the day they were paid, Colombia time), money out
     * (expenses not voided) and the cash balance up to the end of that month: the opening balance + everything in - everything out.
     */
    function books(period) {
      const [from, to] = periodRange(period);
      const income = (a, b) => Number(db.prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS c FROM payments WHERE tenant_id = ? AND status = 'assigned' AND paid_at >= ? AND paid_at < ?`).get(tenantId, a, b).c);
      const out = (clause, ...args) => Number(db.prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS c FROM expenses WHERE tenant_id = ? AND voided_at IS NULL AND ${clause}`).get(tenantId, ...args).c);
      const byCategory = db.prepare("SELECT category, SUM(amount_cents) AS c FROM expenses WHERE tenant_id = ? AND period = ? AND voided_at IS NULL GROUP BY category ORDER BY c DESC").all(tenantId, period)
        .map((r) => ({ category: r.category, cents: Number(r.c) }));
      const opening = Number(db.prepare("SELECT opening_cents FROM tenants WHERE id = ?").get(tenantId).opening_cents);
      const incomeMonth = income(from, to);
      const spentMonth = out("period = ?", period);
      return {
        period, incomeCents: incomeMonth, spentCents: spentMonth, monthBalanceCents: incomeMonth - spentMonth, byCategory,
        openingCents: opening, cashCents: opening + income("0000", to) - out("period <= ?", period),
      };
    }

    /** Devices of this conjunto's people that get phone notifications. */
    const push = {
      /** A browser re-subscribing (even under another account of the same device) replaces its earlier row. */
      add({ userId, endpoint, p256dh, auth }) {
        if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND tenant_id = ?").get(userId, tenantId)) throw new Error("Esa persona no es de este conjunto");
        db.prepare("INSERT OR REPLACE INTO push_subscriptions (id, tenant_id, user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(newId("ps"), tenantId, userId, endpoint, p256dh, auth, nowIso());
      },
      list: ({ userId = null } = {}) => db.prepare(`SELECT endpoint, p256dh, auth, user_id FROM push_subscriptions WHERE tenant_id = ?${userId ? " AND user_id = ?" : ""}`)
        .all(...(userId ? [tenantId, userId] : [tenantId])).map((r) => ({ endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth, userId: r.user_id })),
      countForUser: (userId) => Number(db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE tenant_id = ? AND user_id = ?").get(tenantId, userId).n),
      remove: (endpoint) => void db.prepare("DELETE FROM push_subscriptions WHERE tenant_id = ? AND endpoint = ?").run(tenantId, endpoint),
    };

    /** Proofs of payment uploaded by residents. The file bytes are only returned by `get`; lists never carry them. */
    const MAX_PENDING_PER_HOUSE = 3;
    const proofMeta = (r) => ({
      id: r.id, houseId: r.house_id, houseCode: r.code, residentName: r.resident_name, mime: r.mime, size: r.size,
      note: r.note, status: r.status, paymentId: r.payment_id, createdAt: r.created_at,
    });
    const PROOF_COLS = "p.id, p.house_id, p.mime, p.size, p.note, p.status, p.payment_id, p.created_at, h.code, h.resident_name";
    const proofs = {
      create({ houseId, mime, data, note = null }) {
        return tx(() => {
          ownHouse(houseId);
          const pending = Number(db.prepare("SELECT COUNT(*) AS n FROM proofs WHERE tenant_id = ? AND house_id = ? AND status = 'pending'").get(tenantId, houseId).n);
          if (pending >= MAX_PENDING_PER_HOUSE) throw new Error("Ya tienes comprobantes esperando revisión");
          const id = newId("pf");
          db.prepare("INSERT INTO proofs (id, tenant_id, house_id, mime, size, data, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
            .run(id, tenantId, houseId, mime, data.length, data, String(note ?? "").trim().slice(0, 200) || null, nowIso());
          return { id };
        });
      },
      /** Waiting for the treasurer, oldest first. */
      listPending: () => db.prepare(`SELECT ${PROOF_COLS} FROM proofs p JOIN houses h ON h.id = p.house_id WHERE p.tenant_id = ? AND p.status = 'pending' AND h.active = 1 ORDER BY p.created_at`).all(tenantId).map(proofMeta),
      countPending: () => Number(db.prepare("SELECT COUNT(*) AS n FROM proofs p JOIN houses h ON h.id = p.house_id WHERE p.tenant_id = ? AND p.status = 'pending' AND h.active = 1").get(tenantId).n),
      /** What a resident sees about their own recent uploads (no bytes). */
      listForHouse(houseId) {
        ownHouse(houseId);
        return db.prepare(`SELECT ${PROOF_COLS} FROM proofs p JOIN houses h ON h.id = p.house_id WHERE p.tenant_id = ? AND p.house_id = ? ORDER BY p.created_at DESC LIMIT 5`).all(tenantId, houseId).map(proofMeta);
      },
      meta(id) {
        const r = db.prepare(`SELECT ${PROOF_COLS} FROM proofs p JOIN houses h ON h.id = p.house_id WHERE p.id = ? AND p.tenant_id = ?`).get(id, tenantId);
        return r ? proofMeta(r) : null;
      },
      /** The file itself, for the treasurer. */
      file(id) {
        const r = db.prepare("SELECT mime, data FROM proofs WHERE id = ? AND tenant_id = ?").get(id, tenantId);
        return r ? { mime: r.mime, data: Buffer.from(r.data) } : null;
      },
      reject(id) {
        const r = db.prepare("UPDATE proofs SET status = 'rejected', resolved_at = ? WHERE id = ? AND tenant_id = ? AND status = 'pending'").run(nowIso(), id, tenantId);
        if (Number(r.changes) !== 1) throw new Error("Ese comprobante no está pendiente en este conjunto");
      },
    };

    return { tenantId, houses, aliases, concepts, dues, payments, proofs, team, push, housePush, reminders, certificates, audit, payMethods, templates, passkeys: passkeysOf, expenses, books, reset, resetPreview, matchHouse, summary };
  }

  return { db, tenants, users, invitations, certificates, passkeys, webauthnChallenges, operators, operatorSessions, settings, sessions, residentByToken, forTenant, close: () => db.close() };
}
