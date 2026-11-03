import { bogotaDay, currentPeriod, periodLabel, peso } from "./text.js";

/**
 * Creates this month's dues for every conjunto (one per active house and concept). Safe to run as often as you like:
 * what already exists is left alone. Without it, a payment that arrives before the treasurer remembers to press
 * "Generar cuotas" finds no open due and waits in "por asignar".
 * @returns {number} how many dues were created
 */
export function generateAllDues(store, period = currentPeriod()) {
  let created = 0;
  for (const tenant of store.tenants.list()) created += store.forTenant(tenant.id).dues.generate(period);
  return created;
}

/**
 * Reminders to residents who installed the app and allowed notifications. Only for conjuntos that set a last day to pay
 * (Ajustes → Fechas de pago): on that day ("hoy vence") and the day after ("venció"), between 8 and 20 h Colombia time,
 * to houses that still owe this month's due. Each reminder is claimed in the database first, so a restart or the hourly
 * run never sends it twice.
 * @returns {Promise<number>} how many reminders went out
 */
export async function sendReminders(store, notifier, now = new Date()) {
  const period = currentPeriod(now);
  const day = bogotaDay(now);
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "America/Bogota", hour: "2-digit", hourCycle: "h23" }).format(now));
  if (hour < 8 || hour >= 20) return 0;
  let sent = 0;
  for (const tenant of store.tenants.list()) {
    if (!tenant.dueDay) continue;
    const kind = day === tenant.dueDay ? "vence" : day === tenant.dueDay + 1 ? "vencio" : null;
    if (!kind) continue;
    const ledger = store.forTenant(tenant.id);
    const subscribed = new Set(ledger.housePush.houseIds());
    if (subscribed.size === 0) continue;
    const owing = new Map();
    for (const due of ledger.dues.listPending()) if (due.period === period) owing.set(due.houseId, (owing.get(due.houseId) ?? 0) + due.amountCents);
    for (const [houseId, cents] of owing) {
      if (!subscribed.has(houseId) || !ledger.reminders.claim(houseId, period, kind)) continue;
      const amount = peso(cents);
      await notifier.house(tenant.id, houseId, kind === "vence"
        ? { title: "Hoy vence tu cuota", body: `Tu cuota de ${periodLabel(period).split(" ")[0]} es de ${amount}. Hoy es el último día para pagar.`, url: "@resident/pagar", tag: "recordatorio" }
        : { title: "Tu cuota venció", body: `Tienes pendiente ${amount}. Puedes pagarla hoy y subir tu comprobante.`, url: "@resident/pagar", tag: "recordatorio" });
      sent += 1;
    }
  }
  return sent;
}

/**
 * Is it time for the nightly off-server copy? Between 2 and 6 a.m. in Colombia once the last good copy is over 20 hours old,
 * or at any hour when it is over 36 hours old (so a server that was off at night catches up). No good copy yet: now.
 */
export function offsiteDue(lastOkIso, now = new Date()) {
  if (!lastOkIso) return true;
  const hours = (now.getTime() - new Date(lastOkIso).getTime()) / 3_600_000;
  if (!(hours >= 0)) return false;
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "America/Bogota", hour: "2-digit", hourCycle: "h23" }).format(now));
  return hours > 36 || (hours > 20 && hour >= 2 && hour < 6);
}
