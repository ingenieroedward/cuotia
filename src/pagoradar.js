import { normalizeName } from "./text.js";

/**
 * Turns a verified pagoradar event into ledger changes. Never throws on bad data: it returns what happened.
 *
 * The conjunto is the one whose webhook URL (and so whose secret) delivered the event: `tenantId`. If the pagoradar
 * account also carries a `tenantRef`, it must agree, so a payment can't land in a conjunto other than the one
 * whose bank account received it, even by a misconfigured pagoradar app.
 *
 * @returns {{ status: "ignored" | "duplicate" | "assigned" | "unassigned", reason?: string, paymentId?: string, dueId?: string }}
 */
export function ingestEvent(store, event, tenantId) {
  if (event?.type !== "payment.received") return { status: "ignored", reason: String(event?.type ?? "sin_tipo") };

  const d = event.data ?? {};
  const tenant = store.tenants.get(tenantId);
  if (!tenant) return { status: "ignored", reason: "unknown_tenant" };
  const tenantRef = d.account?.tenantRef;
  if (tenantRef !== undefined && tenantRef !== null && tenantRef !== "" && tenantRef !== tenant.id) {
    return { status: "ignored", reason: "tenant_mismatch" };
  }

  const amountCents = d.amountCents;
  if (typeof d.id !== "string" || !Number.isSafeInteger(amountCents) || amountCents <= 0 || Number.isNaN(Date.parse(d.paidAt))) {
    return { status: "ignored", reason: "invalid_payment" };
  }

  const ledger = store.forTenant(tenant.id);
  const payerName = String(d.payerName ?? "").trim();
  const { created, payment } = ledger.payments.record({
    // Namespaced: two conjuntos with their own pagoradar may reuse an id, and one must never block the other.
    externalId: `${tenant.id}:${d.id}`,
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
