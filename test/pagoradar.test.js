import test from "node:test";
import assert from "node:assert/strict";
import { ingestEvent } from "../src/pagoradar.js";
import { paymentEvent, twoConjuntos } from "./fixtures.js";

test("un pago con el nombre del residente salda su cuota solo", () => {
  const { store, a, A, a14 } = twoConjuntos();
  A.dues.generate("2026-11");
  const r = ingestEvent(store, paymentEvent({ tenantRef: a.id, payerName: "SANDRA MARIA DUQUE ARIAS" }));
  assert.equal(r.status, "assigned");
  const due = A.dues.listForHouse(a14.house.id)[0];
  assert.equal(due.status, "paid");
  assert.equal(due.paymentId, r.paymentId);
  assert.equal(A.summary("2026-11").collectedCents, 3_000_000);
});

test("un nombre desconocido queda por asignar; al asignarlo se recuerda y el siguiente es automático", () => {
  const { store, a, A, a14 } = twoConjuntos();
  A.dues.generate("2026-11");
  const first = ingestEvent(store, paymentEvent({ id: "pay_1", tenantRef: a.id, payerName: "Pedro Duque" }));
  assert.equal(first.status, "unassigned");
  assert.equal(A.payments.listUnassigned().length, 1);
  assert.equal(A.summary("2026-11").unassignedCount, 1);

  const { dueId } = A.payments.assign(first.paymentId, a14.house.id);
  assert.ok(dueId);
  assert.equal(A.payments.listUnassigned().length, 0);

  A.dues.generate("2026-12");
  const second = ingestEvent(store, paymentEvent({ id: "pay_2", tenantRef: a.id, payerName: "PEDRO DUQUE", paidAt: "2026-12-02T10:00:00.000Z" }));
  assert.equal(second.status, "assigned", "el alias aprendido concilia solo");
});

test("un monto distinto al de la cuota no se concilia solo", () => {
  const { store, a, A, a14 } = twoConjuntos();
  A.dues.generate("2026-11");
  const r = ingestEvent(store, paymentEvent({ tenantRef: a.id, payerName: "Sandra Duque Arias", amountCents: 6_000_000 }));
  assert.equal(r.status, "unassigned");
  assert.equal(A.dues.listForHouse(a14.house.id)[0].status, "pending");
});

test("sin cuota abierta tampoco se concilia solo", () => {
  const { store, a } = twoConjuntos();
  const r = ingestEvent(store, paymentEvent({ tenantRef: a.id, payerName: "Sandra Duque Arias" }));
  assert.equal(r.status, "unassigned");
});

test("el mismo pago dos veces se registra una sola vez", () => {
  const { store, a, A } = twoConjuntos();
  A.dues.generate("2026-11");
  const ev = paymentEvent({ tenantRef: a.id, payerName: "Sandra Duque Arias" });
  assert.equal(ingestEvent(store, ev).status, "assigned");
  assert.equal(ingestEvent(store, ev).status, "duplicate");
  assert.equal(A.summary("2026-11").paidCount, 1);
});

test("un pago cae solo en el conjunto de su cuenta receptora", () => {
  const { store, b, A, B } = twoConjuntos();
  A.dues.generate("2026-11");
  B.dues.generate("2026-11");
  // The payer matches a house of A, but the bank account belongs to B.
  const r = ingestEvent(store, paymentEvent({ tenantRef: b.id, payerName: "Sandra Duque Arias" }));
  assert.equal(r.status, "unassigned");
  assert.equal(A.summary("2026-11").collectedCents, 0);
  assert.equal(B.payments.listUnassigned().length, 1);
  assert.equal(A.payments.listUnassigned().length, 0);
});

test("eventos que no son pagos, sin conjunto o mal formados se ignoran", () => {
  const { store, a } = twoConjuntos();
  assert.equal(ingestEvent(store, { type: "payment.test", data: {} }).status, "ignored");
  assert.equal(ingestEvent(store, { type: "account.silent", data: {} }).status, "ignored");
  assert.equal(ingestEvent(store, paymentEvent({ tenantRef: "ten_nada", payerName: "X" })).reason, "unknown_tenant");
  assert.equal(ingestEvent(store, paymentEvent({ tenantRef: a.id, payerName: "X", amountCents: -5 })).reason, "invalid_payment");
  assert.equal(ingestEvent(store, null).status, "ignored");
});
