import { currentPeriod } from "./text.js";

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
