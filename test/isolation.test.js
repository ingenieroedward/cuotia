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

test("pago manual: varias cuotas con un solo pago, todo o nada, sin tocar otras casas ni otros conjuntos", () => {
  const { store, A, B, a14, a03, b01 } = twoConjuntos();
  A.dues.generate("2026-09");
  A.dues.generate("2026-10");
  B.dues.generate("2026-10");
  const mine = A.dues.listForHouse(a14.house.id);
  const other = A.dues.listForHouse(a03.house.id)[0];
  const theirs = B.dues.listForHouse(b01.house.id)[0];

  // Nothing is half done when one of the dues is not valid.
  for (const dueIds of [[mine[0].id, other.id], [mine[0].id, theirs.id], [mine[0].id, "du_inventada"], []]) {
    assert.throws(() => A.payments.recordManual({ houseId: a14.house.id, dueIds }), /cuota|Elige/);
  }
  assert.throws(() => A.payments.recordManual({ houseId: a14.house.id, dueIds: [mine[0].id], method: "bitcoin" }), /Medio/);
  assert.throws(() => A.payments.recordManual({ houseId: b01.house.id, dueIds: [theirs.id] }), /no existe en este conjunto/);
  assert.equal(A.payments.list().total, 0);
  assert.ok(A.dues.listForHouse(a14.house.id).every((d) => d.status === "pending"));
  assert.equal(B.dues.listForHouse(b01.house.id)[0].status, "pending");

  const r = A.payments.recordManual({ houseId: a14.house.id, dueIds: [mine[0].id, mine[1].id, mine[0].id], method: "transfer", bank: "Bancolombia", note: " pagó doble ", paidAt: "2026-10-03T17:00:00.000Z" });
  assert.equal(r.amountCents, 6_000_000, "la suma, y una cuota repetida no cuenta dos veces");
  const p = A.payments.get(r.paymentId);
  assert.deepEqual([p.payerName, p.bank, p.note, p.manual, p.method], ["Transferencia · Sandra Duque Arias", "Bancolombia", "pagó doble", true, "transfer"]);
  assert.equal(A.summary("2026-10").collectedCents + A.summary("2026-09").collectedCents, 6_000_000);
  assert.throws(() => A.payments.recordManual({ houseId: a14.house.id, dueIds: [mine[0].id] }), /no está pendiente/, "no se cobra dos veces la misma cuota");
  assert.equal(B.payments.list().total, 0);
  assert.equal(store.forTenant(B.tenantId).payments.get(r.paymentId), null, "el otro conjunto no ve el pago");

  // Undo: the whole payment disappears and both months are pending again; a pagoradar payment is never "manual".
  assert.deepEqual(A.payments.revert(r.paymentId), { deleted: true });
  assert.ok(A.dues.listForHouse(a14.house.id).every((d) => d.status === "pending"));
  const bank = A.payments.record({ externalId: "pay_x", payerName: "X", payerNorm: "X", amountCents: 3_000_000, bank: "nequi", method: "transfer", paidAt: "2026-10-04T00:00:00.000Z" }).payment;
  assert.equal(bank.manual, false, "un pago de pagoradar con método 'transfer' no se confunde con uno manual");
  const cash = A.payments.recordCash(a14.house.id);
  assert.equal(A.dues.listForHouse(a14.house.id).find((d) => d.paymentId === cash.paymentId).period, "2026-09", "el efectivo rápido salda la cuota más antigua");
  assert.equal(cash.amountCents, 3_000_000);
});

test("cuotas pendientes: solo de casas activas y del propio conjunto", () => {
  const { A, B, a14, a03 } = twoConjuntos();
  A.dues.generate("2026-11");
  B.dues.generate("2026-11");
  assert.deepEqual(A.dues.listPending().map((d) => d.houseCode), ["03", "14"]);
  A.houses.setActive(a03.house.id, false);
  assert.deepEqual(A.dues.listPending().map((d) => d.houseCode), ["14"]);
  A.payments.recordCash(a14.house.id);
  assert.deepEqual(A.dues.listPending(), []);
  assert.equal(B.dues.listPending().length, 1);
});

