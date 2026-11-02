import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { backupName, backupTo, pruneBackups } from "../src/backup.js";
import { parseCookies } from "../src/http.js";
import { ingestEvent } from "../src/pagoradar.js";
import { generateAllDues } from "../src/schedule.js";
import { openStore } from "../src/store.js";
import { parseHouseLines } from "../src/text.js";
import { paymentEvent, twoConjuntos } from "./fixtures.js";

test("las cuotas del mes se crean solas para todos los conjuntos, sin duplicar y sin tocar casas desactivadas", () => {
  const { store, A, B, a14, a03 } = twoConjuntos();
  assert.equal(generateAllDues(store, "2026-11"), 3, "dos casas de un conjunto y una del otro");
  assert.equal(generateAllDues(store, "2026-11"), 0, "repetirlo no crea nada");
  assert.equal(A.dues.listByPeriod("2026-11").length, 2);
  assert.equal(B.dues.listByPeriod("2026-11").length, 1);

  A.houses.setActive(a03.house.id, false);
  assert.equal(generateAllDues(store, "2026-12"), 2, "la casa desactivada no recibe cuota");
  const late = A.houses.create({ code: "20", residentName: "Recién Llegada" });
  assert.equal(generateAllDues(store, "2026-12"), 1, "una casa agregada después recibe la suya en la siguiente pasada");
  assert.equal(A.dues.listForHouse(late.house.id).length, 1);

  // A conjunto with no concept has nothing to charge: no error, no dues.
  store.tenants.create({ slug: "vacio", name: "Sin conceptos" });
  assert.doesNotThrow(() => generateAllDues(store, "2027-01"));
});

test("con las cuotas ya creadas, un pago antes de que el tesorero haga nada se concilia solo", () => {
  const { store, a, A } = twoConjuntos();
  assert.equal(ingestEvent(store, paymentEvent({ id: "antes", payerName: "Sandra Duque Arias" }), a.id).status, "unassigned", "sin cuotas no hay con qué conciliar");
  generateAllDues(store, "2026-11");
  assert.equal(ingestEvent(store, paymentEvent({ id: "despues", payerName: "Sandra Duque Arias" }), a.id).status, "assigned");
  assert.equal(A.summary("2026-11").paidCount, 1);
});

test("un nombre de pagador larguísimo se recorta", () => {
  const { store, a, A } = twoConjuntos();
  ingestEvent(store, paymentEvent({ id: "largo", payerName: "X".repeat(5000) }), a.id);
  assert.equal(A.payments.listUnassigned()[0].payerName.length, 120);
});

test("lista de casas pegada: tabuladores, punto y coma, comas, encabezado, vacías y errores", () => {
  const pasted = ["Código\tNombre\tCelular", "01\tMarta Rojas\t300 123 4567", "", "02;Julián Castaño;3109876543", "03,Diana Pérez", "04;Sin celular;", "05", "TOOLONGCODE12345;Ana", `06;${"N".repeat(81)}`, "01;Repetida;3000000000", "07;Última"].join("\r\n");
  const { rows, errors } = parseHouseLines(pasted);
  assert.deepEqual(rows.map((r) => [r.code, r.residentName, r.phone]), [
    ["01", "Marta Rojas", "3001234567"], ["02", "Julián Castaño", "3109876543"], ["03", "Diana Pérez", null], ["04", "Sin celular", null], ["07", "Última", null],
  ]);
  assert.deepEqual(errors.map((e) => e.line), [7, 8, 9, 10], "cada línea mala se señala por su número");
  assert.match(errors[0].reason, /Faltan/);
  assert.match(errors[1].reason, /código es demasiado largo/);
  assert.match(errors[2].reason, /nombre es demasiado largo/);
  assert.match(errors[3].reason, /repetido/);
  assert.deepEqual(parseHouseLines("", {}).rows, []);
  assert.deepEqual(parseHouseLines(undefined).rows, []);
  const many = parseHouseLines(Array.from({ length: 5 }, (_, i) => `${i};Casa ${i}`).join("\n"), { max: 3 });
  assert.equal(many.rows.length, 3);
  assert.equal(many.errors.length, 2);
  assert.match(many.errors[0].reason, /Máximo 3/);
});

test("una cookie dañada no tumba la página", () => {
  assert.deepEqual(parseCookies("cuotia_sid=%E0%A4%A; otra=a%20b"), { cuotia_sid: "%E0%A4%A", otra: "a b" });
  assert.deepEqual(parseCookies(undefined), {});
});

