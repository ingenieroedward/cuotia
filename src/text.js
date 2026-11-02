/** "José  Díaz-Pérez " -> "JOSE DIAZ PEREZ": for comparing a payer's name typed by hand against the bank's version. */
export function normalizeName(name) {
  return String(name ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9ñÑ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

/**
 * Same rule as pagoradar/Ibirifas: at least two words in common (one if a name has a single word),
 * and every word of the shorter name must appear in the other.
 */
export function namesMatch(a, b) {
  const words = (s) => new Set(normalizeName(s).split(" ").filter((w) => w.length > 1));
  const x = words(a);
  const y = words(b);
  if (x.size === 0 || y.size === 0) return false;
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared >= Math.min(2, x.size, y.size) && shared === Math.min(x.size, y.size);
}

/** 3000000 cents -> "$30.000" (Colombian pesos, thousands with a dot). */
export function peso(cents) {
  const pesos = Math.round(Number(cents) / 100);
  return `${pesos < 0 ? "-" : ""}$${Math.abs(pesos).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;
}

/** The current month in Colombia as "YYYY-MM". */
export function currentPeriod(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota", year: "numeric", month: "2-digit" }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}`;
}

const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
/** "2026-11" -> "noviembre 2026". */
export function periodLabel(period) {
  const [y, m] = period.split("-");
  return `${MONTHS[Number(m) - 1] ?? m} ${y}`;
}