test("agregar un mes a una sola casa: solo a esa casa, sin duplicar, y no en casas ajenas ni desactivadas", () => {
  const { A, B, a14, a03, b01 } = twoConjuntos();
  assert.equal(A.dues.generateForHouse(a14.house.id, "2026-10"), 1, "una cuota por concepto");
  assert.equal(A.dues.generateForHouse(a14.house.id, "2026-10"), 0, "repetirlo no duplica");
  assert.deepEqual(A.dues.listForHouse(a14.house.id).map((d) => d.period), ["2026-10"]);
  assert.deepEqual(A.dues.listForHouse(a03.house.id), [], "las demás casas no reciben nada");
  assert.equal(B.dues.listByPeriod("2026-10").length, 0, "ni el otro conjunto");

  assert.throws(() => A.dues.generateForHouse(b01.house.id, "2026-10"), /no existe en este conjunto/);
  assert.throws(() => A.dues.generateForHouse(a14.house.id, "octubre"), /AAAA-MM/);
  A.houses.setActive(a03.house.id, false);
  assert.throws(() => A.dues.generateForHouse(a03.house.id, "2026-10"), /desactivada/);
  assert.equal(B.dues.listForHouse(b01.house.id).length, 0, "nada quedó a medias en el otro conjunto");
});

test("comprobantes: un conjunto no los ve, no los baja, no los rechaza y no los usa en un pago", () => {
  const { A, B, a14, b01 } = twoConjuntos();
  const data = Buffer.from("datos");
  const { id } = A.proofs.create({ houseId: a14.house.id, mime: "image/png", data });
  assert.throws(() => B.proofs.create({ houseId: a14.house.id, mime: "image/png", data }), /casa/i);
  assert.equal(B.proofs.meta(id), null);
  assert.equal(B.proofs.file(id), null);
  assert.deepEqual(B.proofs.listPending(), []);
  assert.equal(B.proofs.countPending(), 0);
  assert.throws(() => B.proofs.listForHouse(a14.house.id));
  assert.throws(() => B.proofs.reject(id), /pendiente/);
  B.dues.generate("2026-11");
  assert.throws(() => B.payments.recordManual({ houseId: b01.house.id, dueIds: [B.dues.listForHouse(b01.house.id)[0].id], proofId: id }), /comprobante/);
  assert.equal(A.proofs.meta(id).status, "pending", "nada cambió");
  assert.ok(A.proofs.file(id).data.equals(data));
});

test("equipo: un conjunto no ve, no quita ni cancela invitaciones de otro, y la última persona no se puede quitar", () => {
  const { store, A, B, a, b } = twoConjuntos();
  const ua = store.users.create({ tenantId: a.id, email: "marta@ejemplo.com", passwordHash: "x" });
  const ub = store.users.create({ tenantId: b.id, email: "luis@ejemplo.com", passwordHash: "x" });
  assert.deepEqual(A.team.list().map((u) => u.email), ["marta@ejemplo.com"]);
  assert.deepEqual(B.team.list().map((u) => u.email), ["luis@ejemplo.com"]);
  assert.throws(() => B.team.remove(ua), /no es de este conjunto/);
  assert.throws(() => A.team.remove(ua), /al menos una persona/, "ni la única de su propio conjunto");

  const { token } = A.team.invite({ email: "Pedro@Ejemplo.com", name: "Pedro" });
  const [inv] = A.team.invitations();
  assert.equal(B.team.invitations().length, 0);
  assert.throws(() => B.team.cancelInvitation(inv.id), /no existe en este conjunto/);
  assert.throws(() => A.team.invite({ email: "marta@ejemplo.com" }), /ya tiene una cuenta/, "ni un correo de otro conjunto");
  assert.throws(() => A.team.invite({ email: "luis@ejemplo.com" }), /ya tiene una cuenta/);
  assert.throws(() => A.team.invite({ email: "no-es-correo" }), /correo válido/);

  const { userId, tenantId } = store.invitations.accept(token, { passwordHash: "h", name: "Pedro Gómez" });
  assert.equal(tenantId, a.id, "entra al conjunto que lo invitó, no a otro");
  assert.equal(store.users.byId(userId).tenantId, a.id);
  assert.throws(() => store.invitations.accept(token, { passwordHash: "h" }), /no existe o ya venció/, "el enlace sirve una vez");
  assert.equal(store.invitations.byToken(token), null);
  assert.equal(B.team.list().length, 1);

  // Inviting again replaces the previous link.
  const first = A.team.invite({ email: "ana@ejemplo.com" }).token;
  const second = A.team.invite({ email: "ana@ejemplo.com" }).token;
  assert.equal(store.invitations.byToken(first), null);
  assert.ok(store.invitations.byToken(second));
  assert.equal(A.team.invitations().length, 1);

  // Expired links stop working.
  store.db.prepare("UPDATE invitations SET expires_at = ?").run(new Date(Date.now() - 1000).toISOString());
  assert.equal(store.invitations.byToken(second), null);

  A.team.remove(userId);
  assert.equal(store.users.byId(userId), null);
  assert.ok(B.team.list().some((u) => u.id === ub));
});

