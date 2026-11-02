# CLAUDE.md

Guidance for Claude Code (claude.ai/code) in this repository.

## What this is

Cuotia collects recurring community fees (vigilancia now, administración later) for urbanizaciones and conjuntos in Colombia. Residents pay by Bre-B; **pagoradar** (a separate, already deployed service, `ingenieroedward/pagoradar`, read-only reference, never modify it from here) reads the bank notice and sends Cuotia a signed `payment.received` webhook. Cuotia owns the ledger: houses, dues, payments, aliases. It is **multi-tenant**: each conjunto sees only its own data. Pilot: Jardines de Ibiza (~45 houses, $30.000/month, one person holds the bank account).

## Commands

```bash
npm test                         # node:test, test/**/*.test.js
PAGORADAR_WEBHOOK_SECRET=dev npm start
npm run admin -- crear-conjunto --slug ibiza --nombre "Jardines de Ibiza" --correo tesorera@ejemplo.com --llave @llave --titular "Titular"
npm run admin -- agregar-casa --conjunto ibiza --codigo 14 --residente "Sandra Duque"   # prints the resident's personal link
npm run admin -- generar-cuotas --conjunto ibiza --periodo 2026-11
```

No build step, no linter, **no runtime dependencies** (keep it that way: `node:sqlite`, `node:crypto`, `node:http`). Requires Node ≥ 22.5.

## Architecture

```
pagoradar ──signed webhook──▶ POST /webhooks/pagoradar ─▶ pagoradar.js ingestEvent ─▶ store.forTenant(tenantRef)
```

- **`src/app.js`**: plain `(req, res)` router. Webhook (HMAC check over the exact body *before* parsing), login/logout, panel, resident link `/r/<token>`, one static file.
- **`src/store.js`**: single SQLite DB, migrations `V1`… by `PRAGMA user_version` (never edit an earlier one). **Tenant isolation rule: all data of a conjunto is reached through `store.forTenant(id)`**, which closes over the tenant id. Never add a query on tenant data outside it. The only global lookups are `tenants`, `users`, `sessions` and `residentByToken` (the unguessable token is the credential). Every method that takes a house/payment id re-checks it belongs to the tenant. `test/isolation.test.js` guards this: extend it whenever you add a repo method.
- **`src/pagoradar.js`**: `ingestEvent` maps a verified event to ledger changes. The conjunto is `data.account.tenantRef` (= tenant id, set on the pagoradar receiving account), so a payment lands only in the conjunto whose bank account received it. It auto-settles only when the payer matches **one** house (remembered alias, else unique name match) **and** that house has an open due for exactly the amount; everything else goes to the "por asignar" queue. Never guess. Idempotent by pagoradar payment id (`payments.external_id` UNIQUE).
- **Matching model:** dues are charged at the exact base amount (no unique-amount trick). `payments.assign(..., {rememberAlias})` teaches Cuotia the payer's name for next time.
- **`src/security.js`**: scrypt passwords, session/resident tokens (only SHA-256 hashes stored), pagoradar signature check (same algorithm as pagoradar's SDK: `Pagoradar-Signature: t=…,v1=HMAC(secret,"t.body")`, 5-minute tolerance), login attempt limiter.
- **`src/views.js` + `src/http.js`**: server-rendered HTML. The `html` tagged template escapes every interpolation unless it is `html`/`raw()` output; use it for all markup. CSP is `default-src 'self'` with no inline styles or scripts: use classes in `public/app.css`, never `style=""`.
- **Design:** tokens and layout in `public/app.css`, from the approved mockups (ink `#0b1b2b` + lime `#c6f25c`, Plus Jakarta Sans, mobile first, light/dark). The mockup canvas: https://claude.ai/artifact/57BSgLaPW6LwbXJpm8bk8L

## Conventions

- User-facing strings (UI, errors, logs, docs) are **Spanish (Colombian)**; code identifiers and comments are English.
- Money is integer cents (`amountCents`); show with `peso()`. Periods are `"YYYY-MM"` in Colombia time (`currentPeriod()`).
- Tests: `node:test` + in-memory store, **made-up data only**. `test/fixtures.js` has `twoConjuntos()` and `paymentEvent()`.
- Deployment: Docker Compose on Dokploy. Data volume pinned to `cuotia-data`; don't rename it.

## Not built yet (next steps)

- Two-step login (TOTP) and passkeys for the treasurer, as in pagoradar. Today: password + HttpOnly/SameSite=Strict session + Origin check + attempt limiter.
- Panel actions: assign unassigned payments, generate dues, register a cash payment, add/edit houses (the logic exists in `store.js`; only the HTML/forms are missing; use the CLI meanwhile).
- Self-hosted font files (the CSP blocks Google Fonts; falls back to the system font).
- Operator panel to create conjuntos, invitations, WhatsApp reminders, public transparency page, expenses.
