import { currentPeriod } from "./text.js";

/**
 * Who owes what, month by month. `pending` are the unpaid dues (store.dues.listPending), `houses` the active houses
 * (only they can owe). Returns one entry per house with something pending, the ones with the oldest debt first, then
 * the biggest: that is the order a treasurer wants to chase them in.
 *
 * "Overdue" (atrasada) means a due of a month before `period`; this month's due is just "pending" until the month ends.
 */
export function groupDebts(pending, houses, period = currentPeriod()) {
  const byId = new Map(houses.map((h) => [h.id, h]));
  const groups = new Map();
  for (const due of pending) {
    const house = byId.get(due.houseId);
    if (!house) continue;
    if (!groups.has(house.id)) groups.set(house.id, { house, dues: [], totalCents: 0 });
    const g = groups.get(house.id);
    g.dues.push(due);
    g.totalCents += due.amountCents;
  }
  const list = [...groups.values()].map((g) => {
    g.dues.sort((a, b) => a.period.localeCompare(b.period) || a.conceptName.localeCompare(b.conceptName));
    const late = g.dues.filter((d) => d.period < period);
    return {
      ...g,
      overdueCount: late.length,
      overdueCents: late.reduce((sum, d) => sum + d.amountCents, 0),
      oldest: g.dues[0].period,
      months: [...new Set(g.dues.map((d) => d.period))],
    };
  });
  list.sort((a, b) =>
    (b.overdueCount > 0) - (a.overdueCount > 0)
    || a.oldest.localeCompare(b.oldest)
    || b.totalCents - a.totalCents
    || a.house.code.localeCompare(b.house.code, "es", { numeric: true }));
  return list;
}

/** The headline numbers of a list of debts. */
export function debtTotals(groups) {
  return {
    houses: groups.length,
    totalCents: groups.reduce((s, g) => s + g.totalCents, 0),
    overdueHouses: groups.filter((g) => g.overdueCount > 0).length,
    overdueCents: groups.reduce((s, g) => s + g.overdueCents, 0),
    overdueDues: groups.reduce((s, g) => s + g.overdueCount, 0),
  };
}