test("cuentas claras: los gastos, su soporte y el saldo de un conjunto no los ve ni los toca otro", () => {
  const { A, B, a } = twoConjuntos();
  const data = Buffer.from("soporte");
  const { id } = A.expenses.create({ spentOn: "2026-11-03", amountCents: 120_000_000, category: "Vigilancia", description: "Vigilante de noviembre", proof: { mime: "image/png", data } });
  assert.equal(B.expenses.get(id), null);
  assert.equal(B.expenses.file(id), null);
  assert.deepEqual(B.expenses.list({ period: "2026-11" }), []);
  assert.throws(() => B.expenses.void(id), /no existe en este conjunto/);
  assert.equal(B.books("2026-11").spentCents, 0);
  assert.equal(A.books("2026-11").spentCents, 120_000_000);
  assert.ok(A.expenses.file(id).data.equals(data));
  assert.equal(A.expenses.get(id).voided, false, "el intento de otro conjunto no anuló nada");
  assert.ok(a.id);
});

test("cuentas claras: el saldo suma lo recaudado y resta los gastos, y un gasto anulado ya no cuenta", () => {
  const { store, A, a, a14 } = twoConjuntos();
  store.tenants.setAccounts(a.id, { openingCents: 50_000_000, showAccounts: false });
  A.dues.generate("2026-11");
  const due = A.dues.listForHouse(a14.house.id)[0];
  A.payments.recordManual({ houseId: a14.house.id, dueIds: [due.id], method: "cash", paidAt: "2026-11-04T17:00:00.000Z" });
  const g = A.expenses.create({ spentOn: "2026-11-05", amountCents: 1_000_000, category: "Servicios públicos", description: "Luz de la portería" });
  A.expenses.create({ spentOn: "2026-10-20", amountCents: 700_000, category: "Mantenimiento", description: "Arreglo del portón" });
  let b = A.books("2026-11");
  assert.deepEqual([b.incomeCents, b.spentCents, b.monthBalanceCents], [3_000_000, 1_000_000, 2_000_000]);
  assert.equal(b.cashCents, 50_000_000 + 3_000_000 - 1_000_000 - 700_000, "saldo inicial + todo lo recaudado - todos los gastos hasta fin de mes");
  assert.deepEqual(b.byCategory, [{ category: "Servicios públicos", cents: 1_000_000 }]);
  assert.equal(A.books("2026-10").cashCents, 50_000_000 - 700_000, "octubre no ve lo de noviembre");
  A.expenses.void(g.id);
  b = A.books("2026-11");
  assert.deepEqual([b.spentCents, b.cashCents], [0, 50_000_000 + 3_000_000 - 700_000]);
  assert.equal(A.expenses.list({ period: "2026-11" })[0].voided, true, "sigue visible, marcado");
  assert.throws(() => A.expenses.void(g.id), /ya está anulado/);
  for (const bad of [
    { spentOn: "2026-13-01" }, { spentOn: "2023-01-01" }, { amountCents: 0 }, { amountCents: 1.5 }, { category: "Cripto" }, { description: "   " },
    { proof: { mime: "image/png", data: Buffer.alloc(6 * 1024 * 1024) } },
  ]) {
    assert.throws(() => A.expenses.create({ spentOn: "2026-11-05", amountCents: 100, category: "Otros", description: "x", ...bad }), undefined, JSON.stringify(bad).slice(0, 40));
  }
});

