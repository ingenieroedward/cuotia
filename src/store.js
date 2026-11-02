import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { namesMatch, normalizeName } from "./text.js";
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
];

const nowIso = () => new Date().toISOString();
const newId = (prefix) => `${prefix}_${randomBytes(8).toString("hex")}`;

const tenantRow = (r) => !r ? null : {
  id: r.id, slug: r.slug, name: r.name, payKey: r.pay_key, payHolder: r.pay_holder,
  // The secret itself never travels in the DTO: views get only whether it is set.
  pagoradarConfigured: !!r.pagoradar_secret, pagoradarLastAt: r.pagoradar_last_at,
};
const houseRow = (r) => !r ? null : { id: r.id, tenantId: r.tenant_id, code: r.code, residentName: r.resident_name, phone: r.phone, active: !!r.active };
const dueRow = (r) => ({
  id: r.id, houseId: r.house_id, conceptId: r.concept_id, period: r.period, amountCents: r.amount_cents,
  status: r.status, paymentId: r.payment_id, paidAt: r.paid_at,
  houseCode: r.house_code, residentName: r.resident_name, conceptName: r.concept_name,
});
const userRow = (r) => !r ? null : {
  id: r.id, tenantId: r.tenant_id, email: r.email, passwordHash: r.password_hash, role: r.role,
  totpSecret: r.totp_secret, totpEnabled: !!r.totp_enabled,
};
const paymentRow = (r) => !r ? null : {
  id: r.id, externalId: r.external_id, payerName: r.payer_name, payerNorm: r.payer_norm, amountCents: r.amount_cents,
  bank: r.bank, method: r.method, paidAt: r.paid_at, houseId: r.house_id, status: r.status,
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
    /** A correctly signed event arrived (even a test one): the panel shows the connection as alive. */
    touchPagoradar: (id) => void db.prepare("UPDATE tenants SET pagoradar_last_at = ? WHERE id = ?").run(nowIso(), id),
  };

  const users = {
    create({ tenantId, email, passwordHash, role = "tesorero" }) {
      const id = newId("usr");
      db.prepare("INSERT INTO users (id, tenant_id, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, tenantId, email.trim().toLowerCase(), passwordHash, role, nowIso());
      return id;
    },
    byEmail(email) {
      return userRow(db.prepare("SELECT * FROM users WHERE email = ?").get(String(email).trim().toLowerCase()));
    },
    byId: (id) => userRow(db.prepare("SELECT * FROM users WHERE id = ?").get(id)),
    /** Stores a not-yet-confirmed (encrypted) secret; it only counts after `enableTotp`. */
    setTotpSecret: (userId, encrypted) => void db.prepare("UPDATE users SET totp_secret = ?, totp_enabled = 0, totp_last_step = 0 WHERE id = ?").run(encrypted, userId),
    enableTotp: (userId) => void db.prepare("UPDATE users SET totp_enabled = 1 WHERE id = ?").run(userId),
    /** True once per time step: a code that was already used is refused, even inside its validity window. */
    claimTotpStep(userId, step) {
      return Number(db.prepare("UPDATE users SET totp_last_step = ? WHERE id = ? AND totp_last_step < ?").run(step, userId, step).changes) === 1;
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
        `SELECT u.id AS user_id, u.email, u.role, u.tenant_id, s.stage FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?`,
      ).get(sha256(token), nowIso());
      if (!r) return null;
      return { stage: r.stage, user: { id: r.user_id, email: r.email, role: r.role, tenantId: r.tenant_id }, tenant: tenants.get(r.tenant_id) };
    },
    /** After a valid code: a fresh full session replaces the pending one, so the cookie value changes at privilege change. */
    promote(token, ttlMs = 12 * 3600_000) {
      const s = sessions.resolve(token);
      if (!s) return null;
      sessions.delete(token);
      return sessions.create(s.user.id, { stage: "full", ttlMs });
    },
    delete: (token) => void db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token)),
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
      list: (houseId) => db.prepare("SELECT name_norm FROM aliases WHERE tenant_id = ? AND house_id = ?").all(tenantId, houseId).map((r) => r.name_norm),
      /** The one house that uses this name, or null when none or several do (never guess). */
      houseFor(norm) {
        const rows = db.prepare("SELECT DISTINCT house_id FROM aliases WHERE tenant_id = ? AND name_norm = ?").all(tenantId, norm);
        return rows.length === 1 ? rows[0].house_id : null;
      },
    };

    const concepts = {
      create({ name, amountCents }) {
        const id = newId("cn");
        db.prepare("INSERT INTO concepts (id, tenant_id, name, amount_cents) VALUES (?, ?, ?, ?)").run(id, tenantId, name, amountCents);
        return id;
      },
      list: () => db.prepare("SELECT * FROM concepts WHERE tenant_id = ? AND active = 1 ORDER BY name").all(tenantId).map((r) => ({ id: r.id, name: r.name, amountCents: r.amount_cents })),
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
      listByPeriod: (period) => db.prepare(`${DUE_SELECT} WHERE d.tenant_id = ? AND d.period = ? ORDER BY h.code, c.name`).all(tenantId, period).map(dueRow),
      listForHouse: (houseId) => db.prepare(`${DUE_SELECT} WHERE d.tenant_id = ? AND d.house_id = ? ORDER BY d.period DESC, c.name`).all(tenantId, houseId).map(dueRow),
      /** The oldest unpaid due of this house for exactly this amount. */
      oldestOpen(houseId, amountCents) {
        const r = db.prepare("SELECT * FROM dues WHERE tenant_id = ? AND house_id = ? AND amount_cents = ? AND status = 'pending' ORDER BY period LIMIT 1").get(tenantId, houseId, amountCents);
        return r ? { id: r.id, period: r.period, amountCents: r.amount_cents } : null;
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
      /** A payment in cash: settles the house's oldest open due for that due's amount. */
      recordCash(houseId, paidAt = nowIso()) {
        return tx(() => {
          ownHouse(houseId);
          const due = db.prepare("SELECT * FROM dues WHERE tenant_id = ? AND house_id = ? AND status = 'pending' ORDER BY period LIMIT 1").get(tenantId, houseId);
          if (!due) throw new Error("Esa casa no tiene cuotas pendientes");
          const id = newId("pg");
          const house = houseRow(houseOf(houseId));
          db.prepare(
            `INSERT INTO payments (id, tenant_id, external_id, payer_name, payer_norm, amount_cents, bank, method, paid_at, house_id, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, NULL, 'cash', ?, ?, 'assigned', ?)`,
          ).run(id, tenantId, `cash_${id}`, `Efectivo · ${house.residentName}`, "EFECTIVO", due.amount_cents, paidAt, houseId, nowIso());
          dues.settle(due.id, id, paidAt);
          return { paymentId: id, dueId: due.id, amountCents: due.amount_cents };
        });
      },
      listUnassigned: () => db.prepare("SELECT * FROM payments WHERE tenant_id = ? AND status = 'unassigned' ORDER BY paid_at DESC").all(tenantId).map(paymentRow),
      /** Gives an unassigned payment to a house, settles its oldest open due of that amount, and (optionally) remembers the payer's name. */
      assign(paymentId, houseId, { rememberAlias = true } = {}) {
        return tx(() => {
          const p = payments.get(paymentId);
          if (!p) throw new Error("Ese pago no existe en este conjunto");
          if (p.status !== "unassigned") throw new Error("Ese pago ya está asignado");
          ownHouse(houseId);
          db.prepare("UPDATE payments SET house_id = ?, status = 'assigned' WHERE id = ? AND tenant_id = ?").run(houseId, paymentId, tenantId);
          const due = dues.oldestOpen(houseId, p.amountCents);
          const settled = due ? dues.settle(due.id, paymentId, p.paidAt) : false;
          if (rememberAlias) aliases.add(houseId, p.payerName);
          return { dueId: settled ? due.id : null };
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
      const rows = db.prepare("SELECT status, COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents FROM dues WHERE tenant_id = ? AND period = ? GROUP BY status").all(tenantId, period);
      const pick = (s) => rows.find((r) => r.status === s) ?? { n: 0, cents: 0 };
      const un = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents FROM payments WHERE tenant_id = ? AND status = 'unassigned'").get(tenantId);
      return {
        period,
        expectedCents: Number(pick("paid").cents) + Number(pick("pending").cents),
        collectedCents: Number(pick("paid").cents),
        paidCount: Number(pick("paid").n),
        pendingCount: Number(pick("pending").n),
        unassignedCount: Number(un.n),
        unassignedCents: Number(un.cents),
      };
    }

    return { tenantId, houses, aliases, concepts, dues, payments, matchHouse, summary };
  }

  return { db, tenants, users, sessions, residentByToken, forTenant, close: () => db.close() };
}
