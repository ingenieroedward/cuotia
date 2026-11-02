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

test("editar, desactivar, quitar nombres y deshacer: nada funciona sobre datos de otro conjunto", () => {
  const { A, B, a14, b01 } = twoConjuntos();
  A.dues.generate("2026-11");
  B.dues.generate("2026-11");
  const { payment } = B.payments.record({ externalId: "pay_b", payerName: "Carlos Mejía", payerNorm: "CARLOS MEJIA", amountCents: 3_000_000, paidAt: "2026-11-03T15:00:00.000Z" });
  B.payments.assign(payment.id, b01.house.id);
  B.aliases.add(b01.house.id, "Otro Nombre");
  const aliasId = B.aliases.list(b01.house.id)[0].id;

  assert.throws(() => A.houses.update(b01.house.id, { code: "99", residentName: "Hackeado" }), /no existe en este conjunto/);
  assert.throws(() => A.houses.setActive(b01.house.id, false), /no existe en este conjunto/);
  assert.throws(() => A.aliases.remove(b01.house.id, aliasId), /no existe en este conjunto/);
  assert.equal(A.aliases.remove(a14.house.id, aliasId), false, "ni usando una casa propia con el id de un nombre ajeno");
  assert.throws(() => A.payments.revert(payment.id), /no existe en este conjunto/);

  assert.equal(B.houses.get(b01.house.id).residentName, "Carlos Mejía");
  assert.equal(B.houses.get(b01.house.id).active, true);
  assert.equal(B.aliases.list(b01.house.id).length, 2, "el nombre del otro conjunto sigue ahí (el aprendido y el agregado)");
  assert.equal(B.payments.get(payment.id).status, "assigned");
  assert.equal(B.summary("2026-11").paidCount, 1);
});

test("una casa desactivada conserva su historial pero deja de contar y de conciliar", () => {
  const { store, A, a14, a03 } = twoConjuntos();
  A.dues.generate("2026-11");
  A.payments.recordCash(a03.house.id); // a03 pays; a14 stays pending
  assert.equal(A.summary("2026-11").expectedCents, 6_000_000);

  A.aliases.add(a14.house.id, "Familia Duque");
  A.houses.setActive(a14.house.id, false);
  A.houses.setActive(a03.house.id, false);
  assert.deepEqual(A.houses.list(), []);
  assert.deepEqual(A.houses.listInactive().map((h) => h.code), ["03", "14"]);

  const s = A.summary("2026-11");
  assert.equal(s.pendingCount, 0, "la deuda pendiente de una casa inactiva no cuenta");
  assert.equal(s.paidCount, 1, "lo que ya pagó sigue contando");
  assert.equal(s.collectedCents, 3_000_000);
  assert.deepEqual(A.dues.listByPeriod("2026-11").map((d) => d.houseCode), ["03"]);
  assert.equal(A.dues.generate("2026-12"), 0, "no se generan cuotas nuevas");
  assert.equal(store.residentByToken(store.forTenant(A.tenantId).houses.rotateToken(a14.house.id)), null, "su enlace no abre");
  assert.equal(A.aliases.houseFor("FAMILIA DUQUE"), null, "un nombre de casa inactiva no concilia");
  assert.equal(A.matchHouse("Sandra Duque Arias"), null);
  assert.equal(A.dues.listForHouse(a14.house.id).length, 1, "su historial se conserva");

  A.houses.setActive(a14.house.id, true);
  assert.equal(A.aliases.houseFor("FAMILIA DUQUE"), a14.house.id);
  assert.equal(A.summary("2026-11").pendingCount, 1);
});

test("deshacer: un pago de banco vuelve a 'por asignar' y olvida el nombre; el efectivo se anula", () => {
  const { A, a14, a03 } = twoConjuntos();
  A.dues.generate("2026-11");
  const { payment } = A.payments.record({ externalId: "pay_1", payerName: "Pedro Duque", payerNorm: "PEDRO DUQUE", amountCents: 3_000_000, bank: "nequi", paidAt: "2026-11-03T15:00:00.000Z" });
  A.payments.assign(payment.id, a14.house.id); // learns "PEDRO DUQUE"
  assert.equal(A.aliases.houseFor("PEDRO DUQUE"), a14.house.id);

  assert.deepEqual(A.payments.revert(payment.id), { deleted: false });
  assert.equal(A.payments.get(payment.id).status, "unassigned");
  assert.equal(A.payments.get(payment.id).houseId, null);
  assert.equal(A.dues.listForHouse(a14.house.id)[0].status, "pending");
  assert.equal(A.aliases.houseFor("PEDRO DUQUE"), null, "ya no recuerda ese nombre");
  assert.throws(() => A.payments.revert(payment.id), /no está asignado/);

  const cash = A.payments.recordCash(a03.house.id);
  assert.deepEqual(A.payments.revert(cash.paymentId), { deleted: true });
  assert.equal(A.payments.get(cash.paymentId), null);
  assert.equal(A.dues.listForHouse(a03.house.id)[0].status, "pending");
  assert.equal(A.summary("2026-11").collectedCents, 0);
  A.payments.recordCash(a03.house.id); // and it can be registered again
});

test("historial: filtros, búsqueda literal, paginación y aislamiento", () => {
  const { A, B, a14 } = twoConjuntos();
  const add = (L, id, name, paidAt, extra = {}) => L.payments.record({ externalId: id, payerName: name, payerNorm: name.toUpperCase(), amountCents: 3_000_000, paidAt, ...extra }).payment;
  const p1 = add(A, "a1", "Sandra Duque", "2026-11-03T15:00:00.000Z");
  add(A, "a2", "100% Real", "2026-10-30T15:00:00.000Z");
  add(A, "a3", "Pedro_X", "2026-12-01T03:00:00.000Z"); // 30 nov 22:00 in Colombia
  add(A, "a4", "Pedro Z", "2026-12-01T05:00:00.000Z"); // 1 dic 00:00 in Colombia
  add(B, "b1", "Sandra Duque", "2026-11-03T15:00:00.000Z");
  A.dues.generate("2026-11");
  A.payments.assign(p1.id, a14.house.id);

  const names = (o) => A.payments.list(o).rows.map((r) => r.payerName);
  assert.equal(A.payments.list().total, 4, "solo los del propio conjunto");
  assert.deepEqual(names({ period: "2026-11" }), ["Pedro_X", "Sandra Duque"], "el más reciente primero");
  assert.deepEqual(names({ period: "2026-12" }), ["Pedro Z"], "el mes cambia a medianoche de Colombia");
  assert.deepEqual(names({ status: "assigned" }), ["Sandra Duque"]);
  assert.deepEqual(names({ houseId: a14.house.id }), ["Sandra Duque"]);
  assert.deepEqual(names({ q: "100%" }), ["100% Real"], "el % se busca como texto, no como comodín");
  assert.deepEqual(names({ q: "%" }), [], "buscar solo símbolos no devuelve todo");
  assert.deepEqual(names({ q: "14" }), ["Sandra Duque"], "por código de casa");
  assert.equal(A.payments.list({ period: "2026-11" }).totalCents, 6_000_000);

  const page = A.payments.list({ limit: 3, offset: 0 });
  assert.equal(page.rows.length, 3);
  assert.equal(page.total, 4);
  assert.equal(A.payments.list({ limit: 3, offset: 3 }).rows.length, 1);
  assert.equal(A.payments.list({ houseId: a14.house.id }).rows[0].duePeriod, "2026-11");
});