test("paz y salvo: el código se emite una vez por casa y día, otro conjunto no emite para casas ajenas y la verificación no muestra nombres", () => {
  const { store, A, B, a14 } = twoConjuntos();
  const code = A.certificates.issue({ houseId: a14.house.id, kind: "paz_y_salvo", issuedOn: "2026-11-03" });
  assert.match(code, /^[2-9A-HJKMNP-Z]{5}-[2-9A-HJKMNP-Z]{5}$/);
  assert.equal(A.certificates.issue({ houseId: a14.house.id, kind: "paz_y_salvo", issuedOn: "2026-11-03" }), code, "el mismo día, el mismo código");
  assert.notEqual(A.certificates.issue({ houseId: a14.house.id, kind: "paz_y_salvo", issuedOn: "2026-11-04" }), code);
  assert.throws(() => B.certificates.issue({ houseId: a14.house.id, kind: "paz_y_salvo", issuedOn: "2026-11-03" }), /no existe en este conjunto/);
  const found = store.certificates.byCode(code.toLowerCase());
  assert.deepEqual(found, { kind: "paz_y_salvo", issuedOn: "2026-11-03", houseCode: "14", tenantName: "Jardines de Ibiza" });
  assert.ok(!JSON.stringify(found).includes("Sandra"), "no revela el nombre del residente");
  assert.equal(store.certificates.byCode("AAAAA-AAAAA"), null);
  assert.equal(store.certificates.byCode(""), null);
});

test("bitácora: cada conjunto ve solo la suya, el filtro escapa comodines y no hay forma de editar un registro", () => {
  const { A, B } = twoConjuntos();
  A.audit.record({ userName: "Marta", action: "pagos", summary: "Registró un pago de $30.000 de la casa 14 (efectivo)" });
  A.audit.record({ userName: "Marta", action: "casas", summary: "Dio de baja la casa 03" });
  B.audit.record({ userName: "Luis", action: "pagos", summary: "Registró un pago de $30.000 de la casa 01 (efectivo)" });
  assert.equal(A.audit.list().total, 2);
  assert.equal(B.audit.list().total, 1);
  assert.deepEqual(B.audit.list().rows.map((r) => r.userName), ["Luis"]);
  assert.deepEqual(A.audit.list({ action: "casas" }).rows.map((r) => r.summary), ["Dio de baja la casa 03"]);
  assert.equal(A.audit.list({ q: "marta" }).total, 2);
  assert.equal(A.audit.list({ q: "%" }).total, 0, "el % no es un comodín");
  assert.equal(A.audit.list({ q: "_" }).total, 0, "ni el _");
  assert.equal(A.audit.list({ limit: 1, offset: 1 }).rows[0].summary.includes("pago"), true, "del más nuevo al más viejo");
  assert.equal(typeof A.audit.update, "undefined");
  assert.equal(typeof A.audit.delete, "undefined");
});

test("borrar datos personales: solo en una casa dada de baja, conserva el historial sin nombre y no toca a otro conjunto", () => {
  const { store, A, B, a14, b01 } = twoConjuntos();
  A.dues.generate("2026-11"); B.dues.generate("2026-11");
  A.houses.update(a14.house.id, { code: "14", residentName: "Sandra Duque Arias", phone: "3001234567" });
  A.aliases.add(a14.house.id, "SANDRA D");
  A.proofs.create({ houseId: a14.house.id, mime: "image/png", data: Buffer.from("x") });
  A.housePush.add({ houseId: a14.house.id, endpoint: "https://fcm.googleapis.com/fcm/send/x", p256dh: "p", auth: "a" });
  const { payment } = A.payments.record({ externalId: "t:1", payerName: "SANDRA DUQUE", payerNorm: "SANDRA DUQUE", amountCents: 3_000_000, paidAt: "2026-11-03T15:00:00.000Z" });
  A.payments.assign(payment.id, a14.house.id, { rememberAlias: false });

  assert.throws(() => A.houses.anonymize(a14.house.id), /da de baja/, "una casa activa no se borra");
  assert.throws(() => B.houses.anonymize(a14.house.id), /no existe en este conjunto/);
  A.houses.setActive(a14.house.id, false);
  A.houses.anonymize(a14.house.id);

  const h = A.houses.get(a14.house.id);
  assert.deepEqual([h.residentName, h.phone, h.code, h.active], ["Residente anterior", null, "14", false]);
  assert.deepEqual(A.aliases.list(a14.house.id), []);
  assert.equal(A.proofs.listForHouse(a14.house.id).length, 0);
  assert.equal(A.housePush.count(a14.house.id), 0);
  const kept = A.payments.get(payment.id);
  assert.equal(kept.payerName, "Pagador anónimo");
  assert.equal(kept.amountCents, 3_000_000, "el valor del pago se conserva");
  assert.equal(A.dues.listForHouse(a14.house.id).filter((d) => d.status === "paid").length, 1, "y la cuota sigue pagada");
  assert.equal(B.houses.get(b01.house.id).residentName, "Carlos Mejía", "el otro conjunto no cambió");
  assert.ok(store);
});

