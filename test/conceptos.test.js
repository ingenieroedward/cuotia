import test from "node:test";
import assert from "node:assert/strict";
import { ingestEvent } from "../src/pagoradar.js";
import { paymentEvent, twoConjuntos } from "./fixtures.js";

test("conceptos: solo los mensuales activos se cobran cada mes; un valor nuevo no toca las cuotas ya creadas", () => {
  const { A, a14, a03 } = twoConjuntos();
  const adm = A.concepts.create({ name: "Administración", amountCents: 12_000_000 });
  assert.equal(A.dues.generate("2026-11"), 4, "2 casas × 2 conceptos");
  assert.deepEqual(A.dues.listForHouse(a14.house.id).map((d) => [d.conceptName, d.amountCents]), [["Administración", 12_000_000], ["Vigilancia", 3_000_000]]);

  A.concepts.setAmount(adm, 15_000_000);
  assert.equal(A.dues.listForHouse(a14.house.id).find((d) => d.conceptName === "Administración").amountCents, 12_000_000, "la cuota ya creada conserva su valor");
  A.dues.generate("2026-12");
  assert.equal(A.dues.listByPeriod("2026-12").find((d) => d.conceptName === "Administración").amountCents, 15_000_000, "la nueva usa el valor nuevo");

  A.concepts.setActive(adm, false);
  assert.equal(A.dues.generate("2027-01"), 2, "en pausa: solo vigilancia");
  assert.throws(() => A.concepts.setActive(A.concepts.list()[0].id, false), /al menos un cobro mensual/);
  A.concepts.setActive(adm, true);
  assert.equal(A.concepts.list().length, 2);
  assert.ok(a03.house.id);

  for (const bad of [{ name: "x", amountCents: 3_000_000 }, { name: "Bien", amountCents: 500 }, { name: "Bien", amountCents: 1.5 }, { name: "vigilancia", amountCents: 3_000_000 }]) {
    assert.throws(() => A.concepts.create(bad), undefined, JSON.stringify(bad));
  }
});

test("cobro especial: a todas las casas o a una (multa), todo o nada, y nunca de otro conjunto ni de una casa dada de baja", () => {
  const { A, B, a14, a03, b01 } = twoConjuntos();
  A.dues.generate("2026-11");
  const all = A.concepts.charge({ name: "Arreglo del portón", amountCents: 4_500_000, period: "2026-11", houseIds: A.houses.list().map((h) => h.id) });
  assert.equal(all.created, 2);
  const fine = A.concepts.charge({ name: "Multa ruido casa 14", amountCents: 5_000_000, period: "2026-11", houseIds: [a14.house.id] });
  assert.equal(fine.created, 1);
  assert.equal(A.dues.listForHouse(a03.house.id).length, 2, "la 03 no recibió la multa");
  assert.equal(A.dues.listForHouse(a14.house.id).length, 3);
  assert.equal(A.dues.generate("2026-11"), 0, "generar de nuevo no repite los cobros especiales");
  assert.equal(A.dues.generate("2026-12"), 2, "y no vuelven el mes siguiente: solo la mensual");

  assert.throws(() => A.concepts.charge({ name: "Arreglo del portón", amountCents: 100_000, period: "2026-11", houseIds: [a14.house.id] }), /Ya existe/);
  assert.throws(() => B.concepts.charge({ name: "Cobro ajeno", amountCents: 4_500_000, period: "2026-11", houseIds: [a14.house.id] }), /no existe en este conjunto/);
  assert.equal(B.concepts.all().filter((c) => c.kind === "once").length, 0, "no quedó nada a medias en B");
  A.houses.setActive(a03.house.id, false);
  assert.throws(() => A.concepts.charge({ name: "Otro", amountCents: 4_500_000, period: "2026-11", houseIds: [a14.house.id, a03.house.id] }), /dada de baja/);
  assert.ok(!A.concepts.all().some((c) => c.name === "Otro"), "todo o nada");
  assert.throws(() => A.concepts.charge({ name: "Sin casas", amountCents: 4_500_000, period: "2026-11", houseIds: [] }), /al menos una casa/);
  assert.throws(() => A.concepts.charge({ name: "Mes malo", amountCents: 4_500_000, period: "2026-13", houseIds: [a14.house.id] }), /AAAA-MM/);
  assert.deepEqual(A.concepts.all().filter((c) => c.kind === "once").map((c) => [c.name, c.dues]), [["Arreglo del portón", 2], ["Multa ruido casa 14", 1]]);
  assert.throws(() => B.concepts.setAmount(all.conceptId, 100_000), /no existe en este conjunto/, "y tampoco se edita desde otro conjunto");
  assert.ok(b01.house.id);
});

test("un pago cubre una cuota exacta o, si suma justo, todas las del mes o todas las que debe: nunca adivina", () => {
  const { store, a, A, a14 } = twoConjuntos();
  const adm = A.concepts.create({ name: "Administración", amountCents: 12_000_000 });
  assert.ok(adm);
  A.dues.generate("2026-10"); A.dues.generate("2026-11");
  const pay = (id, cents) => ingestEvent(store, paymentEvent({ id, payerName: "Sandra Duque Arias", amountCents: cents }), a.id);
  const pending = () => A.dues.listForHouse(a14.house.id).filter((d) => d.status === "pending").map((d) => `${d.period} ${d.conceptName}`);

  // 4 dues: Oct and Nov, vigilancia $30.000 and administración $120.000 each.
  assert.equal(pending().length, 4);
  assert.equal(pay("p1", 3_000_000).status, "assigned");
  assert.deepEqual(pending().sort(), ["2026-10 Administración", "2026-11 Administración", "2026-11 Vigilancia"], "pagó la vigilancia exacta más antigua (octubre)");
  assert.equal(pay("p2", 5_000_000).status, "unassigned", "un valor que no suma nada exacto espera al tesorero");
  assert.equal(pay("p3", 15_000_000).status, "assigned", "$150.000 = vigilancia + administración de un mes");
  assert.deepEqual(pending(), ["2026-10 Administración"], "las dos de noviembre; queda la administración de octubre");
  assert.equal(pay("p4", 12_000_000).status, "assigned");
  assert.equal(pending().length, 0);
  const paid = A.dues.listForHouse(a14.house.id);
  assert.equal(new Set(paid.map((d) => d.paymentId)).size, 3, "cuatro cuotas, tres pagos: uno cubrió dos");
});

test("lo que dice 'Total a pagar' (todo lo que debe, varios meses) se concilia solo", () => {
  const { store, a, A, a14 } = twoConjuntos();
  A.dues.generate("2026-10"); A.dues.generate("2026-11");
  const r = ingestEvent(store, paymentEvent({ id: "tot", payerName: "Sandra Duque Arias", amountCents: 6_000_000 }), a.id);
  assert.equal(r.status, "assigned");
  assert.equal(A.dues.listForHouse(a14.house.id).filter((d) => d.status === "paid").length, 2, "las dos cuotas quedaron pagadas con un solo pago");
  const [one, two] = A.dues.listForHouse(a14.house.id);
  assert.equal(one.paymentId, two.paymentId);
  // Undoing it returns both to pending.
  A.payments.revert(one.paymentId);
  assert.equal(A.dues.listForHouse(a14.house.id).filter((d) => d.status === "pending").length, 2);
});
