import test from "node:test";
import assert from "node:assert/strict";
import { twoConjuntos } from "./fixtures.js";

test("un conjunto no ve las casas, cuotas ni pagos del otro", () => {
  const { A, B } = twoConjuntos();
  assert.deepEqual(A.houses.list().map((h) => h.code), ["03", "14"]);
  assert.deepEqual(B.houses.list().map((h) => h.code), ["01"]);

  A.dues.generate("2026-11");
  B.dues.generate("2026-11");
  assert.equal(A.dues.listByPeriod("2026-11").length, 2);
  assert.equal(B.dues.listByPeriod("2026-11").length, 1);
  assert.ok(A.dues.listByPeriod("2026-11").every((d) => d.residentName !== "Carlos Mejía"));
});

test("no se puede leer ni asignar una casa de otro conjunto", () => {
  const { A, B, b01, a14 } = twoConjuntos();
  assert.equal(A.houses.get(b01.house.id), null);
  assert.equal(B.houses.get(a14.house.id), null);
  assert.throws(() => A.aliases.add(b01.house.id, "Cualquiera"), /no existe en este conjunto/);

  const { payment } = A.payments.record({ externalId: "pay_x", payerName: "X", payerNorm: "X", amountCents: 3_000_000, paidAt: "2026-11-03T00:00:00.000Z" });
  assert.throws(() => A.payments.assign(payment.id, b01.house.id), /no existe en este conjunto/);
  assert.equal(B.payments.get(payment.id), null, "el otro conjunto no ve el pago");
  assert.throws(() => B.payments.assign(payment.id, b01.house.id), /no existe en este conjunto/);
  assert.equal(A.payments.get(payment.id).status, "unassigned", "la asignación fallida no cambió nada");
});

test("el mismo nombre en dos conjuntos no se mezcla", () => {
  const { A, B, a14, b01 } = twoConjuntos();
  A.aliases.add(a14.house.id, "Juan Pérez");
  B.aliases.add(b01.house.id, "Juan Pérez");
  assert.equal(A.aliases.houseFor("JUAN PEREZ"), a14.house.id);
  assert.equal(B.aliases.houseFor("JUAN PEREZ"), b01.house.id);
});

test("un alias compartido por dos casas no adivina", () => {
  const { A, a14, a03 } = twoConjuntos();
  A.aliases.add(a14.house.id, "Familia Rojas");
  A.aliases.add(a03.house.id, "Familia Rojas");
  assert.equal(A.aliases.houseFor("FAMILIA ROJAS"), null);
});

test("el enlace personal abre solo la casa de su dueño", () => {
  const { store, a14, b01, a } = twoConjuntos();
  const found = store.residentByToken(a14.accessToken);
  assert.equal(found.house.id, a14.house.id);
  assert.equal(found.tenant.id, a.id);
  assert.equal(store.residentByToken(b01.accessToken).house.id, b01.house.id);
  assert.equal(store.residentByToken("no-existe"), null);
});

test("generar cuotas dos veces no duplica", () => {
  const { A } = twoConjuntos();
  assert.equal(A.dues.generate("2026-11"), 2);
  assert.equal(A.dues.generate("2026-11"), 0);
  assert.throws(() => A.dues.generate("2026-13"), /AAAA-MM/);
});

test("forTenant rechaza un conjunto que no existe", () => {
  const { store } = twoConjuntos();
  assert.throws(() => store.forTenant("ten_inexistente"), /desconocido/);
});

test("pago en efectivo: solo en casas del propio conjunto y solo si hay cuota abierta", () => {
  const { A, B, a14, b01 } = twoConjuntos();
  A.dues.generate("2026-11");
  B.dues.generate("2026-11");
  assert.throws(() => A.payments.recordCash(b01.house.id), /no existe en este conjunto/);
  assert.equal(B.summary("2026-11").collectedCents, 0, "el otro conjunto no se tocó");

  const r = A.payments.recordCash(a14.house.id);
  assert.equal(r.amountCents, 3_000_000);
  assert.equal(A.summary("2026-11").collectedCents, 3_000_000);
  assert.throws(() => A.payments.recordCash(a14.house.id), /no tiene cuotas pendientes/);
  assert.equal(A.payments.listUnassigned().length, 0, "el efectivo nace asignado");
});

test("renovar el enlace de una casa ajena falla y no cambia su enlace", () => {
  const { store, A, a14, b01 } = twoConjuntos();
  assert.throws(() => A.houses.rotateToken(b01.house.id), /no existe en este conjunto/);
  assert.equal(store.residentByToken(b01.accessToken).house.id, b01.house.id);
  const fresh = A.houses.rotateToken(a14.house.id);
  assert.equal(store.residentByToken(a14.accessToken), null);
  assert.equal(store.residentByToken(fresh).house.id, a14.house.id);
});

test("sesiones: 'pending' no es 'full' y promover cambia el token", () => {
  const { store, a } = twoConjuntos();
  const uid = store.users.create({ tenantId: a.id, email: "t@ejemplo.com", passwordHash: "x" });
  const t1 = store.sessions.create(uid, { stage: "pending" });
  assert.equal(store.sessions.resolve(t1).stage, "pending");
  const t2 = store.sessions.promote(t1);
  assert.notEqual(t1, t2);
  assert.equal(store.sessions.resolve(t1), null);
  assert.equal(store.sessions.resolve(t2).stage, "full");
  assert.equal(store.sessions.resolve(store.sessions.create(uid, { ttlMs: -1000 })), null, "vencida");
});
