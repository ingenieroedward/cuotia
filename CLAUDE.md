# CLAUDE.md

Guidance for Claude Code (claude.ai/code) in this repository.

## What this is

Cuotia collects recurring community fees (vigilancia now, administración later) for urbanizaciones and conjuntos in Colombia. Residents pay by Bre-B; **pagoradar** (a separate, already deployed service, `ingenieroedward/pagoradar`, read-only reference, never modify it from here) reads the bank notice and sends Cuotia a signed `payment.received` webhook. Cuotia owns the ledger: houses, dues, payments, aliases. It is **multi-tenant**: each conjunto sees only its own data. Pilot: Jardines de Ibiza (~45 houses, $30.000/month, one person holds the bank account).

## Commands

```bash
npm test                         # node:test, test/**/*.test.js
MASTER_KEY=$(openssl rand -hex 32) npm start
npm run admin -- crear-conjunto --slug ibiza --nombre "Jardines de Ibiza" --correo tesorera@ejemplo.com --llave @llave --titular "Titular"
npm run admin -- agregar-casa --conjunto ibiza --codigo 14 --residente "Sandra Duque"   # prints the resident's personal link
npm run admin -- generar-cuotas --conjunto ibiza --periodo 2026-11
```

No build step, no linter, **no runtime dependencies** (keep it that way: `node:sqlite`, `node:crypto`, `node:http`). Requires Node ≥ 22.5.

## Architecture

```
pagoradar ──signed webhook──▶ POST /webhooks/pagoradar/<tenantId> ─▶ verify with THAT tenant's secret ─▶ ingestEvent ─▶ store.forTenant(tenantId)
```

- **`src/app.js`**: plain `(req, res)` router. Per-conjunto webhook `/webhooks/pagoradar/<tenantId>` (HMAC check over the exact body *before* parsing, with the secret of the tenant in the URL), login/logout, panel, resident link `/r/<token>`, one static file.
- **`src/store.js`**: single SQLite DB, migrations `V1`… by `PRAGMA user_version` (never edit an earlier one). **Tenant isolation rule: all data of a conjunto is reached through `store.forTenant(id)`**, which closes over the tenant id. Never add a query on tenant data outside it. The only global lookups are `tenants`, `users`, `sessions` and `residentByToken` (the unguessable token is the credential). Every method that takes a house/payment id re-checks it belongs to the tenant. `test/isolation.test.js` guards this: extend it whenever you add a repo method.
- **`src/pagoradar.js`**: `ingestEvent` maps a verified event to ledger changes. **The conjunto is the one in the webhook URL** (whose secret signed the event); an optional `data.account.tenantRef` must equal it or the event is ignored (`tenant_mismatch`). It auto-settles only when the payer matches **one** house (remembered alias, else unique name match) **and** that house has an open due for exactly the amount; everything else goes to the "por asignar" queue. Never guess. Idempotent by pagoradar payment id, stored as `<tenantId>:<id>` so two conjuntos' pagoradars can reuse ids.
- **pagoradar config is per conjunto and lives in the DB, never in env.** `tenants.pagoradar_secret` is AES-GCM encrypted with `MASTER_KEY` (V3); the tenant DTO exposes only `pagoradarConfigured`/`pagoradarLastAt`, never the secret. Set from the panel (`/panel/ajustes`) or `npm run admin -- configurar-pagoradar`. No secret yet → the URL answers 503 so pagoradar retries. Any correctly signed event (even `payment.test`) updates `pagoradar_last_at`, which Ajustes shows as "Conectado". Do not reintroduce a global pagoradar secret.
- **Matching model:** dues are charged at the exact base amount (no unique-amount trick). `payments.assign(..., {rememberAlias})` teaches Cuotia the payer's name for next time.
- **`src/security.js`**: scrypt passwords, session/resident tokens (only SHA-256 hashes stored), pagoradar signature check (same algorithm as pagoradar's SDK: `Pagoradar-Signature: t=…,v1=HMAC(secret,"t.body")`, 5-minute tolerance), attempt limiter, AES-256-GCM `encryptSecret/decryptSecret` with `MASTER_KEY`, TOTP (RFC 6238, no library), per-session CSRF token.
- **Login is two steps and mandatory.** Password → a short session with `stage` `pending` (has TOTP) or `setup` (must enroll); only `/2fa` accepts it. A valid code → `sessions.promote` issues a *new* `full` session (token changes at privilege change). TOTP secrets are stored encrypted; `users.claimTotpStep` makes each code single-use. Lose `MASTER_KEY` and nobody can sign in: back it up. Every panel route requires `stage === "full"`.
- **First run: `/setup?token=…`.** With no conjunto in the DB, `server.js` prints a private one-use link (token = `SETUP_TOKEN` or random per boot). The form creates the first conjunto, its "Vigilancia" concept and the treasurer with a password they choose. `setupOpen` = no tenants AND `safeEqual(token)`; otherwise it answers the normal 404 so it never reveals whether setup exists. Re-checked synchronously after the async password hash so two simultaneous submits create one conjunto (tested). Wrong tokens are rate limited. There is deliberately **no open sign-up**: more conjuntos are created by the operator (CLI today).
- **`src/qr.js`: QR generator with no dependencies** (byte mode, level L, versions 1-9 = up to 230 bytes; `qrSvg` returns an inline SVG with colors as attributes because the CSP forbids inline styles). It draws the 2-step enrollment QR (an `otpauth://` link, ~100 bytes = version 5). It was verified against an independent decoder (jsQR, in a scratch dir, not a dependency) for every length 1-230 and against the page rendered in Chromium in light and dark mode. The repo's own tests (`test/qr.test.js`) read a symbol back (format info, mask, zigzag, Reed-Solomon, text) so a regression in placement or masking fails CI. Don't add a QR library; if the link ever exceeds 230 bytes, extend the tables to versions 10+ (16-bit character count).
- **Every panel POST** checks same Origin **and** the session's `_csrf` form field (`csrfToken(sessionToken)`, HMAC of the HttpOnly cookie value). Flash messages come from a fixed list keyed by `?m=`; never reflect query text. **`Referrer-Policy` must stay `same-origin`**: with `no-referrer` browsers post forms with `Origin: null` and the Origin check refuses every login (found by a real-browser run; `fetch` tests can't see it).
- **`src/views.js` + `src/http.js`**: server-rendered HTML. The `html` tagged template escapes every interpolation unless it is `html`/`raw()` output; use it for all markup. CSP is `default-src 'self'` with no inline styles or scripts: use classes in `public/app.css`, never `style=""`.
- **Design:** tokens and layout in `public/app.css`, from the approved mockups (ink `#0b1b2b` + lime `#c6f25c`, Plus Jakarta Sans, mobile first, light/dark). The mockup canvas: https://claude.ai/artifact/57BSgLaPW6LwbXJpm8bk8L

