import test from "node:test";
import assert from "node:assert/strict";
import { sendReminders } from "../src/schedule.js";
import { twoConjuntos } from "./fixtures.js";

const ENDPOINT = (n) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${n}`, p256dh: "p", auth: "a" });
const fakeNotifier = () => {
  const calls = [];
  return { calls, house: async (tenantId, houseId, message) => { calls.push({ tenantId, houseId, message }); return 1; }, team: async () => 0 };
};
// 15:00 UTC is 10:00 in Colombia.
const at = (iso) => new Date(iso);

test("recordatorios a residentes: solo donde hay último día de pago, a quien debe y tiene avisos, una vez por mes", async () => {
  const { store, a, b, A, B, a14, a03, b01 } = twoConjuntos();
  store.tenants.setDates(a.id, { openDay: 1, dueDay: 10 }); // B sets no last day
  A.dues.generate("2026-11"); B.dues.generate("2026-11");
  A.housePush.add({ houseId: a14.house.id, ...ENDPOINT(1) });
  B.housePush.add({ houseId: b01.house.id, ...ENDPOINT(2) });
  // a03 owes too but never turned notifications on.
  const n = fakeNotifier();

  assert.equal(await sendReminders(store, n, at("2026-11-09T15:00:00Z")), 0, "el día 9 todavía no");
  assert.equal(await sendReminders(store, n, at("2026-11-10T12:00:00Z")), 0, "a las 7 a. m. todavía no (se envía de 8 a 20 h)");
  assert.equal(await sendReminders(store, n, at("2026-11-11T01:30:00Z")), 0, "a las 8:30 p. m. ya no");

  assert.equal(await sendReminders(store, n, at("2026-11-10T15:00:00Z")), 1);
  assert.deepEqual(n.calls.map((c) => [c.tenantId, c.houseId]), [[a.id, a14.house.id]], "solo la casa 14 de Ibiza: Robles no fijó fecha y la 03 no activó avisos");
  assert.match(n.calls[0].message.title, /vence/);
  assert.match(n.calls[0].message.body, /\$30\.000/);
  assert.equal(n.calls[0].message.url, "@resident/pagar");

  assert.equal(await sendReminders(store, n, at("2026-11-10T18:00:00Z")), 0, "la misma casa no recibe lo mismo dos veces");
  assert.equal(await sendReminders(store, n, at("2026-11-11T15:00:00Z")), 1, "al día siguiente, 'venció'");
  assert.match(n.calls[1].message.title, /venció/);
  assert.equal(await sendReminders(store, n, at("2026-11-12T15:00:00Z")), 0, "después ya no insiste");

  // Next month it starts over, and a house that already paid gets nothing.
  A.dues.generate("2026-12");
  const due = A.dues.listForHouse(a14.house.id).find((d) => d.period === "2026-12");
  A.payments.recordManual({ houseId: a14.house.id, dueIds: [due.id], method: "cash" });
  assert.equal(await sendReminders(store, n, at("2026-12-10T15:00:00Z")), 0);
  assert.ok(a03.house.id);
});

test("avisos de residentes: aislados por conjunto, solo casas activas del propio conjunto", () => {
  const { A, B, a14, b01 } = twoConjuntos();
  A.housePush.add({ houseId: a14.house.id, ...ENDPOINT(10) });
  assert.throws(() => B.housePush.add({ houseId: a14.house.id, ...ENDPOINT(11) }), /no existe en este conjunto/);
  assert.deepEqual(B.housePush.list(a14.house.id), []);
  assert.equal(B.housePush.count(a14.house.id), 0);
  assert.deepEqual(B.housePush.houseIds(), []);
  B.housePush.remove(ENDPOINT(10).endpoint);
  assert.equal(A.housePush.count(a14.house.id), 1, "otro conjunto no pudo quitar el dispositivo");
  assert.throws(() => B.reminders.claim(a14.house.id, "2026-11", "vence"), /no existe en este conjunto/);
  assert.equal(A.reminders.claim(a14.house.id, "2026-11", "vence"), true);
  assert.equal(A.reminders.claim(a14.house.id, "2026-11", "vence"), false);
  A.houses.setActive(a14.house.id, false);
  assert.throws(() => A.housePush.add({ houseId: a14.house.id, ...ENDPOINT(12) }), /no existe/, "una casa dada de baja no se suscribe");
  assert.ok(b01.house.id);
});
