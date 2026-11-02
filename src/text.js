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
/** "2026-11" -> "nov" (three letters, for small chips). */
export function monthShort(period) {
  return MONTHS[Number(period.split("-")[1]) - 1]?.slice(0, 3) ?? period;
}

/** "2026-11" -> "Noviembre" (capitalised, no year). */
export function monthName(period) {
  const m = MONTHS[Number(period.split("-")[1]) - 1] ?? period;
  return m[0].toUpperCase() + m.slice(1);
}

/** The previous or next month of "YYYY-MM": shiftPeriod("2026-01", -1) = "2025-12". */
export function shiftPeriod(period, delta) {
  const [y, m] = period.split("-").map(Number);
  const index = y * 12 + (m - 1) + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/** The number a wa.me link needs (Colombian mobiles get 57), or "" when the phone is missing or unusable. */
export function whatsappNumber(phone) {
  const d = String(phone ?? "").replace(/\D/g, "");
  return d.length === 10 ? `57${d}` : d.length >= 11 ? d : "";
}

/** "2026-11" -> "noviembre 2026". */
export function periodLabel(period) {
  const [y, m] = period.split("-");
  return `${MONTHS[Number(m) - 1] ?? m} ${y}`;
}

/** "2026-11-02T15:22:53Z" -> "2 nov" (Colombia time). */
export function shortDate(iso) {
  return new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", day: "numeric", month: "short" }).format(new Date(iso)).replace(".", "");
}

/** How each manual payment method is named in the ledger, the history and the form. */
export const MANUAL_LABELS = { cash: "Efectivo", transfer: "Transferencia", other: "Otro" };

/** What a payment is called in lists, receipts and the spreadsheet: "Efectivo", "Transferencia · Nequi", "Nequi Negocios"… */
export function paymentMedium(p) {
  if (!p.manual) return bankLabel(p.bank);
  if (p.method === "transfer") return p.bank ? `Transferencia · ${p.bank}` : "Transferencia";
  return p.method === "other" ? "Otro" : "Efectivo";
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

/**
 * Houses pasted from a spreadsheet or typed by hand: one per line, "code ; name ; phone" (tab or semicolon; a comma if
 * the line has neither). The phone is optional and a first line that looks like a header is skipped.
 * @returns {{ rows: {code, residentName, phone, line}[], errors: {line, text, reason}[] }}
 */
export function parseHouseLines(text, { max = 300 } = {}) {
  const rows = [];
  const errors = [];
  const seen = new Set();
  let first = true;
  String(text ?? "").split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const cells = line.split(/[\t;]/.test(line) ? /[\t;]/ : ",").map((c) => c.trim());
    if (first) {
      first = false;
      if (/^(c[oó]digo|casa|apto|apartamento|n[uú]mero|no\.?)$/i.test(cells[0])) return;
    }
    const fail = (reason) => errors.push({ line: i + 1, text: line.slice(0, 80), reason });
    if (rows.length >= max) return fail(`Máximo ${max} casas por vez`);
    const [code, residentName, phoneRaw = ""] = cells;
    if (!code || !residentName) return fail("Faltan el código o el nombre");
    if (code.length > 12) return fail("El código es demasiado largo (máximo 12)");
    if (residentName.length > 80) return fail("El nombre es demasiado largo (máximo 80)");
    if (seen.has(code.toLowerCase())) return fail(`El código ${code} está repetido en la lista`);
    seen.add(code.toLowerCase());
    rows.push({ code, residentName, phone: phoneRaw.replace(/\D/g, "").slice(0, 20) || null, line: i + 1 });
  });
  return { rows, errors };
}