## Conventions

- User-facing strings (UI, errors, logs, docs) are **Spanish (Colombian)**; code identifiers and comments are English.
- Money is integer cents (`amountCents`); show with `peso()`. Periods are `"YYYY-MM"` in Colombia time (`currentPeriod()`).
- Tests: `node:test` + in-memory store, **made-up data only**. `test/fixtures.js` has `twoConjuntos()` and `paymentEvent()`.
- Deployment: Docker Compose on Dokploy. Data volume pinned to `cuotia-data`; don't rename it.

## Houses, history and undo

- A house is never deleted: `houses.setActive(false)` keeps all history but closes its personal link, skips it in `dues.generate` and in matching (`aliases.houseFor` and `matchHouse` only see active houses), and its **unpaid** dues stop counting in `summary`/`listByPeriod` (its **paid** ones keep counting).
- `payments.list({period,status,houseId,q,limit,offset})` is the history (newest first). `period` is a Colombia-time month (`periodRange`, UTC-5). The search escapes `LIKE` wildcards and skips the payer-name clause when the needle normalizes to nothing. The CSV (`/panel/pagos.csv`) is `;`-separated with a UTF-8 BOM (what Spanish Excel opens correctly) and every cell goes through `csvCell`, which neutralizes a leading `= + - @` so a payer's name can't run as a spreadsheet formula. Tests read the BOM from raw bytes because `fetch().text()` strips it.
- `payments.revert` undoes an assignment: the due returns to pending; a bank payment goes back to "por asignar" and the alias learned for that house is deleted; a cash payment (which exists only here) is deleted. The UI hides it inside `<details>` so a stray tap does nothing and no script is needed.
- Any new route that takes a house, alias or payment id must go through `forTenant` methods that re-check ownership, and needs a case in the "un tesorero no puede ver ni tocar…" server test.

## Not built yet (next steps)

- Passkeys; password change and reset (an admin has to reset a lost authenticator today: clear `totp_secret`/`totp_enabled` in the DB).
- Self-hosted font files (the CSP blocks Google Fonts; falls back to the system font).
- Operator panel to create conjuntos (CLI only today), invitations for more treasurers, WhatsApp reminders, public transparency page, expenses, administración as a second concept, editing the Bre-B key and holder from Ajustes (CLI only today).
- Cuotia doesn't create pagoradar charges: residents pay the exact amount to the conjunto's Bre-B key and the payer's name does the matching. A payer reverted from a house can still auto-match it again through a unique match with the resident's name.
