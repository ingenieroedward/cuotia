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

/** "Jardines de Ibiza" -> "jardines-de-ibiza": a short, URL-friendly name for a conjunto. */
export function slugify(name) {
  const slug = String(name ?? "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
  return slug || "conjunto";
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

/** "2026-11-02T15:22:53Z" -> "2 nov" (Colombia time). */
export function shortDate(iso) {
  return new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", day: "numeric", month: "short" }).format(new Date(iso)).replace(".", "");
}

const BANKS = { nequi: "Nequi", nequi_negocios: "Nequi Negocios", bancolombia: "Bancolombia" };
export const bankLabel = (bank) => BANKS[bank] ?? (bank ? String(bank) : "Banco");

/** The [from, to) UTC instants of a "YYYY-MM" month in Colombia (UTC-5, no daylight saving), as ISO strings. */
export function periodRange(period) {
  const [y, m] = period.split("-").map(Number);
  return [new Date(Date.UTC(y, m - 1, 1, 5)).toISOString(), new Date(Date.UTC(y, m, 1, 5)).toISOString()];
}

/** "2026-11-03T15:22:53Z" -> "2026-11-03 10:22" (Colombia time, 24 h): for spreadsheets. */
export function bogotaDateTime(iso) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const g = (t) => parts.find((x) => x.type === t).value;
  return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}`;
}

/** The last `n` months ending at `period`, newest first: ["2026-11", "2026-10", …]. */
export function lastPeriods(period, n = 12) {
  let [y, m] = period.split("-").map(Number);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    if (--m === 0) { m = 12; y--; }
  }
  return out;
}

/** One CSV cell: quoted, and a leading = + - @ is neutralized so a spreadsheet never runs a payer's name as a formula. */
export function csvCell(value) {
  let s = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/** "2026-11-03T15:22:53Z" -> "3 nov, 10:22" (Colombia time). */
export function shortDateTime(iso) {
  const d = new Date(iso);
  const time = new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  return `${shortDate(iso)}, ${time}`;
}
