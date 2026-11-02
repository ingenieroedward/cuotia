import test from "node:test";
import assert from "node:assert/strict";
import { ingestEvent } from "../src/pagoradar.js";
import { paymentEvent, twoConjuntos } from "./fixtures.js";

test("un pago con el nombre del residente salda su cuota solo", () => {
  const { store, a, A, a14 } = twoConjuntos();
  A.dues.generate("2026-11");
  const r = ingestEvent(store, paymentEvent({ tenantRef: a.id, payerName: "SANDRA MARIA DUQUE ARIAS" }), a.id);
  assert.equal(r.status, "assigned");
  const due = A.dues.listForHouse(a14.house.id)[0];
  assert.equal(due.status, "paid");
  assert.equal(due.paymentId, r.paymentId);
  assert.equal(A.summary("2026-11").collectedCents, 3_000_000);
});

test("un nombre desconocido queda por asignar; al asignarlo se recuerda y el siguiente es automático", () => {
  const { store, a, A, a14 } = twoConjuntos();
  A.dues.generate("2026-11");
  const first = ingestEvent(store, paymentEvent({ id: "pay_1", tenantRef: a.id, payerName: "Pedro Duque" }), a.id);
  assert.equal(first.status, "unassigned");
  assert.equal(A.payments.listUnassigned().length, 1);
  assert.equal(A.summary("2026-11").unassignedCount, 1);

  const { dueId } = A.payments.assign(first.paymentId, a14.house.id);
  assert.ok(dueId);
  assert.equal(A.payments.listUnassigned().length, 0);

  A.dues.generate("2026-12");
  const second = ingestEvent(store, paymentEvent({ id: "pay_2", tenantRef: a.id, payerName: "PEDRO DUQUE", paidAt: "2026-12-02T10:00:00.000Z" }), a.id);
  assert.equal(second.status, "assigned", "el alias aprendido concilia solo");
});

test("un monto distinto al de la cuota no se concilia solo", () => {
  const { store, a, A, a14 } = twoConjuntos();
  A.dues.generate("2026-11");
  const r = ingestEvent(store, paymentEvent({ tenantRef: a.id, payerName: "Sandra Duque Arias", amountCents: 6_000_000 }), a.id);
  assert.equal(r.status, "unassigned");
  assert.equal(A.dues.listForHouse(a14.house.id)[0].status, "pending");
});

test("sin cuota abierta tampoco se concilia solo", () => {
  const { store, a } = twoConjuntos();
  assert.equal(ingestEvent(store, paymentEvent({ tenantRef: a.id, payerName: "Sandra Duque Arias" }), a.id).status, "unassigned");
});

test("el mismo pago dos veces se registra una sola vez", () => {
  const { store, a, A } = twoConjuntos();
  A.dues.generate("2026-11");
  const ev = paymentEvent({ tenantRef: a.id, payerName: "Sandra Duque Arias" });
  assert.equal(ingestEvent(store, ev, a.id).status, "assigned");
  assert.equal(ingestEvent(store, ev, a.id).status, "duplicate");
  assert.equal(A.summary("2026-11").paidCount, 1);
});

test("el conjunto es el de la URL: sin tenantRef se acepta, con otro tenantRef se ignora", () => {
  const { store, a, b, A, B } = twoConjuntos();
  A.dues.generate("2026-11");
  B.dues.generate("2026-11");

  // pagoradar account of A carrying B's reference (misconfigured): nothing is booked anywhere.
  const wrong = ingestEvent(store, paymentEvent({ tenantRef: b.id, payerName: "Sandra Duque Arias" }), a.id);
  assert.deepEqual([wrong.status, wrong.reason], ["ignored", "tenant_mismatch"]);
  assert.equal(A.summary("2026-11").collectedCents, 0);
  assert.equal(B.payments.listUnassigned().length + A.payments.listUnassigned().length, 0);

  // No tenantRef at all: the URL (and its secret) already say which conjunto it is.
  const bare = paymentEvent({ payerName: "Sandra Duque Arias" });
  delete bare.data.account.tenantRef;
  assert.equal(ingestEvent(store, bare, a.id).status, "assigned");
  assert.equal(B.summary("2026-11").collectedCents, 0, "el otro conjunto no se toca");
});

test("dos conjuntos con el mismo id de pago de pagoradar no se bloquean entre sí", () => {
  const { store, a, b, A, B } = twoConjuntos();
  A.dues.generate("2026-11");
  B.dues.generate("2026-11");
  const sameId = { id: "pay_igual" };
  assert.equal(ingestEvent(store, paymentEvent({ ...sameId, payerName: "Sandra Duque Arias" }), a.id).status, "assigned");
  assert.equal(ingestEvent(store, paymentEvent({ ...sameId, payerName: "Carlos Mejía" }), b.id).status, "assigned");
  assert.equal(A.summary("2026-11").paidCount, 1);
  assert.equal(B.summary("2026-11").paidCount, 1);
});

test("eventos que no son pagos, de un conjunto inexistente o mal formados se ignoran", () => {
  const { store, a } = twoConjuntos();
  assert.equal(ingestEvent(store, { type: "payment.test", data: {} }, a.id).status, "ignored");
  assert.equal(ingestEvent(store, { type: "account.silent", data: {} }, a.id).status, "ignored");
  assert.equal(ingestEvent(store, paymentEvent({ payerName: "X" }), "ten_nada").reason, "unknown_tenant");
  assert.equal(ingestEvent(store, paymentEvent({ tenantRef: a.id, payerName: "X", amountCents: -5 }), a.id).reason, "invalid_payment");
  assert.equal(ingestEvent(store, null, a.id).status, "ignored");
});