test("empezar de cero: borra solo los datos de operación de ese conjunto, todo o nada, y conserva ajustes, cobros mensuales, equipo y bitácora", () => {
  const { store, a, A, B, a14, a03, b01 } = twoConjuntos();
  const uid = store.users.create({ tenantId: a.id, email: "marta@ejemplo.com", passwordHash: "x" });
  for (const L of [A, B]) L.dues.generate("2026-11");
  A.concepts.charge({ name: "Multa", amountCents: 5_000_000, period: "2026-11", houseIds: [a14.house.id] });
  A.expenses.create({ spentOn: "2026-11-03", amountCents: 100_000, category: "Otros", description: "x" });
  A.proofs.create({ houseId: a14.house.id, mime: "image/png", data: Buffer.from("x") });
  A.aliases.add(a14.house.id, "SANDRA D");
  A.housePush.add({ houseId: a14.house.id, endpoint: "https://fcm.googleapis.com/fcm/send/h", p256dh: "p", auth: "a" });
  A.push.add({ userId: uid, endpoint: "https://fcm.googleapis.com/fcm/send/u", p256dh: "p", auth: "a" });
  A.reminders.claim(a14.house.id, "2026-11", "vence");
  A.certificates.issue({ houseId: a14.house.id, kind: "paz_y_salvo", issuedOn: "2026-11-03" });
  A.audit.record({ userName: "Marta", action: "pagos", summary: "algo" });
  store.tenants.setDates(a.id, { openDay: 1, dueDay: 10 });

  const gone = A.reset({ keepHouses: true });
  assert.deepEqual([gone.dues, gone.expenses, gone.proofs, gone.specialCharges, gone.houses], [3, 1, 1, 1, 2]);
  const left = A.resetPreview();
  assert.deepEqual([left.dues, left.payments, left.proofs, left.expenses, left.specialCharges, left.houses], [0, 0, 0, 0, 0, 2]);
  assert.equal(A.aliases.list(a14.house.id).length, 1);
  assert.equal(A.housePush.count(a14.house.id), 1, "con las casas se quedan sus avisos");
  assert.equal(A.push.countForUser(uid), 1, "y los avisos del equipo");
  assert.equal(A.concepts.list().length, 1, "el cobro mensual sigue");
  assert.equal(A.team.list().length, 1);
  assert.equal(A.audit.list().total, 1, "la bitácora no se toca");
  assert.equal(store.tenants.get(a.id).dueDay, 10);
  assert.equal(B.resetPreview().dues, 1, "el otro conjunto no cambió");
  assert.equal(B.houses.list().length, 1);
  assert.equal(A.reminders.claim(a14.house.id, "2026-11", "vence"), true, "los recordatorios se pueden volver a enviar");
  assert.equal(A.certificates.issue({ houseId: a14.house.id, kind: "paz_y_salvo", issuedOn: "2026-11-03" }).length, 11, "un código nuevo");

  A.reset({ keepHouses: false });
  assert.equal(A.resetPreview().houses, 0);
  assert.equal(A.aliases.list(a14.house.id).length, 0);
  assert.equal(A.housePush.count(a14.house.id), 0);
  assert.equal(A.push.countForUser(uid), 1);
  assert.equal(B.houses.list().length, 1);
  assert.ok(a03.house.id && b01.house.id);
});

