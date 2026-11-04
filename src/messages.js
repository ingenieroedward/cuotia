/**
 * The WhatsApp messages the treasurer sends. Each conjunto can edit them: a message is plain text with {variables} that are
 * replaced when it is sent. `renderTemplate` here and `renderMessage` in public/app.js (the live preview) must stay identical.
 */

export const MESSAGES = {
  recordatorio_casa: {
    title: "Recordatorio a una casa",
    when: "El botón WhatsApp de una casa en Por cobrar y en Casas. Se envía solo a esa familia.",
    default: [
      "Hola {nombre}, te escribe {tesorero} de {conjunto}.",
      "",
      "Te recordamos que la casa {casa} tiene pendiente la cuota {meses}: *{valor}*.",
      "{detalle}",
      "",
      "{plazo} {como_pagar}",
      "",
      "Cuando pagues, sube tu comprobante desde tu enlace personal o respóndeme este mensaje con la foto. ¡Gracias por estar al día!",
    ].join("\n"),
    vars: {
      nombre: ["Sandra", "El primer nombre del residente"],
      casa: ["14", "El número de la casa"],
      conjunto: [null, "El nombre del conjunto"],
      tesorero: [null, "Tu nombre (quien envía)"],
      meses: ["de octubre y noviembre", "Los meses que debe"],
      valor: ["$60.000", "Lo que debe en total"],
      detalle: ["• Octubre · Vigilancia: $30.000\n• Noviembre · Vigilancia: $30.000", "Una línea por cuota: mes, cobro y valor"],
      plazo: [null, "El último día para pagar, si lo configuraste (si no, queda vacío)"],
      como_pagar: [null, "Tus medios de pago: llave Bre-B, Nequi, Daviplata, cuenta…"],
    },
    required: [],
  },
  recordatorio_general: {
    title: "Recordatorio para todos",
    when: "El botón \"Recordar a todos por WhatsApp\" (Resumen y Por cobrar). Va al grupo de vecinos.",
    default: [
      "Hola vecinos de {conjunto},",
      "",
      "Les recordamos la cuota de {mes}: {valor_cuota} por casa.",
      "",
      "Casas con cuota pendiente:",
      "{casas}",
      "",
      "{plazo} {como_pagar}",
      "",
      "Después de pagar, suban su comprobante desde su enlace personal. ¡Gracias! — {tesorero}",
    ].join("\n"),
    vars: {
      conjunto: [null, "El nombre del conjunto"],
      mes: ["noviembre", "El mes en curso"],
      valor_cuota: ["$30.000", "La cuota mensual de cada casa"],
      casas: ["03 (oct, nov)\n14 (nov)", "Las casas que deben y desde cuándo, una por línea"],
      plazo: [null, "El último día para pagar, si lo configuraste (si no, queda vacío)"],
      como_pagar: [null, "Tus medios de pago: llave Bre-B, Nequi, Daviplata, cuenta…"],
      tesorero: [null, "Tu nombre (quien envía)"],
    },
    required: [],
  },
  enlace_casa: {
    title: "Enlace personal de una casa",
    when: "Al crear una casa o regenerar su enlace: el botón \"Enviar por WhatsApp\". Va solo a esa familia.",
    default: [
      "Hola {nombre}, soy {tesorero} de {conjunto}.",
      "",
      "Este es tu enlace personal de Cuotia para la casa {casa}: ahí ves cuánto debes, cómo pagar y subes tus comprobantes.",
      "",
      "{enlace}",
      "",
      "Guárdalo y no lo compartas: es solo tuyo. Si quieres, ábrelo y toca «Compartir» → «Añadir a pantalla de inicio» para tenerlo como una app.",
    ].join("\n"),
    vars: {
      nombre: ["Sandra", "El primer nombre del residente"],
      casa: ["14", "El número de la casa"],
      conjunto: [null, "El nombre del conjunto"],
      tesorero: [null, "Tu nombre (quien envía)"],
      enlace: ["https://cuotia.ejemplo.com/r/ejemplo", "Su enlace personal (obligatorio)"],
    },
    required: ["enlace"],
  },
};

export const MESSAGE_KEYS = Object.keys(MESSAGES);
const MAX_LENGTH = 1200;

/** Replaces {variables} and tidies what is left: no trailing spaces, no doubled spaces, no run of blank lines. Keep in step with renderMessage in public/app.js. */
export function renderTemplate(body, vars) {
  return String(body)
    .replace(/\{([a-z_]+)\}/g, (match, key) => (key in vars ? String(vars[key]) : match))
    .split("\n").map((line) => line.replace(/^[ \t]+|[ \t]+$/g, "").replace(/ {2,}/g, " ")).join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The text of a message for a conjunto: its own version if it edited it, otherwise the original, rendered with `vars`. */
export function message(tenant, key, vars) {
  const body = tenant.templates?.[key] ?? MESSAGES[key].default;
  // Emojis are never sent: several phones and WhatsApp's share page show them as "?" or "�". A text saved before this rule is cleaned here.
  return renderTemplate(stripEmoji(body), { conjunto: tenant.name, tesorero: tenant.sender ?? "la tesorería", ...vars });
}

/** Pictographs, dingbats, variation selectors and joiners: what a phone may fail to draw. Plain accents and punctuation stay. */
const EMOJI = /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}]/u;
export const hasEmoji = (text) => EMOJI.test(String(text));
export const stripEmoji = (text) => String(text).replace(new RegExp(EMOJI.source, "gu"), "");

/** Checks an edited message. Returns { ok: true, body } or { ok: false, error }. */
export function validateTemplate(key, raw) {
  const spec = MESSAGES[key];
  if (!spec) return { ok: false, error: "Ese mensaje no existe" };
  const body = String(raw ?? "").replace(/\r\n/g, "\n").replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").trim();
  if (hasEmoji(body)) return { ok: false, error: "Sin emojis: en algunos teléfonos se ven como signos de interrogación" };
  if (body.length < 15) return { ok: false, error: "El mensaje es muy corto" };
  if (body.length > MAX_LENGTH) return { ok: false, error: `El mensaje es muy largo (máximo ${MAX_LENGTH} caracteres)` };
  const used = [...body.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]);
  const unknown = [...new Set(used.filter((v) => !(v in spec.vars)))];
  if (unknown.length) return { ok: false, error: `Variable${unknown.length === 1 ? "" : "s"} desconocida${unknown.length === 1 ? "" : "s"}: ${unknown.map((v) => `{${v}}`).join(", ")}` };
  const missing = spec.required.filter((v) => !used.includes(v));
  if (missing.length) return { ok: false, error: `Este mensaje debe llevar ${missing.map((v) => `{${v}}`).join(", ")}` };
  return { ok: true, body };
}
