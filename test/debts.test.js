import test from "node:test";
import assert from "node:assert/strict";
import { debtTotals, groupDebts } from "../src/debts.js";

const due = (houseId, period, cents = 3_000_000, conceptName = "Vigilancia") => ({ houseId, period, amountCents: cents, conceptName });
const house = (id, code, name = `Casa ${code}`) => ({ id, code, residentName: name });

test("quién debe: primero quien arrastra meses, luego el más antiguo, luego el que más debe; los códigos se ordenan como números", () => {
  const houses = [house("a", "10"), house("b", "2"), house("c", "3"), house("d", "1")];
  const pending = [
    due("a", "2026-11"), due("b", "2026-10"), due("b", "2026-11"), due("c", "2026-11"), due("c", "2026-11", 1_000_000, "Administración"),
    due("d", "2026-09"),
  ];
  const groups = groupDebts(pending, houses, "2026-11");
  assert.deepEqual(groups.map((g) => g.house.code), ["1", "2", "3", "10"], "1 (desde septiembre) y 2 (desde octubre) primero; después este mes: más deuda primero, y 3 antes que 10");
  const one = groups[0];
  assert.deepEqual([one.overdueCount, one.overdueCents, one.oldest, one.months], [1, 3_000_000, "2026-09", ["2026-09"]]);
  const two = groups[1];
  assert.deepEqual([two.dues.length, two.totalCents, two.overdueCount, two.months], [2, 6_000_000, 1, ["2026-10", "2026-11"]]);
  const three = groups[2];
  assert.deepEqual([three.dues.length, three.totalCents, three.overdueCount, three.months], [2, 4_000_000, 0, ["2026-11"]], "dos conceptos del mismo mes son un solo mes");
  assert.deepEqual(debtTotals(groups), { houses: 4, totalCents: 16_000_000, overdueHouses: 2, overdueCents: 6_000_000, overdueDues: 2 });
});

test("quién debe: solo las casas activas que se le pasan; lo demás no cuenta", () => {
  const groups = groupDebts([due("a", "2026-11"), due("fantasma", "2026-09")], [house("a", "1")], "2026-11");
  assert.equal(groups.length, 1);
  assert.deepEqual(debtTotals([]), { houses: 0, totalCents: 0, overdueHouses: 0, overdueCents: 0, overdueDues: 0 });
  assert.deepEqual(groupDebts([], [house("a", "1")], "2026-11"), []);
});

test("el mes en curso no es atraso: solo lo es un mes anterior", () => {
  const [g] = groupDebts([due("a", "2026-11")], [house("a", "1")], "2026-11");
  assert.equal(g.overdueCount, 0);
  const [h] = groupDebts([due("a", "2026-11")], [house("a", "1")], "2026-12");
  assert.equal(h.overdueCount, 1, "al llegar diciembre, noviembre ya es atraso");
});

test("fecha límite: pasado el último día para pagar, la cuota de este mes es vencida; ese día todavía no", () => {
  const h = [house("a", "1")];
  const p = [due("a", "2026-11")];
  assert.equal(groupDebts(p, h, "2026-11", { dueDay: 10, day: 10 })[0].overdueCount, 0, "el día 10 todavía está a tiempo");
  const [late] = groupDebts(p, h, "2026-11", { dueDay: 10, day: 11 });
  assert.deepEqual([late.overdueCount, late.overdueCents, late.lateMonths, late.dues[0].late], [1, 3_000_000, ["2026-11"], true]);
  assert.equal(groupDebts(p, h, "2026-11", { dueDay: null, day: 28 })[0].overdueCount, 0, "sin fecha límite no hay vencimiento antes de fin de mes");
  assert.equal(groupDebts([due("a", "2026-10")], h, "2026-11", { dueDay: 10, day: 1 })[0].overdueCount, 1, "un mes anterior siempre es atraso");
});
