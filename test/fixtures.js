import { openStore } from "../src/store.js";

/** Each conjunto has its own pagoradar secret. */
export const SECRET_A = "secreto-pagoradar-de-ibiza";
export const SECRET_B = "secreto-pagoradar-de-robles";

/** A store with two conjuntos, each with houses and a Vigilancia concept of $30.000. Made-up data only. */
export function twoConjuntos() {
  const store = openStore(":memory:");
  const a = store.tenants.create({ slug: "ibiza", name: "Jardines de Ibiza", payKey: "@ibiza", payHolder: "Marta Rojas" });
  const b = store.tenants.create({ slug: "robles", name: "Los Robles" });
  const A = store.forTenant(a.id);
  const B = store.forTenant(b.id);
  for (const L of [A, B]) L.concepts.create({ name: "Vigilancia", amountCents: 3_000_000 });
  const a14 = A.houses.create({ code: "14", residentName: "Sandra Duque Arias" });
  const a03 = A.houses.create({ code: "03", residentName: "Diana Pérez" });
  const b01 = B.houses.create({ code: "01", residentName: "Carlos Mejía" });
  return { store, a, b, A, B, a14, a03, b01 };
}

/** A pagoradar `payment.received` event, as the webhook delivers it. */
export function paymentEvent({ id = "pay_1", tenantRef, payerName, amountCents = 3_000_000, paidAt = "2026-11-03T15:22:53.000Z" }) {
  return {
    id: `evt_${id}`,
    type: "payment.received",
    createdAt: paidAt,
    data: { id, bank: "nequi_negocios", method: "breb_qr", amountCents, amount: amountCents / 100, currency: "COP", payerName, paidAt, account: { id: "acc_1", name: "Cuenta", tenantRef } },
  };
}