test("cobro, contraseña y recuperación de cuentas en la capa de datos", () => {
  const { store, a, b, a14 } = twoConjuntos();
  store.tenants.setPayment(a.id, { payKey: "  @nueva.llave ", payHolder: "Ana Pérez" });
  assert.deepEqual([store.tenants.get(a.id).payKey, store.tenants.get(a.id).payHolder], ["@nueva.llave", "Ana Pérez"]);
  assert.equal(store.tenants.get(b.id).payKey, null, "el otro conjunto no cambia");
  store.tenants.setPayment(a.id, { payKey: "", payHolder: "" });
  assert.equal(store.tenants.get(a.id).payKey, null, "vacío = sin configurar");

  const uid = store.users.create({ tenantId: a.id, email: "t@ejemplo.com", passwordHash: "viejo", name: "Marta Rojas" });
  const other = store.users.create({ tenantId: b.id, email: "o@ejemplo.com", passwordHash: "otro" });
  assert.equal(store.users.byId(uid).name, "Marta", "el saludo usa el primer nombre");
  assert.equal(store.users.byEmail("o@ejemplo.com").name, "O", "sin nombre, sale del correo");
  store.users.setPasswordHash(uid, "nuevo");
  assert.equal(store.users.byId(uid).passwordHash, "nuevo");
  assert.equal(store.users.byId(other).passwordHash, "otro");

  store.users.setTotpSecret(uid, "cifrado");
  store.users.enableTotp(uid);
  store.users.claimTotpStep(uid, 99);
  store.users.resetTotp(uid);
  const u = store.users.byId(uid);
  assert.deepEqual([u.totpSecret, u.totpEnabled], [null, false]);
  assert.equal(store.users.claimTotpStep(uid, 1), true, "el contador de códigos usados también se reinicia");

  const keep = store.sessions.create(uid);
  const drop = store.sessions.create(uid);
  const foreign = store.sessions.create(other);
  store.sessions.deleteForUser(uid, keep);
  assert.ok(store.sessions.resolve(keep));
  assert.equal(store.sessions.resolve(drop), null);
  assert.ok(store.sessions.resolve(foreign), "las sesiones de otra persona no se tocan");
  store.sessions.deleteForUser(uid);
  assert.equal(store.sessions.resolve(keep), null);
  assert.equal(a14.house.code, "14");
});

test("respaldo: copia consistente y legible, y no sobrescribe uno existente", () => {
  const dir = mkdtempSync(join(tmpdir(), "cuotia-respaldo-"));
  try {
    const store = openStore(join(dir, "vivo.db"));
    const t = store.tenants.create({ slug: "ibiza", name: "Jardines de Ibiza" });
    store.forTenant(t.id).houses.create({ code: "14", residentName: "Sandra Duque" });

    const copy = backupTo(store.db, join(dir, "backups", "copia.db"));
    assert.ok(copy.bytes > 0);
    const reopened = new DatabaseSync(copy.file);
    assert.equal(reopened.prepare("SELECT name FROM tenants").get().name, "Jardines de Ibiza");
    assert.equal(reopened.prepare("SELECT code FROM houses").get().code, "14");
    reopened.close();

    store.forTenant(t.id).houses.create({ code: "15", residentName: "Otra" });
    assert.throws(() => backupTo(store.db, copy.file), /no se sobrescribe/);
    const still = new DatabaseSync(copy.file);
    assert.equal(still.prepare("SELECT COUNT(*) AS n FROM houses").get().n, 1, "el respaldo bueno quedó intacto");
    still.close();
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("respaldo: se conservan los últimos y no se borra nada que no sea un respaldo nuestro", () => {
  const dir = mkdtempSync(join(tmpdir(), "cuotia-podar-"));
  try {
    const names = [0, 1, 2, 3].map((i) => backupName(new Date(Date.UTC(2026, 10, 1 + i, 12, 30, 5))));
    assert.equal(names[0], "cuotia-20261101-123005.db");
    assert.deepEqual([...names].sort(), names, "el nombre ordena por fecha");
    mkdirSync(join(dir, "r"));
    for (const n of [...names, "notas.txt", "cuotia-viejo.db"]) writeFileSync(join(dir, "r", n), "x");

    assert.deepEqual(pruneBackups(join(dir, "r"), 2), names.slice(0, 2), "se borran los más viejos");
    assert.deepEqual(readdirSync(join(dir, "r")).sort(), [...names.slice(2), "cuotia-viejo.db", "notas.txt"].sort());
    assert.deepEqual(pruneBackups(join(dir, "no-existe"), 2), []);
    assert.equal(pruneBackups(join(dir, "r"), 0).length, 1, "siempre se conserva al menos uno");
    assert.deepEqual(readdirSync(join(dir, "r")).filter((f) => f.startsWith("cuotia-2026")), [names[3]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
