import { normalizeName } from "./text.js";

/**
 * Turns a verified pagoradar event into ledger changes. Never throws on bad data: it returns what happened.
 *
 * The conjunto comes from `data.account.tenantRef` (set on the pagoradar account when the conjunto is created),
 * so a payment can only ever land in the conjunto whose bank account received it.
 *
 * @returns {{ status: "ignored" | "duplicate" | "assigned" | "unassigned", reason?: string, paymentId?: string, dueId?: string }}
 */
export function ingestEvent(store, event) {
  if (event?.type !== "payment.received") return { status: "ignored", reason: String(event?.type ?? "sin_tipo") };

  const d = event.data ?? {};
  const tenantRef = d.account?.tenantRef;
  const tenant = typeof tenantRef === "string" ? store.tenants.get(tenantRef) : null;
  if (!tenant) return { status: "ignored", reason: "unknown_tenant" };

  const amountCents = d.amountCents;
  if (typeof d.id !== "string" || !Number.isSafeInteger(amountCents) || amountCents <= 0 || Number.isNaN(Date.parse(d.paidAt))) {
    return { status: "ignored", reason: "invalid_payment" };
  }

  const ledger = store.forTenant(tenant.id);
  const payerName = String(d.payerName ?? "").trim();
  const { created, payment } = ledger.payments.record({
    externalId: d.id,
    payerName,
    payerNorm: normalizeName(payerName),
    amountCents,
    bank: d.bank ?? null,
    method: d.method ?? null,
    paidAt: new Date(d.paidAt).toISOString(),
  });
  if (!created) return { status: "duplicate", paymentId: payment.id };

  // Automatic only when we know the house AND it has an open due for exactly this amount;
  // anything else (an extra payment, a partial one, an unknown payer) waits for the treasurer.
  const houseId = ledger.matchHouse(payerName);
  if (houseId && ledger.dues.oldestOpen(houseId, amountCents)) {
    const { dueId } = ledger.payments.assign(payment.id, houseId, { rememberAlias: false });
    return { status: "assigned", paymentId: payment.id, dueId };
  }
  return { status: "unassigned", paymentId: payment.id };
}