test("medios de pago: se validan por tipo, no se repiten, tienen tope y cada conjunto ve y quita solo los suyos", () => {
  const { A, B } = twoConjuntos();
  const nequi = A.payMethods.add({ kind: "nequi", account: "300 123 4567", holder: "Marta Rojas", note: "Escribe tu casa" });
  A.payMethods.add({ kind: "daviplata", account: "3109876543" });
  A.payMethods.add({ kind: "bancolombia", account: "123-456789-01", accountType: "ahorros", holder: "Marta Rojas" });
  A.payMethods.add({ kind: "otro", label: "Ahorro a la mano", account: "3001112233" });
  assert.deepEqual(A.payMethods.list().map((m) => [m.kind, m.account, m.accountType, m.label]), [
    ["nequi", "3001234567", null, null], ["daviplata", "3109876543", null, null], ["bancolombia", "12345678901", "ahorros", null], ["otro", "3001112233", null, "Ahorro a la mano"],
  ]);
  for (const bad of [
    { kind: "nequi", account: "12345" }, { kind: "nequi", account: "2001234567" }, { kind: "daviplata", account: "abc" },
    { kind: "bancolombia", account: "123456" }, { kind: "bancolombia", account: "12", accountType: "ahorros" }, { kind: "bancolombia", account: "123456", accountType: "vista" },
    { kind: "otro", account: "123" }, { kind: "otro", label: "X", account: "123456" }, { kind: "paypal", account: "3001234567" },
  ]) assert.throws(() => A.payMethods.add(bad), undefined, JSON.stringify(bad));
  assert.throws(() => A.payMethods.add({ kind: "nequi", account: "3001234567" }), /Ya agregaste/);
  A.payMethods.add({ kind: "nequi", account: "3201234567" });
  A.payMethods.add({ kind: "daviplata", account: "3101234567" });
  assert.throws(() => A.payMethods.add({ kind: "nequi", account: "3301234567" }), /Máximo 6/);

  assert.deepEqual(B.payMethods.list(), [], "el otro conjunto no los ve");
  assert.throws(() => B.payMethods.remove(nequi), /no existe en este conjunto/);
  assert.equal(A.payMethods.list().length, 6);
  A.payMethods.remove(nequi);
  assert.equal(A.payMethods.list().length, 5);
  assert.throws(() => A.payMethods.remove(nequi), /no existe/);
});

test("mensajes de WhatsApp: cada conjunto edita los suyos, se validan y volver al original borra la edición", () => {
  const { A, B } = twoConjuntos();
  assert.deepEqual(A.templates.all(), {});
  A.templates.set("recordatorio_casa", "Hola {nombre}, la casa {casa} debe {valor}. Gracias, {tesorero}.");
  assert.equal(A.templates.all().recordatorio_casa, "Hola {nombre}, la casa {casa} debe {valor}. Gracias, {tesorero}.");
  assert.deepEqual(B.templates.all(), {}, "el otro conjunto conserva el original");
  A.templates.set("recordatorio_casa", "Hola {nombre}, ahora dice otra cosa con {valor}.");
  assert.equal(Object.keys(A.templates.all()).length, 1, "editar dos veces no duplica");
  for (const [key, text] of [["recordatorio_casa", "corto"], ["recordatorio_casa", "Hola {nombre} y {inventada} más texto"], ["enlace_casa", "Hola {nombre}, aquí va tu enlace sin la variable"], ["no_existe", "Hola {nombre} texto largo suficiente"], ["recordatorio_casa", "x".repeat(1300)]]) {
    assert.throws(() => A.templates.set(key, text), undefined, `${key}: ${text.slice(0, 20)}`);
  }
  A.templates.reset("recordatorio_casa");
  assert.deepEqual(A.templates.all(), {});
  B.templates.reset("recordatorio_casa");
});

test("passkeys: cada conjunto solo lista, agrega y quita los de su gente", async () => {
  const { A, B, store, a: ta, b: tb } = twoConjuntos();
  const a = { id: store.users.create({ tenantId: ta.id, email: "marta@ejemplo.com", passwordHash: "x" }) };
  const b = { id: store.users.create({ tenantId: tb.id, email: "luis@ejemplo.com", passwordHash: "x" }) };
  const key = (n) => ({ credentialId: `cred-${n}`, publicKey: "pk", alg: -7, name: `Equipo ${n}` });
  A.passkeys.add({ userId: a.id, ...key(1) });
  assert.deepEqual(B.passkeys.list(a.id), [], "otro conjunto no ve passkeys ajenos");
  assert.throws(() => B.passkeys.add({ userId: a.id, ...key(2) }), /no es de este conjunto/);
  const mine = A.passkeys.list(a.id)[0];
  assert.throws(() => B.passkeys.remove(mine.id, a.id), /no existe|no es de este conjunto/);
  assert.equal(A.passkeys.list(a.id).length, 1);
  assert.throws(() => A.passkeys.remove(mine.id, b.id), /no existe|no es de este conjunto/, "ni siquiera un usuario de otro conjunto con el id correcto");
  A.passkeys.remove(mine.id, a.id);
  assert.deepEqual(A.passkeys.list(a.id), []);
});

test("transparencia: el enlace público de un conjunto no abre otro y apagarlo no toca al vecino", () => {
  const { store, a, b } = twoConjuntos();
  store.tenants.setPublicToken(a.id, "token-de-ibiza-0000000000", "cifrado-a");
  store.tenants.setPublicToken(b.id, "token-de-robles-000000000", "cifrado-b");
  assert.equal(store.tenants.byPublicToken("token-de-ibiza-0000000000").id, a.id);
  assert.equal(store.tenants.byPublicToken("token-de-robles-000000000").id, b.id);
  assert.equal(store.tenants.publicTokenEnc(a.id), "cifrado-a");
  store.tenants.clearPublicToken(a.id);
  assert.equal(store.tenants.byPublicToken("token-de-ibiza-0000000000"), null);
  assert.equal(store.tenants.publicTokenEnc(a.id), null);
  assert.equal(store.tenants.byPublicToken("token-de-robles-000000000").id, b.id, "el otro sigue publicado");
  assert.equal(store.tenants.get(b.id).publicOn, true);
  assert.equal(store.tenants.get(a.id).publicOn, false);
  assert.equal(store.tenants.byPublicToken(""), null);
});

test("recuperación: los códigos de respaldo y los enlaces de restablecimiento no cruzan de conjunto", () => {
  const { store, A, B, a, b } = twoConjuntos();
  const ua = store.users.create({ tenantId: a.id, email: "marta@ejemplo.com", passwordHash: "x" });
  const ub = store.users.create({ tenantId: b.id, email: "luis@ejemplo.com", passwordHash: "x" });
  assert.throws(() => B.recovery.status(ua), /no es de este conjunto/);
  assert.throws(() => B.recovery.replace(ua, ["h1"]), /no es de este conjunto/);
  A.recovery.replace(ua, ["h1", "h2"]);
  B.recovery.replace(ub, ["h3"]);
  assert.deepEqual(A.recovery.status(ua), { total: 2, remaining: 2, createdAt: A.recovery.status(ua).createdAt });
  // Codes only work for the account they belong to.
  assert.equal(store.recoveryCodes.consume(ub, "h1"), false);
  assert.equal(store.recoveryCodes.consume(ua, "h1"), true);
  assert.equal(store.recoveryCodes.consume(ua, "h1"), false, "una sola vez");
  assert.equal(A.recovery.status(ua).remaining, 1);
  assert.equal(B.recovery.status(ub).remaining, 1, "el otro conjunto no se tocó");
  // Reset links: a conjunto can only make one for its own people.
  assert.throws(() => B.team.resetAccess(ua), /no es de este conjunto/);
  assert.throws(() => A.team.resetAccess("usr_inexistente"), /no es de este conjunto/);
  const { token } = A.team.resetAccess(ua);
  assert.equal(store.accessResets.byToken(token).userId, ua);
  assert.equal(store.accessResets.byToken(token).tenantId, a.id);
  assert.equal(store.accessResets.byToken("otro-token"), null);
  store.accessResets.use(token, { passwordHash: "nuevo" });
  assert.equal(store.accessResets.byToken(token), null);
  assert.equal(A.recovery.status(ua).total, 0, "al restablecer se borran sus códigos");
  assert.equal(B.recovery.status(ub).total, 1, "los del otro conjunto siguen");
  assert.throws(() => store.accessResets.use(token, { passwordHash: "otro" }), /ya no sirve/);
});

test("enlaces personales guardados: cada conjunto solo ve y guarda los de sus casas", () => {
  const { A, B, a14, b01 } = twoConjuntos();
  assert.throws(() => B.houses.setSealedLink(a14.house.id, "cifrado"), /no es de este conjunto|no existe/i);
  A.houses.setSealedLink(a14.house.id, "cifrado-a");
  B.houses.setSealedLink(b01.house.id, "cifrado-b");
  assert.deepEqual([...A.houses.sealedLinks()], [[a14.house.id, "cifrado-a"]]);
  assert.deepEqual([...B.houses.sealedLinks()], [[b01.house.id, "cifrado-b"]]);
  assert.equal(A.houses.get(a14.house.id).hasLink, true);
  assert.equal(B.houses.get(b01.house.id).hasLink, true);
  A.houses.setActive(a14.house.id, false);
  assert.equal(A.houses.sealedLinks().size, 0, "una casa dada de baja no entrega su enlace");
});

test("registro de vecinos: solicitudes y enlace son de cada conjunto, con tope y sin duplicados", () => {
  const { store, A, B, a, b, a14 } = twoConjuntos();
  const idA = A.signups.create({ code: "9", name: "Vecino de Ibiza", phone: "3001234567" });
  B.signups.create({ code: "9", name: "Vecino de Robles", phone: "3109876543" });
  assert.deepEqual(A.signups.pending().map((r) => r.name), ["Vecino de Ibiza"]);
  assert.equal(B.signups.get(idA), null, "el otro conjunto no la ve");
  assert.equal(B.signups.resolve(idA, "approved"), false, "ni la resuelve");
  assert.equal(A.signups.pendingCount(), 1);
  assert.equal(A.signups.resolve(idA, "approved", a14.house.id), true);
  assert.equal(A.signups.resolve(idA, "approved"), false, "una sola vez");
  assert.equal(A.signups.pendingCount(), 0);
  assert.equal(A.signups.recent().length, 1);
  // The same neighbour twice keeps one pending request; limits and validation.
  A.signups.create({ code: "9", name: "Vecino Repetido", phone: "3001234567" });
  A.signups.create({ code: "9", name: "Vecino Repetido", phone: "3001234567" });
  assert.equal(A.signups.pendingCount(), 1);
  assert.throws(() => A.signups.create({ code: "", name: "Vecino Repetido", phone: "3001234567" }), /número de tu casa/);
  assert.throws(() => A.signups.create({ code: "9", name: "x", phone: "3001234567" }), /nombre/);
  assert.throws(() => A.signups.create({ code: "9", name: "Vecino Repetido", phone: "123" }), /celular/);
  for (let i = 0; i < 60; i++) { try { A.signups.create({ code: String(100 + i), name: "Vecino Número " + i, phone: "3001234567" }); } catch { break; } }
  assert.throws(() => A.signups.create({ code: "999", name: "Vecino de Más", phone: "3009999999" }), /demasiadas/);
  // The tokens: each conjunto's link opens only its own; a "3" finds the house "03".
  store.tenants.setSignupToken(a.id, "token-de-ibiza-00000000000", "x");
  store.tenants.setSignupToken(b.id, "token-de-robles-0000000000", "y");
  assert.equal(store.tenants.bySignupToken("token-de-ibiza-00000000000").id, a.id);
  assert.equal(store.tenants.bySignupToken("token-de-robles-0000000000").id, b.id);
  store.tenants.clearSignupToken(a.id);
  assert.equal(store.tenants.bySignupToken("token-de-ibiza-00000000000"), null);
  assert.equal(store.tenants.bySignupToken("token-de-robles-0000000000").id, b.id, "el otro sigue");
  assert.equal(A.houses.byCode("3")?.code, "03");
  assert.equal(A.houses.byCode("03")?.code, "03");
  assert.equal(B.houses.byCode("14"), null);
  // "Empezar de cero" clears the requests of that conjunto only.
  A.reset({ keepHouses: true });
  assert.equal(A.signups.pendingCount(), 0);
  assert.equal(B.signups.pendingCount(), 1);
});

test("renombrar: solo a personas del propio conjunto, con límites", () => {
  const { store, A, B, a, b } = twoConjuntos();
  const ua = store.users.create({ tenantId: a.id, email: "marta@ejemplo.com", passwordHash: "x" });
  const ub = store.users.create({ tenantId: b.id, email: "luis@ejemplo.com", passwordHash: "x" });
  assert.throws(() => B.team.rename(ua, "Intruso"), /no es de este conjunto/);
  assert.equal(A.team.rename(ua, "  Marta   Rojas "), "Marta Rojas");
  assert.equal(store.users.byId(ua).name, "Marta");
  assert.equal(A.team.list()[0].fullName, "Marta Rojas");
  assert.equal(store.users.byId(ub).name, "Luis", "el otro conjunto no cambió");
  assert.throws(() => A.team.rename(ua, "x"), /entre 2 y 80/);
  assert.throws(() => A.team.rename(ua, "z".repeat(81)), /entre 2 y 80/);
});
