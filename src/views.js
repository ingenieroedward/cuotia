import { html, raw } from "./http.js";
import { qrSvg } from "./qr.js";
import { MANUAL_LABELS, bankLabel, bogotaDay, lastPeriods, matchesSearch, monthName, monthShort, paymentMedium, peso, periodLabel, shortDate, shortDateTime, whatsappNumber } from "./text.js";

const ICONS = {
  home: '<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  casas: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  pagos: '<rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 10h18"/><circle cx="16.5" cy="15" r="1.2"/>',
  asignar: '<path d="M3 13l3-8h12l3 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M3 13h5l1 3h6l1-3h5"/>',
  ajustes: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  back: '<path d="M15 6l-6 6 6 6"/>',
  next: '<path d="M9 6l6 6-6 6"/>',
  cobrar: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6.5l1 1 2-2M4 12.5l1 1 2-2M4 18.5l1 1 2-2"/>',
};
const icon = (name, size = 20, width = 2) => html`<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${raw(ICONS[name])}</svg>`;

const BRAND_MARK = html`<span class="brand"><span class="brand-mark"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span>cuotia</span>`;

export function layout(title, body, { refresh = 0, bodyClass = "", manifest = "/manifest.webmanifest" } = {}) {
  return html`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0B1B2B">
<meta name="color-scheme" content="light">
<meta name="application-name" content="Cuotia">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Cuotia">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/static/icons/favicon-32.png" type="image/png" sizes="32x32">
<link rel="icon" href="/static/icons/favicon-48.png" type="image/png" sizes="48x48">
<link rel="apple-touch-icon" href="/static/icons/apple-touch-icon.png">
<link rel="manifest" href="${manifest}">
<title>${title} · Cuotia</title>
${refresh ? raw(`<meta http-equiv="refresh" content="${Number(refresh)}">`) : ""}
<link rel="preload" href="/static/fonts/plus-jakarta-sans-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/static/app.css">
<script src="/static/app.js" defer></script>
</head>
<body${bodyClass ? raw(` class="${bodyClass}"`) : ""}>${body}</body>
</html>`;
}

/** Fixed messages the panel can show after an action. The query string only picks a key, never the text. */
const FLASH = {
  gen: (n) => ({ kind: "ok", text: n > 0 ? `Se crearon ${n} cuota${n === 1 ? "" : "s"} nueva${n === 1 ? "" : "s"}.` : "Las cuotas de este mes ya estaban creadas." }),
  asig: () => ({ kind: "ok", text: "Pago asignado y cuota marcada como pagada. Cuotia recordó el nombre." }),
  asigsin: () => ({ kind: "info", text: "Pago asignado, pero esa casa no tenía una cuota abierta por ese monto." }),
  manual: () => ({ kind: "ok", text: "Pago registrado: las cuotas quedaron al día." }),
  mesok: () => ({ kind: "ok", text: "Mes agregado y marcado. Revisa los datos y registra el pago." }),
  mesbad: () => ({ kind: "err", text: "Elige un mes de los últimos 24, sin pasarte del mes actual." }),
  manualbad: () => ({ kind: "err", text: "Revisa los datos: elige al menos una cuota y una fecha que no sea futura." }),
  dup: () => ({ kind: "err", text: "Ya existe una casa con ese código." }),
  ed: () => ({ kind: "ok", text: "Datos de la casa guardados." }),
  aliasok: () => ({ kind: "ok", text: "Nombre agregado: los pagos con ese nombre se asignarán a esta casa." }),
  aliasdel: () => ({ kind: "ok", text: "Nombre quitado." }),
  desact: () => ({ kind: "ok", text: "Casa desactivada. Su historial se conserva." }),
  react: () => ({ kind: "ok", text: "Casa reactivada." }),
  undo: () => ({ kind: "ok", text: "Asignación deshecha: el pago volvió a “Por asignar” y la cuota a pendiente." }),
  undoc: () => ({ kind: "ok", text: "Pago anulado: las cuotas que cubría volvieron a pendiente." }),
  sec: () => ({ kind: "ok", text: "Secreto de pagoradar guardado. Envía un evento de prueba desde pagoradar para confirmar la conexión." }),
  secbad: () => ({ kind: "err", text: "El secreto debe tener entre 8 y 200 caracteres y no puede llevar espacios." }),
  comprech: () => ({ kind: "ok", text: "Comprobante rechazado. El residente verá que no se pudo confirmar." }),
  eqbad: () => ({ kind: "err", text: "Escribe un correo válido para la invitación." }),
  eqexiste: () => ({ kind: "err", text: "Ese correo ya tiene una cuenta en Cuotia." }),
  eqcanc: () => ({ kind: "ok", text: "Invitación cancelada: su enlace ya no sirve." }),
  eqquit: () => ({ kind: "ok", text: "Listo: esa persona ya no puede entrar y sus sesiones se cerraron." }),
  eqyo: () => ({ kind: "err", text: "No puedes quitarte a ti mismo. Pídele a otra persona del equipo que lo haga." }),
  equltimo: () => ({ kind: "err", text: "No se pudo quitar: debe quedar al menos una persona con acceso." }),
  fechas: () => ({ kind: "ok", text: "Fechas de pago guardadas. Los residentes ya las ven y las cuotas se marcan vencidas después del último día." }),
  fechasbad: () => ({ kind: "err", text: "Escribe días entre 1 y 28, y el último día no puede ser antes del primero." }),
  cobro: () => ({ kind: "ok", text: "Cuenta para cobrar guardada. Los residentes ya ven la llave nueva." }),
  clave: () => ({ kind: "ok", text: "Contraseña cambiada. En los demás dispositivos tendrás que entrar de nuevo." }),
  clavemal: () => ({ kind: "err", text: "La contraseña actual no es correcta." }),
  clavebad: () => ({ kind: "err", text: "La contraseña nueva debe tener al menos 10 caracteres y las dos deben coincidir." }),
  clavelim: () => ({ kind: "err", text: "Demasiados intentos. Espera unos minutos." }),
  err: () => ({ kind: "err", text: "No se pudo completar la acción. Revisa los datos e inténtalo de nuevo." }),
};
export function flashOf(query) {
  const make = FLASH[query.get("m")];
  const n = Number.parseInt(query.get("n") ?? "0", 10);
  return make ? make(Number.isSafeInteger(n) && n >= 0 ? n : 0) : null;
}
const flashBox = (f) => (f ? html`<p class="flash ${f.kind}" role="status">${f.text}</p>` : "");

const csrfField = (csrf) => html`<input type="hidden" name="_csrf" value="${csrf}">`;

export function loginPage({ error, notice } = {}) {
  return layout("Entrar", html`
<main class="center">
  <form class="card login" method="post" action="/login">
    ${BRAND_MARK}
    <h1>Entrar</h1>
    <p class="muted">Panel del tesorero</p>
    ${notice ? html`<p class="flash ok" role="status">${notice}</p>` : ""}
    ${error ? html`<p class="alert" role="alert">${error}</p>` : ""}
    <label>Correo<input type="email" name="email" autocomplete="username" required autofocus></label>
    <label>Contraseña<input type="password" name="password" autocomplete="current-password" required></label>
    <button class="btn" type="submit">Continuar</button>
  </form>
</main>`);
}

/** First-run form: creates the first conjunto and its treasurer. Reached only through the private setup link. */
export function setupPage({ token, error, values = {} }) {
  return layout("Configuración inicial", html`
<main class="center">
  <form class="card setup" method="post" action="/setup">
    ${BRAND_MARK}
    <h1>Bienvenido a Cuotia</h1>
    <p class="muted">Crea tu primer conjunto y la cuenta de quien lo administrará. Este formulario solo funciona una vez.</p>
    ${error ? html`<p class="alert" role="alert">${error}</p>` : ""}
    <input type="hidden" name="token" value="${token}">
    <fieldset>
      <legend>Conjunto</legend>
      <label>Nombre<input type="text" name="nombre" maxlength="80" required value="${values.nombre ?? ""}" placeholder="Jardines de Ibiza"></label>
      <label>Cuota mensual de vigilancia (pesos)<input type="text" name="cuota" inputmode="numeric" maxlength="9" required value="${values.cuota ?? "30000"}"></label>
      <label>Llave Bre-B para cobrar<input type="text" name="llave" maxlength="80" value="${values.llave ?? ""}" placeholder="@mi.llave"></label>
      <label>Titular de la cuenta<input type="text" name="titular" maxlength="80" value="${values.titular ?? ""}" placeholder="Quien recibe el dinero"></label>
    </fieldset>
    <fieldset>
      <legend>Tesorero (quien entra al panel)</legend>
      <label>Tu nombre<input type="text" name="tesorero" maxlength="80" required autocomplete="name" value="${values.tesorero ?? ""}" placeholder="Marta Rojas"></label>
      <label>Correo<input type="email" name="correo" maxlength="120" required autocomplete="username" value="${values.correo ?? ""}"></label>
      <label>Contraseña (mínimo 10 caracteres)<input type="password" name="clave" minlength="10" maxlength="200" required autocomplete="new-password"></label>
      <label>Repite la contraseña<input type="password" name="clave2" minlength="10" maxlength="200" required autocomplete="new-password"></label>
    </fieldset>
    <button class="btn" type="submit">Crear conjunto</button>
    <p class="muted small">Después te pediremos activar el código de verificación en tu celular.</p>
  </form>
</main>`);
}

/** Second step. "setup" shows the key to add to an authenticator app; "pending" only asks for the code. */
export function twoFaPage({ stage, error, secret, uri, email }) {
  const grouped = secret ? secret.replace(/(.{4})/g, "$1 ").trim() : "";
  return layout("Código de verificación", html`
<main class="center">
  <form class="card login" method="post" action="/2fa" autocomplete="off">
    ${BRAND_MARK}
    <h1>${stage === "setup" ? "Protege tu cuenta" : "Código de verificación"}</h1>
    ${stage === "setup"
      ? html`<p class="muted">Antes de entrar, agrega Cuotia a una app de códigos (Google Authenticator, Microsoft Authenticator, 1Password…).</p>
        <ol class="steps">
          <li>En la app elige <b>agregar cuenta</b> y <b>escanea este código</b>:</li>
        </ol>
        <div class="qr">${raw(qrSvg(uri, { label: "Código QR para agregar Cuotia a tu app de códigos" }))}</div>
        <p class="muted small">¿No puedes escanearlo? Escribe esta clave en la app:</p>
        <p class="key secret" translate="no">${grouped}</p>
        <p class="small"><a href="${uri}">Abrir directamente en mi app</a> <span class="muted">(si estás en el celular)</span></p>
        <p class="muted small">Cuenta: ${email}. Guarda la clave en un lugar seguro: si pierdes el celular, un administrador tendrá que restablecerla.</p>`
      : html`<p class="muted">Escribe el código de 6 dígitos de tu app.</p>`}
    ${error ? html`<p class="alert" role="alert">${error}</p>` : ""}
    <label>Código<input class="code" type="text" name="code" inputmode="numeric" pattern="[0-9 ]{6,7}" maxlength="7" autocomplete="one-time-code" required autofocus></label>
    <button class="btn" type="submit">${stage === "setup" ? "Activar y entrar" : "Entrar"}</button>
  </form>
</main>`);
}

// ---------------------------------------------------------------------------------------------------------------
// Treasurer panel. A dark sidebar on a computer, a bottom tab bar on a phone (as in the approved mockups).
// ---------------------------------------------------------------------------------------------------------------

const NAV = [
  { key: "resumen", href: "/panel", label: "Resumen", icon: "home" },
  { key: "cobros", href: "/panel/cobros", label: "Por cobrar", icon: "cobrar" },
  { key: "casas", href: "/panel/casas", label: "Casas", icon: "casas" },
  { key: "pagos", href: "/panel/pagos", label: "Pagos", icon: "pagos" },
  { key: "ajustes", href: "/panel/ajustes", label: "Ajustes", icon: "ajustes" },
];

const BRAND_ON_DARK = html`<span class="brand on-dark"><span class="brand-mark">${icon("check", 16, 3)}</span>cuotia</span>`;

/**
 * The frame of every treasurer page. `ctx` carries who is signed in and what the sidebar shows:
 * { tenant, user, csrf, active, badge (payments waiting to be assigned), owing (houses that owe), houseCount, cuota }.
 */
export function panelLayout(title, ctx, content) {
  const { tenant, user, csrf, active, badge = 0, owing = 0, houseCount = 0, cuota = "" } = ctx;
  const current = (key) => (key === active ? raw(' aria-current="page"') : "");
  const unassigned = badge ? html`<span class="badge" aria-label="${badge} por asignar">${badge}</span>` : "";
  const owes = (n) => (n.key === "cobros" && owing ? html`<span class="badge warn" aria-label="${owing} casas deben">${owing}</span>` : "");
  const sideLink = (n) => html`<a class="nav-link" href="${n.href}"${current(n.key)}>${icon(n.icon)}<span>${n.label}</span>${owes(n)}</a>`;
  return layout(title, html`
<div class="app">
  <aside class="side">
    ${BRAND_ON_DARK}
    <nav class="side-nav" aria-label="Principal">
      ${NAV.slice(0, 4).map(sideLink)}
      <a class="nav-link" href="/panel#por-asignar">${icon("asignar")}<span>Por asignar</span>${unassigned}</a>
      ${sideLink(NAV[4])}
    </nav>
    <div class="side-foot">
      <div class="conj">
        <span class="eyebrow">Conjunto</span>
        <b>${tenant.name}</b>
        <small>${houseCount} casa${houseCount === 1 ? "" : "s"}${cuota ? ` · Vigilancia ${cuota}` : ""}</small>
      </div>
      <div class="me">
        <span class="small" title="${user.email}">${user.email}</span>
        <form method="post" action="/logout">${csrfField(csrf)}<button class="btn ghost small on-dark" type="submit">Salir</button></form>
      </div>
    </div>
  </aside>

  <div class="stage">
    <header class="mobilebar">
      ${BRAND_MARK}
      <form method="post" action="/logout">${csrfField(csrf)}<button class="btn ghost small" type="submit">Salir</button></form>
    </header>
    <main class="page">${content}</main>
  </div>

  <nav class="tabbar" aria-label="Principal">
    ${NAV.map((n) => html`<a class="tab" href="${n.href}"${current(n.key)}>${icon(n.icon, 22)}<span>${n.label}</span>${n.key === "resumen" ? unassigned : owes(n)}</a>`)}
  </nav>
</div>`);
}

const STATUS = {
  paid: html`<span class="pill ok"><i></i>Pagado</span>`,
  pending: html`<span class="pill warn"><i></i>Pendiente</span>`,
};

/** A proof of payment as the treasurer sees it: the photo inline, a PDF as a link. */
const proofView = (p) => p.mime === "application/pdf"
  ? html`<a class="btn ghost small" href="/panel/comprobantes/${p.id}/archivo">Descargar el PDF</a>`
  : html`<a href="/panel/comprobantes/${p.id}/archivo" target="_blank" rel="noopener"><img class="proof-img" src="/panel/comprobantes/${p.id}/archivo" alt="Comprobante de la casa ${p.houseCode}" loading="lazy"></a>`;

const houseOptions = (houses) => houses.map((h) => html`<option value="${h.id}">Casa ${h.code} · ${h.residentName}</option>`);
const payMethod = paymentMedium;

/** A WhatsApp link (no phone number: the treasurer picks the group) with the reminder already written. */
function reminderLink({ tenant, dues, period }) {
  const owing = dues.filter((d) => d.status === "pending");
  if (owing.length === 0) return null;
  const text = [
    `Hola vecinos, les recordamos la cuota de vigilancia de ${periodLabel(period)} (${peso(owing[0].amountCents)}).`,
    `Casas pendientes: ${owing.map((d) => d.houseCode).join(", ")}.`,
    tenant.payKey ? `Pueden pagar por Bre-B a la llave ${tenant.payKey}${tenant.payHolder ? ` (titular: ${tenant.payHolder})` : ""}.` : "",
    "¡Gracias!",
  ].filter(Boolean).join(" ");
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

const FILTERS = [
  { key: "", label: "Todas", test: () => true },
  { key: "pagadas", label: "Pagadas", test: (d) => d.status === "paid" },
  { key: "pendientes", label: "Pendientes", test: (d) => d.status === "pending" },
];

// ---- pieces shared by the treasurer pages that talk about who owes what ----

/** A WhatsApp link: straight to the resident when we have their phone, otherwise WhatsApp asks who to send it to. */
const waLink = (phone, text) => {
  const to = whatsappNumber(phone);
  return `https://wa.me/${to ? `${to}` : ""}?text=${encodeURIComponent(text)}`;
};

/** The personal reminder for one house: its months, its total and how to pay. */
function personalReminder(tenant, group) {
  const first = group.house.residentName.trim().split(/\s+/)[0];
  const names = group.months.map((m) => monthName(m).toLowerCase());
  const when = names.length === 1 ? `de ${names[0]}` : `de ${names.slice(0, -1).join(", ")} y ${names.at(-1)}`;
  return [
    `Hola ${first}, te recordamos la cuota de vigilancia ${when}: ${peso(group.totalCents)}.`,
    tenant.payKey ? `Puedes pagar por Bre-B a la llave ${tenant.payKey}${tenant.payHolder ? ` (titular: ${tenant.payHolder})` : ""}.` : "",
    "Cuando pagues, avísame para registrarlo. ¡Gracias!",
  ].filter(Boolean).join(" ");
}

const PILLS = {
  late: html`<span class="pill bad"><i></i>Atrasada</span>`,
  debt: (months) => html`<span class="pill bad"><i></i>Debe ${months} meses</span>`,
  ok: html`<span class="pill ok"><i></i>Al día</span>`,
};

/** "oct", "nov"… with the year only when it isn't this year: the months a house owes, as small chips. */
const monthChips = (group, period) => group.months.map((m) => html`<span class="mchip${group.lateMonths.includes(m) ? " bad" : ""}">${monthShort(m)}${m.slice(0, 4) === period.slice(0, 4) ? "" : ` ${m.slice(2, 4)}`}</span>`);

/** The state of a house in one pill: up to date, owes this month only, or owes earlier months. */
function houseStatus(group, period) {
  if (!group) return PILLS.ok;
  if (group.overdueCount > 0) return PILLS.debt(group.months.length);
  return STATUS.pending;
}

/** One house that owes: who, which months, how much, and the buttons to act (record the payment, remind). */
function debtRow(group, { tenant, period }) {
  const { house } = group;
  const late = group.overdueCount > 0;
  return html`<li class="debt" data-search="${house.code} ${house.residentName}">
    <span class="tile ${late ? "bad" : "warn"}">${house.code}</span>
    <div class="debt-main">
      <b>${house.residentName}</b>
      <span class="months" aria-label="Meses que debe">${monthChips(group, period)}</span>
    </div>
    <div class="debt-total"><b>${peso(group.totalCents)}</b><small class="muted">${group.dues.length} cuota${group.dues.length === 1 ? "" : "s"}</small></div>
    <div class="debt-actions">
      <a class="btn small" href="/panel/pagos/nuevo?casa=${house.id}">Registrar pago</a>
      <a class="btn ghost small" href="${waLink(house.phone, personalReminder(tenant, group))}" target="_blank" rel="noopener noreferrer">WhatsApp</a>
    </div>
  </li>`;
}

const panelHref = ({ mes, f, current }) => {
  const qs = new URLSearchParams();
  if (mes && mes !== current) qs.set("mes", mes);
  if (f) qs.set("f", f);
  return qs.size ? `/panel?${qs}` : "/panel";
};

export function panelPage(args) {
  const { tenant, user, csrf, flash, summary, dues, unassigned, proofs = [], houses, recent = [], filter = "", current, prevPeriod, nextPeriod, debts, addable = [] } = args;
  const { groups, totals } = debts;
  const byHouse = new Map(groups.map((g) => [g.house.id, g]));
  const selected = summary.period;
  const pct = summary.expectedCents ? Math.round((summary.collectedCents / summary.expectedCents) * 100) : 0;
  const owingCents = summary.expectedCents - summary.collectedCents;
  const shown = dues.filter((FILTERS.find((f) => f.key === filter) ?? FILTERS[0]).test);
  const reminder = reminderLink({ tenant, dues, period: selected });

  const essentials = [
    { done: houses.length > 0, title: "Agrega las casas", text: "Pega la lista desde Excel y Cuotia crea cada casa y su enlace.", href: "/panel/casas/importar", cta: "Importar casas" },
    { done: Boolean(tenant.payKey), title: "Escribe la llave Bre-B", text: "La ven los vecinos cuando van a pagar.", href: "/panel/ajustes", cta: "Ir a Ajustes" },
    { done: recent.length > 0, title: "Registra el primer pago", text: "A mano, o déjalo para cuando conectes pagoradar.", href: "/panel/pagos/nuevo", cta: "Registrar pago" },
  ];
  const showSteps = essentials.some((s) => !s.done);

  const rowPill = (d) => {
    if (d.status === "paid") return STATUS.paid;
    const g = byHouse.get(d.houseId);
    if (g?.dues.find((x) => x.id === d.id)?.late) return PILLS.late;
    return g?.overdueCount ? PILLS.debt(g.months.length) : STATUS.pending;
  };

  return panelLayout("Resumen", { ...args, active: "resumen" }, html`
  <header class="head">
    <div class="head-text">
      <h1>Hola, ${user.name}</h1>
      <span class="muted">Así va el recaudo de vigilancia.</span>
    </div>
    <div class="head-actions">
      <nav class="monthnav" aria-label="Elegir mes">
        ${prevPeriod ? html`<a class="mn-btn" href="${panelHref({ mes: prevPeriod, f: filter, current })}" aria-label="Mes anterior: ${periodLabel(prevPeriod)}">${icon("back", 18, 2.4)}</a>` : html`<span class="mn-btn off" aria-hidden="true">${icon("back", 18, 2.4)}</span>`}
        <span class="mn-label">${icon("calendar", 18)}${periodLabel(selected)}</span>
        ${nextPeriod ? html`<a class="mn-btn" href="${panelHref({ mes: nextPeriod, f: filter, current })}" aria-label="Mes siguiente: ${periodLabel(nextPeriod)}">${icon("next", 18, 2.4)}</a>` : html`<span class="mn-btn off" aria-hidden="true">${icon("next", 18, 2.4)}</span>`}
      </nav>
      <a class="btn" href="/panel/pagos/nuevo">+ Registrar pago</a>
    </div>
  </header>
  ${flashBox(flash)}
  ${selected !== current ? html`<p class="flash info" role="status">Estás viendo ${periodLabel(selected)}. <a href="/panel">Volver a este mes</a></p>` : ""}

  ${showSteps
    ? html`<section class="card steps-card" aria-label="Primeros pasos">
        <h2>Primeros pasos</h2>
        <ol class="checklist">${essentials.map((s) => html`<li class="${s.done ? "done" : ""}">
          <span class="dot ${s.done ? "ok" : "warn"}">${s.done ? icon("check", 16, 3) : ""}</span>
          <span class="step-text"><b>${s.title}</b><small class="muted">${s.text}</small></span>
          ${s.done ? "" : html`<a class="btn small" href="${s.href}">${s.cta}</a>`}
        </li>`)}</ol>
      </section>`
    : ""}

  <section class="top" aria-label="Resumen del mes">
    <div class="top-main">
    <div class="hero">
      <div class="row wrap">
        <span class="eyebrow">Recaudado en ${periodLabel(selected).split(" ")[0]}</span>
        ${summary.weekCents > 0 ? html`<span class="chip-lime">+ ${peso(summary.weekCents)} esta semana</span>` : ""}
      </div>
      <span class="hero-number">${peso(summary.collectedCents)}</span>
      <span class="hero-sub">de ${peso(summary.expectedCents)} esperados · ${pct} %</span>
      <progress class="bar" max="100" value="${pct}" aria-label="Porcentaje recaudado">${pct} %</progress>
      <div class="hero-stats">
        <div><b>${summary.paidCount}</b><span>casas al día</span></div>
        <div><b>${summary.pendingCount}</b><span>casas pendientes</span></div>
      </div>
    </div>

    <div class="stat info-card">
        <span class="eyebrow">Por asignar</span>
        <span class="stat-number">${summary.unassignedCount} pago${summary.unassignedCount === 1 ? "" : "s"}</span>
        ${summary.unassignedCount
          ? html`<span class="small">${peso(summary.unassignedCents)} entraron sin casa asociada</span><a class="stat-link" href="#por-asignar">Asignar ahora →</a>`
          : html`<span class="small">Todo lo que entró ya tiene casa.</span>`}
      </div>
    </div>

    <div class="stats">
      <div class="card stat">
        <span class="eyebrow dim">Faltan por pagar · ${periodLabel(selected).split(" ")[0]}</span>
        <span class="stat-number">${peso(owingCents)}</span>
        <span class="muted small">${summary.pendingCount} casa${summary.pendingCount === 1 ? "" : "s"}</span>
        ${summary.pendingCount
          ? html`<a class="btn" href="/panel/cobros">Ver quién debe</a>${reminder ? html`<a class="btn ghost" href="${reminder}" target="_blank" rel="noopener noreferrer">Recordar a todos por WhatsApp</a>` : ""}`
          : html`<span class="small">¡Todas las casas están al día!</span>`}
      </div>
      ${totals.overdueDues > 0
        ? html`<a class="stat late-card" href="/panel/cobros?f=atrasadas">
            <span class="eyebrow">Atrasadas</span>
            <span class="stat-number">${peso(totals.overdueCents)}</span>
            <span class="small">${totals.overdueHouses} casa${totals.overdueHouses === 1 ? " tiene" : "s tienen"} cuotas vencidas</span>
            <span class="stat-link">Ver las atrasadas →</span>
          </a>`
        : ""}
    </div>
  </section>

  ${proofs.length
    ? html`<section class="card" id="comprobantes">
        <h2>Comprobantes por revisar <span class="count">${proofs.length}</span></h2>
        <p class="muted small">Los residentes los suben desde su enlace. Revisa que el valor y el banco coincidan y registra el pago: la cuota queda pagada con el comprobante guardado.</p>
        <ul class="list stack">${proofs.map((pf) => {
          const g = byHouse.get(pf.houseId);
          return html`<li class="proof">
            <div class="row"><span><b>Casa ${pf.houseCode} · ${pf.residentName}</b><small class="muted">${shortDateTime(pf.createdAt)}${pf.note ? ` · “${pf.note}”` : ""}</small></span>${g ? html`<b>Debe ${peso(g.totalCents)}</b>` : html`<span class="pill ok"><i></i>Al día</span>`}</div>
            ${proofView(pf)}
            <div class="actions">
              ${g ? html`<a class="btn small" href="/panel/pagos/nuevo?casa=${pf.houseId}&amp;comprobante=${pf.id}&amp;todas=1">Registrar pago</a>` : html`<span class="muted small">Esta casa no debe nada: no hay cuota que pagar.</span>`}
              <details class="undo"><summary>Rechazar</summary>
                <p class="muted small">El comprobante no se borra, pero sale de esta lista y el residente verá que no se pudo confirmar.</p>
                <form method="post" action="/panel/comprobantes/${pf.id}/rechazar">${csrfField(csrf)}<button class="btn ghost small" type="submit">Sí, rechazar</button></form>
              </details>
            </div>
          </li>`;
        })}</ul>
      </section>`
    : ""}

  ${unassigned.length
    ? html`<section class="card" id="por-asignar">
        <h2>Por asignar <span class="count">${unassigned.length}</span></h2>
        <p class="muted small">Estos pagos entraron a la cuenta pero el nombre no coincide con ninguna casa. Asígnalos una vez y Cuotia recordará el nombre.</p>
        <ul class="list stack">${unassigned.map((p) => html`<li>
          <div class="row"><span><b>${p.payerName || "Sin nombre"}</b><small class="muted">${bankLabel(p.bank)} · ${shortDate(p.paidAt)}</small></span><b>${peso(p.amountCents)}</b></div>
          <form class="assign" method="post" action="/panel/pagos/${p.id}/asignar">
            ${csrfField(csrf)}
            <div class="combo">
              <input type="search" class="combo-search" hidden data-select-filter="#casa-${p.id}" placeholder="Buscar casa o nombre…" aria-label="Buscar la casa de ${p.payerName}" autocomplete="off">
              <select id="casa-${p.id}" name="house" required aria-label="Casa de ${p.payerName}"><option value="">Elegir casa…</option>${houseOptions(houses)}</select>
            </div>
            <label class="check"><input type="checkbox" name="remember" value="1" checked> Recordar nombre</label>
            <button class="btn small" type="submit">Asignar</button>
          </form>
        </li>`)}</ul>
      </section>`
    : ""}

  <section class="cols">
    <div class="card table-card">
      <div class="row wrap">
        <h2>Casas · ${periodLabel(selected).split(" ")[0]}</h2>
        <div class="chips" role="group" aria-label="Filtrar casas">
          ${FILTERS.map((f) => html`<a class="chip-filter" href="${panelHref({ mes: selected, f: f.key, current })}"${f.key === filter ? raw(' aria-current="true"') : ""}>${f.label} ${dues.filter(f.test).length}</a>`)}
        </div>
      </div>
      ${dues.length === 0
        ? html`<p class="muted">Aún no hay cuotas para ${periodLabel(selected)}.${selected === current ? "" : " Si en ese mes ya se cobraba, créalas y luego registra los pagos con su fecha."}</p>
          <form method="post" action="/panel/cuotas/generar">${csrfField(csrf)}<input type="hidden" name="mes" value="${selected}"><button class="btn" type="submit">Generar cuotas de ${periodLabel(selected)}</button></form>`
        : html`${selected === current && addable.length && dues.length
          ? html`<details class="undo addmonth-all">
              <summary>¿Falta un mes anterior (por ejemplo octubre)?</summary>
              <p class="muted small">Crea la cuota de ese mes para las ${houses.length} casas, al valor de hoy. Las que no la hayan pagado quedan como <b>atrasadas</b> en Por cobrar, y ahí registras los pagos con su fecha.</p>
              <form class="addmonths" method="post" action="/panel/cuotas/generar">
                ${csrfField(csrf)}
                <span class="addmonths-buttons">${addable.map((m) => html`<button class="btn ghost small" type="submit" name="mes" value="${m}">+ ${monthName(m)}${m.slice(0, 4) === current.slice(0, 4) ? "" : ` ${m.slice(0, 4)}`}</button>`)}</span>
              </form>
            </details>`
          : ""}<div class="table-wrap"><table>
        <thead><tr><th>Casa</th><th>Residente</th><th>Estado</th><th>Pagó el</th><th class="num">Monto</th><th><span class="sr">Acción</span></th></tr></thead>
        <tbody>${shown.map((d) => html`<tr>
          <td><a class="rowlink" href="/panel/casas/${d.houseId}"><b>${d.houseCode}</b></a></td>
          <td>${d.residentName}</td>
          <td>${rowPill(d)}</td>
          <td class="muted">${d.paidAt ? shortDate(d.paidAt) : "—"}</td>
          <td class="num"><b>${peso(d.amountCents)}</b></td>
          <td class="act">${d.status === "pending" ? html`<a class="btn ghost small" href="/panel/pagos/nuevo?casa=${d.houseId}&amp;cuota=${d.id}">Registrar pago</a>` : ""}</td>
        </tr>`)}</tbody>
      </table></div>`}
    </div>

    <div class="col-side">
      ${groups.length
        ? html`<div class="card">
            <div class="row"><h2>Para cobrar primero</h2><a class="small" href="/panel/cobros">Ver todas →</a></div>
            <ul class="list stack compact">${groups.slice(0, 5).map((g) => debtRow(g, { tenant, period: current }))}</ul>
          </div>`
        : ""}
      <div class="card">
        <div class="row"><h2>Últimos pagos</h2><a class="small" href="/panel/pagos">Ver todos →</a></div>
        ${recent.length
          ? html`<ul class="recent">${recent.map((p) => html`<li>
              <span class="tile ${p.status === "assigned" ? "ok" : "info"}">${p.houseCode ?? "?"}</span>
              <span class="who"><b>${p.manual ? p.residentName : p.payerName || "Sin nombre"}</b><small class="muted">${payMethod(p)} · ${shortDateTime(p.paidAt)}</small></span>
              <b>+${peso(p.amountCents)}</b>
            </li>`)}</ul>`
          : html`<p class="muted small">Cuando llegue o registres el primer pago aparecerá aquí.</p>`}
      </div>
    </div>
  </section>`);
}

/** Who owes, across months: the page a treasurer opens to chase payments. */
export function cobrosPage(args) {
  const { tenant, flash, groups, shown, totals, filter, q, current } = args;
  const FILTER_LINKS = [
    { key: "", label: "Todas", count: groups.length },
    { key: "atrasadas", label: "Atrasadas", count: groups.filter((g) => g.overdueCount > 0).length },
    { key: "mes", label: "Solo este mes", count: groups.filter((g) => g.overdueCount === 0).length },
  ];
  const href = (f) => `/panel/cobros${f || q ? `?${new URLSearchParams({ ...(f ? { f } : {}), ...(q ? { q } : {}) })}` : ""}`;
  const everyone = groups.length
    ? `https://wa.me/?text=${encodeURIComponent(`Hola vecinos, les recordamos la cuota de vigilancia pendiente. Casas: ${groups.map((g) => `${g.house.code} (${g.months.map(monthShort).join(", ")})`).join("; ")}.${tenant.payKey ? ` Pueden pagar por Bre-B a la llave ${tenant.payKey}${tenant.payHolder ? ` (titular: ${tenant.payHolder})` : ""}.` : ""} ¡Gracias!`)}`
    : null;
  return panelLayout("Por cobrar", { ...args, active: "cobros" }, html`
  <header class="head">
    <div class="head-text"><h1>Por cobrar</h1><span class="muted">Quién debe, cuánto y desde cuándo.</span></div>
    <div class="head-actions"><a class="btn" href="/panel/pagos/nuevo">+ Registrar pago</a></div>
  </header>
  ${flashBox(flash)}

  <section class="top" aria-label="Lo que se debe">
    <div class="card stat grow">
      <span class="eyebrow dim">Total por cobrar</span>
      <span class="stat-number big">${peso(totals.totalCents)}</span>
      <span class="muted small">${totals.houses} casa${totals.houses === 1 ? "" : "s"} con cuotas pendientes</span>
      ${everyone ? html`<a class="btn ghost" href="${everyone}" target="_blank" rel="noopener noreferrer">Recordar a todos por WhatsApp</a>` : ""}
    </div>
    <div class="stat late-card grow${totals.overdueDues ? "" : " calm"}">
      <span class="eyebrow">Atrasadas</span>
      <span class="stat-number big">${peso(totals.overdueCents)}</span>
      <span class="small">${totals.overdueHouses ? `${totals.overdueHouses} casa${totals.overdueHouses === 1 ? " tiene" : "s tienen"} cuotas vencidas` : "Nadie tiene cuotas vencidas."}</span>
    </div>
  </section>

  <section class="card">
    <div class="row wrap">
      <div class="chips" role="group" aria-label="Filtrar">
        ${FILTER_LINKS.map((f) => html`<a class="chip-filter" href="${href(f.key)}"${f.key === filter ? raw(' aria-current="true"') : ""}>${f.label} ${f.count}</a>`)}
      </div>
      <form class="searchbar" method="get" action="/panel/cobros" role="search">
        ${filter ? html`<input type="hidden" name="f" value="${filter}">` : ""}
        <input type="search" name="q" value="${q ?? ""}" maxlength="60" placeholder="Buscar casa o nombre" aria-label="Buscar casa o nombre" autocomplete="off" data-live-filter="#lista-cobros" data-live-empty="#sin-cobros">
        <button class="btn ghost small" type="submit" data-search-button>Buscar</button>
      </form>
    </div>
    ${shown.length
      ? html`<ul class="list stack debts" id="lista-cobros">${shown.map((g) => debtRow(g, { tenant, period: current }))}</ul><p class="muted" id="sin-cobros" hidden>Ninguna casa coincide.</p>`
      : groups.length
        ? html`<p class="muted">Ninguna casa coincide con ese filtro.</p>`
        : html`<div class="empty"><span class="okring small">${icon("check", 28, 3)}</span><h2>¡Todo al día!</h2><p class="muted">No hay cuotas pendientes. Cuando llegue un nuevo mes, aparecerán aquí las casas que no hayan pagado.</p></div>`}
  </section>`);
}

export function casasPage(args) {
  const { tenant, csrf, flash, houses, inactive = [], debts, current, q = "" } = args;
  const byHouse = new Map(debts.groups.map((g) => [g.house.id, g]));
  const shown = houses.filter((h) => matchesSearch(q, `${h.code} ${h.residentName}`));
  return panelLayout("Casas", { ...args, active: "casas" }, html`
  <div class="heading"><h1>Casas</h1><span class="muted">${tenant.name} · ${houses.length} casa${houses.length === 1 ? "" : "s"}${debts.groups.length ? ` · ${debts.groups.length} con deuda` : ""}</span></div>
  ${flashBox(flash)}

  <details class="card add-house"${houses.length === 0 || flash?.kind === "err" ? raw(" open") : ""}>
    <summary><span class="btn small">+ Agregar casa</span><a class="btn ghost small" href="/panel/casas/importar">Importar varias</a></summary>
    <form class="grid-form" method="post" action="/panel/casas">
      ${csrfField(csrf)}
      <label>Código<input type="text" name="code" maxlength="12" required placeholder="14"></label>
      <label>Residente<input type="text" name="residente" maxlength="80" required placeholder="Sandra Duque"></label>
      <label>Celular (opcional)<input type="tel" name="telefono" maxlength="20" inputmode="tel" placeholder="3001234567"></label>
      <button class="btn" type="submit">Agregar y ver enlace</button>
    </form>
  </details>

  <section class="card">
    <div class="row wrap"><h2>Listado</h2>
      <form class="searchbar" method="get" action="/panel/casas" role="search">
        <input type="search" name="q" value="${q}" maxlength="60" placeholder="Buscar casa o nombre" aria-label="Buscar casa o nombre" autocomplete="off" data-live-filter="#lista-casas" data-live-empty="#sin-casas">
        <button class="btn ghost small" type="submit" data-search-button>Buscar</button>
      </form>
    </div>
    ${houses.length === 0
      ? html`<div class="empty"><h2>Aún no hay casas</h2><p class="muted">Pega la lista desde Excel y Cuotia crea cada casa con su enlace personal.</p><a class="btn" href="/panel/casas/importar">Importar casas</a></div>`
      : shown.length === 0
        ? html`<p class="muted">Ninguna casa coincide con “${q}”.</p>`
        : html`<ul class="list" id="lista-casas">${shown.map((h) => {
          const g = byHouse.get(h.id);
          return html`<li class="house-row" data-search="${h.code} ${h.residentName}">
            <span class="tile ${g ? (g.overdueCount ? "bad" : "warn") : "ok"}">${h.code}</span>
            <span class="house-main"><b>${h.residentName}</b><small class="muted">${h.phone ?? "Sin celular"}</small></span>
            <span class="house-state">${houseStatus(g, current)}${g ? html`<small class="muted">${peso(g.totalCents)}</small>` : ""}</span>
            <span class="actions">
              ${g ? html`<a class="btn small" href="/panel/pagos/nuevo?casa=${h.id}">Registrar pago</a>` : ""}
              <a class="btn ghost small" href="/panel/casas/${h.id}">Editar</a>
              <form method="post" action="/panel/casas/${h.id}/enlace">${csrfField(csrf)}<button class="btn ghost small" type="submit">Enlace</button></form>
            </span>
          </li>`;
        })}</ul><p class="muted" id="sin-casas" hidden>Ninguna casa coincide.</p>`}
  </section>

  ${inactive.length
    ? html`<section class="card">
        <h2>Casas desactivadas</h2>
        <p class="muted small">Ya no reciben cuotas ni tienen enlace, pero su historial se conserva.</p>
        <ul class="list">${inactive.map((h) => html`<li>
          <span><b>Casa ${h.code}</b><small class="muted">${h.residentName}</small></span>
          <span class="actions">
            <a class="btn ghost small" href="/panel/casas/${h.id}">Ver</a>
            <form method="post" action="/panel/casas/${h.id}/reactivar">${csrfField(csrf)}<button class="btn ghost small" type="submit">Reactivar</button></form>
          </span>
        </li>`)}</ul>
      </section>`
    : ""}`);
}

/** Register a payment by hand. Step 1: who owes (a list you tap). Step 2: which months, how it was paid, when. */
export function pagoManualPage(args) {
  const { csrf, flash, debts, current, selected, proof = null, missing = [], preselect = [], all = false, today, q = "" } = args;
  const monthButton = (m) => `+ ${monthName(m)}${m.slice(0, 4) === current.slice(0, 4) ? "" : ` ${m.slice(0, 4)}`}`;
  const methods = Object.entries(MANUAL_LABELS);
  const list = debts.groups.filter((g) => matchesSearch(q, `${g.house.code} ${g.house.residentName}`));
  const checked = (d, i) => (all || preselect.includes(d.id) || (preselect.length === 0 && i === 0));
  return panelLayout("Registrar pago", { ...args, active: "pagos" }, html`
  <div class="heading"><h1>Registrar pago</h1><span class="muted">Efectivo, transferencia u otro</span></div>
  <p><a href="${selected ? "/panel/pagos/nuevo" : "/panel/pagos"}">← ${selected ? "Elegir otra casa" : "Volver a pagos"}</a></p>
  ${flashBox(flash)}

  ${selected
    ? html`<section class="card">
        <div class="row wrap">
          <h2>Casa ${selected.house.code} <span class="muted">· ${selected.house.residentName}</span></h2>
          <span class="owes"><small class="muted">Debe</small> <b>${peso(selected.totalCents)}</b></span>
        </div>
        ${missing.length
          ? html`<form class="addmonths" method="post" action="/panel/casas/${selected.house.id}/mes">
              ${csrfField(csrf)}
              <span class="muted small">¿Pagó también un mes que no aparece? Agrégalo:</span>
              <span class="addmonths-buttons">${missing.map((m) => html`<button class="btn ghost small" type="submit" name="mes" value="${m}">${monthButton(m)}</button>`)}</span>
            </form>`
          : ""}
        <form class="stack-form" method="post" action="/panel/pagos/nuevo">
          ${csrfField(csrf)}
          <input type="hidden" name="casa" value="${selected.house.id}">
          ${proof && proof.houseId === selected.house.id
            ? html`<input type="hidden" name="comprobante" value="${proof.id}"><div class="proof-box"><span class="eyebrow dim">Comprobante que subió ${proof.residentName}</span>${proofView(proof)}${proof.note ? html`<p class="muted small">“${proof.note}”</p>` : ""}</div>`
            : ""}
          <fieldset>
            <legend>¿Qué cuotas cubre?</legend>
            ${selected.dues.map((d, i) => html`<label class="check due-pick"><input type="checkbox" name="cuota" value="${d.id}"${checked(d, i) ? raw(" checked") : ""}><span>${monthName(d.period)} ${d.period.slice(0, 4)} · ${d.conceptName}${d.late ? html` <span class="pill bad small"><i></i>${d.period < current ? "Atrasada" : "Vencida"}</span>` : ""}</span><b>${peso(d.amountCents)}</b></label>`)}
            ${selected.dues.length > 1 ? html`<a class="small" href="/panel/pagos/nuevo?casa=${selected.house.id}&amp;todas=1">Marcar todas (${peso(selected.totalCents)})</a>` : ""}
            <small class="muted">Se registra la suma de las cuotas marcadas, exacta. Si pagó otro valor, anótalo en la nota y avísale al vecino.</small>
          </fieldset>
          <div class="grid-form">
            <label>¿Cómo pagó?
              <select name="medio">${methods.map(([key, label]) => html`<option value="${key}">${label}</option>`)}</select>
            </label>
            <label>Banco o billetera <span class="muted small">(opcional)</span><input type="text" name="banco" maxlength="40" placeholder="Nequi, Bancolombia…"></label>
            <label>Fecha en que pagó<input type="date" name="fecha" value="${today}" max="${today}" required></label>
            <label>Nota <span class="muted small">(opcional)</span><input type="text" name="nota" maxlength="120" placeholder="Ej. lo trajo la esposa"></label>
          </div>
          <button class="btn" type="submit">Registrar pago</button>
        </form>
      </section>`
    : html`<section class="card">
        <div class="row wrap">
          <h2>¿Quién pagó?</h2>
          <form class="searchbar big" method="get" action="/panel/pagos/nuevo" role="search">
            <input type="search" name="q" value="${q}" maxlength="60" placeholder="Escribe la casa o el nombre…" aria-label="Buscar casa o nombre" autocomplete="off" autofocus data-live-filter="#lista-pick" data-live-empty="#sin-pick">
            <button class="btn small" type="submit" data-search-button>Buscar</button>
          </form>
        </div>
        ${debts.groups.length === 0
          ? html`<div class="empty"><span class="okring small">${icon("check", 28, 3)}</span><h2>¡Todo al día!</h2><p class="muted">Ninguna casa tiene cuotas pendientes: no hay nada por registrar.</p></div>`
          : list.length === 0
            ? html`<p class="muted">Ninguna casa con deuda coincide con “${q}”.</p>`
            : html`<p class="muted small">Escribe para buscar o toca la casa que pagó. Solo aparecen las que deben algo. <span class="kbd-hint">Con una sola coincidencia, Enter la abre.</span></p>
              <ul class="list stack pick" id="lista-pick">${list.map((g) => html`<li class="debt" data-search="${g.house.code} ${g.house.residentName}">
                <span class="tile ${g.overdueCount ? "bad" : "warn"}">${g.house.code}</span>
                <div class="debt-main"><b>${g.house.residentName}</b><span class="months">${monthChips(g, current)}</span></div>
                <div class="debt-total"><b>${peso(g.totalCents)}</b><small class="muted">${g.dues.length} cuota${g.dues.length === 1 ? "" : "s"}</small></div>
                <div class="debt-actions"><a class="btn small" href="/panel/pagos/nuevo?casa=${g.house.id}" data-pick>Elegir</a></div>
              </li>`)}</ul><p class="muted" id="sin-pick" hidden>Ninguna casa con deuda coincide.</p>`}
      </section>`}`);
}


export function ajustesPage(args) {
  const { tenant, csrf, flash, webhookUrl, team = [], invites = [], meId } = args;
  return panelLayout("Ajustes", { ...args, active: "ajustes" }, html`
  <div class="heading"><h1>Ajustes</h1><span class="muted">${tenant.name}</span></div>
  ${flashBox(flash)}

  <section class="card">
    <div class="row wrap">
      <h2>Conexión con pagoradar</h2>
      ${tenant.pagoradarConfigured
        ? (tenant.pagoradarLastAt
          ? html`<span class="pill ok"><i></i>Conectado · último aviso ${shortDate(tenant.pagoradarLastAt)}</span>`
          : html`<span class="pill warn"><i></i>Secreto guardado · aún sin avisos</span>`)
        : html`<span class="pill warn"><i></i>Sin configurar</span>`}
    </div>
    <p class="muted small"><b>Es opcional.</b> Sin pagoradar puedes registrar los pagos a mano desde <a href="/panel/pagos/nuevo">Pagos → Registrar pago</a>.</p>
    <p class="muted small">Cada conjunto tiene su propia conexión. En el panel de pagoradar crea una app para este conjunto con esta URL de webhook:</p>
    <p class="key url" translate="no">${webhookUrl}</p>
    <p class="muted small">Luego copia el <b>secreto del webhook</b> de esa app y pégalo aquí. Se guarda cifrado y no se vuelve a mostrar.</p>
    <form class="grid-form" method="post" action="/panel/ajustes/pagoradar" autocomplete="off">
      ${csrfField(csrf)}
      <label>Secreto del webhook<input type="password" name="secret" minlength="8" maxlength="200" required autocomplete="off" placeholder="${tenant.pagoradarConfigured ? "•••••••• (pega uno nuevo para cambiarlo)" : "Pega el secreto de pagoradar"}"></label>
      <button class="btn" type="submit">Guardar secreto</button>
    </form>
  </section>

  <section class="card">
    <h2>Fechas de pago</h2>
    <p class="muted small">Del 1 al 28. Los residentes ven “Paga del 1 al 10”. Pasado el último día, la cuota del mes se marca como <b>vencida</b> en Por cobrar y en el Resumen. Aun así, los pagos se reciben y se asignan en cualquier día. Déjalos vacíos si no quieres fechas.</p>
    <form class="grid-form" method="post" action="/panel/ajustes/fechas">
      ${csrfField(csrf)}
      <label>Se empieza a pagar el día<input type="number" name="desde" min="1" max="28" inputmode="numeric" value="${tenant.openDay ?? ""}" placeholder="1"></label>
      <label>Último día para pagar<input type="number" name="hasta" min="1" max="28" inputmode="numeric" value="${tenant.dueDay ?? ""}" placeholder="10"></label>
      <button class="btn" type="submit">Guardar fechas</button>
    </form>
  </section>

  <section class="card">
    <h2>Cuenta para cobrar</h2>
    <p class="muted small">Es la llave Bre-B que ven los residentes cuando van a pagar. Debe ser la de la cuenta cuyos avisos recibe pagoradar.</p>
    <form class="grid-form" method="post" action="/panel/ajustes/cobro">
      ${csrfField(csrf)}
      <label>Llave Bre-B<input type="text" name="llave" maxlength="80" value="${tenant.payKey ?? ""}" placeholder="@mi.llave"></label>
      <label>Titular de la cuenta<input type="text" name="titular" maxlength="80" value="${tenant.payHolder ?? ""}" placeholder="Quien recibe el dinero"></label>
      <button class="btn" type="submit">Guardar</button>
    </form>
  </section>

  <section class="card" id="equipo">
    <h2>Equipo</h2>
    <p class="muted small">Quienes pueden entrar al panel de ${tenant.name}. Cada persona tiene su propia contraseña y su propio código de verificación. Todas pueden hacer lo mismo: invita solo a gente de confianza.</p>
    <ul class="list">${team.map((u) => html`<li class="member">
      <span><b>${u.name}${u.id === meId ? " (tú)" : ""}</b><small class="muted">${u.email}${u.totpEnabled ? "" : " · aún no activa su código"}</small></span>
      ${u.id === meId ? "" : html`<details class="undo"><summary>Quitar</summary>
        <p class="muted small">${u.name} ya no podrá entrar y se cerrarán sus sesiones. Lo que registró se conserva.</p>
        <form method="post" action="/panel/equipo/${u.id}/quitar">${csrfField(csrf)}<button class="btn ghost small" type="submit">Sí, quitar</button></form>
      </details>`}
    </li>`)}</ul>
    ${invites.length ? html`<h3>Invitaciones pendientes</h3><ul class="list">${invites.map((i) => html`<li class="member">
      <span><b>${i.name || i.email}</b><small class="muted">${i.email} · vence ${shortDate(i.expiresAt)}</small></span>
      <form method="post" action="/panel/equipo/invitaciones/${i.id}/cancelar">${csrfField(csrf)}<button class="btn ghost small" type="submit">Cancelar</button></form>
    </li>`)}</ul>` : ""}
    <form class="grid-form" method="post" action="/panel/equipo/invitar">
      ${csrfField(csrf)}
      <label>Nombre<input type="text" name="nombre" maxlength="80" placeholder="Pedro Gómez"></label>
      <label>Correo<input type="email" name="correo" maxlength="120" required placeholder="pedro@ejemplo.com"></label>
      <button class="btn" type="submit">Invitar</button>
    </form>
  </section>

  <section class="card">
    <h2>Tu contraseña</h2>
    <form class="grid-form" method="post" action="/panel/ajustes/clave" autocomplete="off">
      ${csrfField(csrf)}
      <label>Contraseña actual<input type="password" name="actual" required autocomplete="current-password"></label>
      <label>Contraseña nueva (mínimo 10 caracteres)<input type="password" name="nueva" minlength="10" maxlength="200" required autocomplete="new-password"></label>
      <label>Repite la nueva<input type="password" name="nueva2" minlength="10" maxlength="200" required autocomplete="new-password"></label>
      <button class="btn" type="submit">Cambiar contraseña</button>
    </form>
    <p class="muted small">Al cambiarla, tus sesiones en otros dispositivos se cierran. Si pierdes el celular del código de verificación, pídele al operador que lo restablezca.</p>
  </section>`);
}

export function importPage(args) {
  const { csrf } = args;
  return panelLayout("Importar casas", { ...args, active: "casas" }, html`
  <div class="heading"><h1>Importar casas</h1><span class="muted">Pega la lista y listo</span></div>
  <p><a href="/panel/casas">← Volver a casas</a></p>
  <section class="card">
    <p class="small">Una casa por línea: <b>código</b>, <b>nombre del residente</b> y, si lo tienes, <b>celular</b>. Puedes pegar directo desde Excel o Google Sheets, o separar con punto y coma.</p>
    <pre class="example" translate="no">01;Marta Rojas;3001234567
02;Julián Castaño;3109876543
03;Diana Pérez</pre>
    <form method="post" action="/panel/casas/importar">
      ${csrfField(csrf)}
      <label>Lista de casas<textarea name="casas" rows="12" required placeholder="Código;Nombre;Celular"></textarea></label>
      <p class="muted small">Hasta 300 casas por vez. Las que ya existan se saltan. Cada casa recibe un enlace personal, que verás en la siguiente pantalla (solo se muestra una vez).</p>
      <button class="btn" type="submit">Importar casas</button>
    </form>
  </section>`);
}

export function importResultPage(args) {
  const { created, problems } = args;
  return panelLayout("Casas importadas", { ...args, active: "casas" }, html`
  <div class="heading"><h1>${created.length} casa${created.length === 1 ? "" : "s"} importada${created.length === 1 ? "" : "s"}</h1><a class="btn ghost small" href="/panel/casas">Ir a casas</a></div>
  ${problems.length
    ? html`<section class="card">
        <h2>Revisa estas líneas <span class="count">${problems.length}</span></h2>
        <ul class="list">${problems.map((p) => html`<li><span><b>Línea ${p.line}</b><small class="muted">${p.text}</small></span><span class="small">${p.reason}</span></li>`)}</ul>
      </section>`
    : ""}
  ${created.length
    ? html`<section class="card">
        <h2>Enlaces personales</h2>
        <p class="muted small"><b>Solo se muestran ahora.</b> Envíale a cada residente el suyo; si lo pierdes, genera uno nuevo desde la casa. Ya quedaron creadas las cuotas de este mes.</p>
        <ul class="list stack">${created.map(({ house, url, whatsapp }, i) => html`<li>
          <div class="row"><span><b>Casa ${house.code}</b><small class="muted">${house.residentName}${house.phone ? ` · ${house.phone}` : ""}</small></span>
            <span class="actions">
              <button class="btn ghost small" type="button" data-copy="${url}" data-copy-target="#enlace-${i}">Copiar enlace</button>
              ${whatsapp ? html`<a class="btn ghost small" href="${whatsapp}" target="_blank" rel="noopener noreferrer">WhatsApp</a>` : ""}
            </span></div>
          <p class="key url" id="enlace-${i}" translate="no">${url}</p>
        </li>`)}</ul>
      </section>`
    : ""}`);
}

const PAY_STATUS = {
  assigned: html`<span class="pill ok"><i></i>Asignado</span>`,
  unassigned: html`<span class="pill info"><i></i>Por asignar</span>`,
};

/** The undo control: a <details> so a stray tap never undoes anything and no script is needed. */
const undoControl = (p, csrf) => html`<details class="undo">
  <summary>Deshacer</summary>
  <p class="muted small">${p.manual
    ? "Se anula este pago registrado a mano y las cuotas que cubría vuelven a pendiente."
    : "El pago vuelve a “Por asignar”, la cuota queda pendiente y Cuotia olvida el nombre que aprendió para esta casa."}</p>
  <form method="post" action="/panel/pagos/${p.id}/deshacer">${csrfField(csrf)}<button class="btn ghost small" type="submit">Sí, deshacer</button></form>
</details>`;

export function pagoItem(p, csrf) {
  return html`<li class="pay">
    <div class="row">
      <span>
        <b>${p.payerName || "Sin nombre"}</b>
        <small class="muted">${shortDateTime(p.paidAt)}${p.manual ? "" : ` · ${payMethod(p)}`}${p.note ? ` · ${p.note}` : ""}${p.houseCode ? ` · Casa ${p.houseCode}` : ""}${p.duePeriod ? ` · ${p.conceptName} ${periodLabel(p.duePeriod)}` : ""}</small>
      </span>
      <span class="amount"><b>${peso(p.amountCents)}</b>${PAY_STATUS[p.status]}</span>
    </div>
    ${p.proof ? html`<a class="small" href="/panel/comprobantes/${p.proof.id}/archivo" target="_blank" rel="noopener">Ver comprobante</a>` : ""}
    ${p.status === "assigned" ? undoControl(p, csrf) : html`<a class="small" href="/panel#por-asignar">Asignar a una casa →</a>`}
  </li>`;
}

export function pagosPage(args) {
  const { tenant, csrf, flash, result, filters, page, pages, period } = args;
  const link = (extra = {}) => {
    const qs = new URLSearchParams();
    const all = { ...filters, ...extra };
    for (const [k, v] of Object.entries(all)) if (v !== undefined && v !== null && v !== "" && !(k === "p" && Number(v) <= 1)) qs.set(k, String(v));
    const text = qs.toString();
    return text ? `?${text}` : "";
  };
  return panelLayout("Pagos", { ...args, active: "pagos" }, html`
  <div class="heading"><h1>Pagos</h1><span class="muted">${tenant.name}</span></div>
  ${flashBox(flash)}

  <section class="card">
    <form class="filters" method="get" action="/panel/pagos">
      <label>Mes
        <select name="mes">
          <option value="">Todos los meses</option>
          ${lastPeriods(period, 12).map((m) => html`<option value="${m}"${filters.mes === m ? raw(" selected") : ""}>${periodLabel(m)}</option>`)}
        </select>
      </label>
      <label>Estado
        <select name="estado">
          <option value="">Todos</option>
          <option value="assigned"${filters.estado === "assigned" ? raw(" selected") : ""}>Asignados</option>
          <option value="unassigned"${filters.estado === "unassigned" ? raw(" selected") : ""}>Por asignar</option>
        </select>
      </label>
      <label class="wide">Buscar<input type="text" name="q" value="${filters.q ?? ""}" maxlength="60" placeholder="Nombre, casa o residente"></label>
      <button class="btn wide" type="submit">Filtrar</button>
    </form>
    <div class="row wrap">
      <span class="muted small"><b>${result.total}</b> pago${result.total === 1 ? "" : "s"} · <b>${peso(result.totalCents)}</b></span>
      <a class="btn ghost small" href="/panel/pagos.csv${link({ p: undefined })}">Descargar para Excel (CSV)</a>
    </div>
  </section>

  <section class="card">
    ${result.rows.length === 0
      ? html`<p class="muted">No hay pagos con estos filtros.</p>`
      : html`<ul class="list stack">${result.rows.map((p) => pagoItem(p, csrf))}</ul>`}
    ${pages > 1
      ? html`<nav class="pager" aria-label="Páginas">
          ${page > 1 ? html`<a class="btn ghost small" href="/panel/pagos${link({ p: page - 1 })}">← Anterior</a>` : html`<span></span>`}
          <span class="muted small">Página ${page} de ${pages}</span>
          ${page < pages ? html`<a class="btn ghost small" href="/panel/pagos${link({ p: page + 1 })}">Siguiente →</a>` : html`<span></span>`}
        </nav>`
      : ""}
  </section>`);
}


export function casaPage(args) {
  const { tenant, csrf, flash, house, aliases, dues, payments } = args;
  return panelLayout(`Casa ${house.code}`, { ...args, active: "casas" }, html`
  <div class="heading">
    <h1>Casa ${house.code}</h1>
    <span class="muted">${tenant.name}${house.active ? "" : " · desactivada"}</span>
  </div>
  <p><a href="/panel/casas">← Volver a casas</a></p>
  ${flashBox(flash)}

  <section class="card">
    <h2>Datos</h2>
    <form class="grid-form" method="post" action="/panel/casas/${house.id}/editar">
      ${csrfField(csrf)}
      <label>Código<input type="text" name="code" maxlength="12" required value="${house.code}"></label>
      <label>Residente<input type="text" name="residente" maxlength="80" required value="${house.residentName}"></label>
      <label>Celular (opcional)<input type="tel" name="telefono" maxlength="20" inputmode="tel" value="${house.phone ?? ""}"></label>
      <button class="btn" type="submit">Guardar cambios</button>
    </form>
  </section>

  <section class="card">
    <h2>Nombres con los que paga</h2>
    <p class="muted small">Cuando llega un pago con alguno de estos nombres, Cuotia lo asigna a esta casa. Se agregan solos al asignar un pago a mano; aquí puedes agregar o quitar.</p>
    ${aliases.length
      ? html`<ul class="list">${aliases.map((a) => html`<li><b>${a.name}</b>
          <form method="post" action="/panel/casas/${house.id}/alias/${a.id}/quitar">${csrfField(csrf)}<button class="btn ghost small" type="submit">Quitar</button></form></li>`)}</ul>`
      : html`<p class="muted small">Aún ninguno: se usa el nombre del residente.</p>`}
    <form class="assign" method="post" action="/panel/casas/${house.id}/alias">
      ${csrfField(csrf)}
      <input type="text" name="name" maxlength="80" required placeholder="Nombre de quien paga" aria-label="Nombre con el que paga">
      <button class="btn small" type="submit">Agregar nombre</button>
    </form>
  </section>

  <section class="card">
    <h2>Cuotas</h2>
    ${dues.length
      ? html`<ul class="list">${dues.map((d) => html`<li><span><b>${d.conceptName}</b><small class="muted">${periodLabel(d.period)}${d.paidAt ? ` · pagada ${shortDate(d.paidAt)}` : ""}</small></span><span class="amount"><b>${peso(d.amountCents)}</b>${STATUS[d.status]}</span></li>`)}</ul>`
      : html`<p class="muted small">Todavía no tiene cuotas.</p>`}
  </section>

  <section class="card">
    <div class="row wrap"><h2>Pagos</h2><a class="small" href="/panel/pagos?q=${encodeURIComponent(house.code)}">Ver en el historial</a></div>
    ${payments.length
      ? html`<ul class="list stack">${payments.map((p) => pagoItem(p, csrf))}</ul>`
      : html`<p class="muted small">Aún no hay pagos asignados a esta casa.</p>`}
  </section>

  <section class="card">
    <h2>Acciones</h2>
    ${house.active
      ? html`<form method="post" action="/panel/casas/${house.id}/enlace">${csrfField(csrf)}<button class="btn ghost" type="submit">Generar enlace personal nuevo</button></form>
        <details class="undo">
          <summary>Desactivar casa</summary>
          <p class="muted small">Deja de recibir cuotas nuevas y su enlace personal deja de servir. Las cuotas que debía sin pagar ya no cuentan como pendientes. Todo su historial se conserva y la puedes reactivar.</p>
          <form method="post" action="/panel/casas/${house.id}/desactivar">${csrfField(csrf)}<button class="btn ghost small" type="submit">Sí, desactivar</button></form>
        </details>`
      : html`<form method="post" action="/panel/casas/${house.id}/reactivar">${csrfField(csrf)}<button class="btn" type="submit">Reactivar casa</button></form>`}
  </section>`);
}

/** Shown once after creating a house or rotating its link: only the token's hash is stored. */
export function linkPage(args) {
  const { house, url, whatsapp } = args;
  return panelLayout("Enlace personal", { ...args, active: "casas" }, html`
  <div class="heading"><h1>Casa ${house.code}</h1><span class="muted">${house.residentName}</span></div>
  <section class="card">
    <h2>Enlace personal</h2>
    <p class="small">Envíaselo al residente: ahí ve su cuota y cómo pagar. <b>Solo se muestra ahora</b>; si lo pierdes, genera uno nuevo (el anterior deja de servir).</p>
    <p class="key url" translate="no" id="enlace">${url}</p>
    <div class="actions">
      <button class="btn" type="button" data-copy="${url}" data-copy-target="#enlace">Copiar enlace</button>
      ${whatsapp ? html`<a class="btn ghost" href="${whatsapp}" rel="noopener noreferrer">Enviar por WhatsApp</a>` : ""}
      <a class="btn ghost" href="/panel/casas">Volver a casas</a>
    </div>
  </section>`);
}

/** Shown once to the treasurer after inviting: the link to send. */
export function inviteLinkPage(args) {
  const { url, email, name } = args;
  const text = `Hola${name ? ` ${name.split(/\s+/)[0]}` : ""}, te invito al panel de ${args.tenant.name} en Cuotia. Crea tu contraseña aquí (el enlace vence en 7 días): ${url}`;
  return panelLayout("Invitación", { ...args, active: "ajustes" }, html`
  <div class="heading"><h1>Invitación lista</h1><span class="muted">${email}</span></div>
  <section class="card">
    <p class="small">Envíale este enlace a ${name || email}. <b>Solo se muestra ahora</b>; si lo pierdes, vuelve a invitar al mismo correo y el anterior deja de servir. Sirve una sola vez y vence en 7 días.</p>
    <p class="key url" translate="no" id="enlace">${url}</p>
    <div class="actions">
      <button class="btn" type="button" data-copy="${url}" data-copy-target="#enlace">Copiar enlace</button>
      <a class="btn ghost" href="https://wa.me/?text=${encodeURIComponent(text)}" rel="noopener noreferrer">Enviar por WhatsApp</a>
      <a class="btn ghost" href="/panel/ajustes#equipo">Volver a Ajustes</a>
    </div>
  </section>`);
}

/** The invited person chooses their name and password. Their email is fixed by the invitation. */
export function inviteAcceptPage({ inv, token, error, name }) {
  return layout("Crear mi cuenta", html`
<main class="center">
  <form class="card setup" method="post" action="/invitacion/${token}">
    ${BRAND_MARK}
    <h1>Te invitaron a ${inv.tenant.name}</h1>
    <p class="muted">Crea tu contraseña. Después te pediremos activar el código de verificación en tu celular.</p>
    ${error ? html`<p class="alert" role="alert">${error}</p>` : ""}
    <label>Correo<input type="email" value="${inv.email}" readonly></label>
    <label>Tu nombre<input type="text" name="nombre" maxlength="80" required autocomplete="name" value="${name ?? inv.name ?? ""}"></label>
    <label>Contraseña (mínimo 10 caracteres)<input type="password" name="clave" minlength="10" maxlength="200" required autocomplete="new-password"></label>
    <label>Repite la contraseña<input type="password" name="clave2" minlength="10" maxlength="200" required autocomplete="new-password"></label>
    <button class="btn" type="submit">Crear mi cuenta</button>
  </form>
</main>`);
}

// ---------------------------------------------------------------------------------------------------------------
// Resident pages (reached by the personal link, no sign-in): home, how to pay, receipt.
// ---------------------------------------------------------------------------------------------------------------

const firstName = (full) => String(full ?? "").trim().split(/\s+/)[0] || "vecino";

/** "Paga del 1 al 10 de noviembre" (or just one end), for the resident; "" when the conjunto set no dates. */
export function paymentWindow(tenant, period) {
  const month = periodLabel(period).split(" ")[0];
  if (tenant.openDay && tenant.dueDay) return `Paga del ${tenant.openDay} al ${tenant.dueDay} de ${month}`;
  if (tenant.dueDay) return `Paga hasta el ${tenant.dueDay} de ${month}`;
  if (tenant.openDay) return `Se paga desde el ${tenant.openDay} de ${month}`;
  return "";
}

const PROOF_STATUS = {
  pending: html`<span class="pill warn"><i></i>En revisión</span>`,
  accepted: html`<span class="pill ok"><i></i>Confirmado</span>`,
  rejected: html`<span class="pill bad"><i></i>No se pudo confirmar</span>`,
};

/** Upload a photo or PDF of the payment. It has no auto-refresh on purpose: a refresh would clear the chosen file. */
export function residentProofPage({ tenant, house, dues, token, proofs = [], error = "", sent = false }) {
  const owed = dues.filter((d) => d.status === "pending").reduce((s, d) => s + d.amountCents, 0);
  return layout("Subir comprobante", html`
<main class="narrow res">
  <header class="backbar"><a href="/r/${token}" aria-label="Volver">${icon("back", 24, 2.2)}</a><h1>Subir comprobante</h1></header>
  <section class="card">
    ${sent ? html`<p class="flash ok" role="status">¡Listo! El tesorero revisará tu comprobante y registrará el pago.</p>` : ""}
    ${error ? html`<p class="flash err" role="alert">${error}</p>` : ""}
    <p class="muted">Casa ${house.code} · ${tenant.name}${owed ? html` · debes <b>${peso(owed)}</b>` : ""}</p>
    <form class="stack-form" method="post" action="/r/${token}/comprobante" enctype="multipart/form-data">
      <label>Foto o PDF del comprobante (máximo 5 MB)<input type="file" name="archivo" accept="image/jpeg,image/png,image/webp,application/pdf" required></label>
      <label>Nota para el tesorero (opcional)<input type="text" name="nota" maxlength="200" placeholder="Pagué desde la cuenta de mi esposo"></label>
      <button class="btn big" type="submit">Enviar comprobante</button>
    </form>
    <p class="muted small">Solo el tesorero de ${tenant.name} puede verlo. El pago queda registrado cuando él lo confirme.</p>
  </section>
  ${proofs.length
    ? html`<section class="card"><h2>Tus comprobantes</h2><ul class="list">${proofs.map((p) => html`<li class="due"><span class="due-text"><b>${shortDateTime(p.createdAt)}</b><small class="muted">${p.mime === "application/pdf" ? "PDF" : "Foto"}</small></span>${PROOF_STATUS[p.status]}</li>`)}</ul></section>`
    : ""}
</main>`, { manifest: `/r/${token}/manifest.webmanifest` });
}

export function residentPage({ tenant, house, dues, period, token, proofs = [], day = bogotaDay() }) {
  const open = dues.filter((d) => d.period === period && d.status === "pending");
  const behind = dues.filter((d) => d.period < period && d.status === "pending");
  const windowText = paymentWindow(tenant, period);
  const overdue = behind.length > 0 || (tenant.dueDay != null && open.length > 0 && day > tenant.dueDay);
  const owed = [...open, ...behind];
  const total = owed.reduce((s, d) => s + d.amountCents, 0);
  return layout("Mi cuota", html`
<main class="narrow res">
  <header class="res-top">${BRAND_MARK}<span class="chip">Casa ${house.code}</span></header>
  <div class="res-hello"><h1>Hola, ${firstName(house.residentName)}</h1><span class="muted">${tenant.name}</span></div>

  <section class="hero" aria-label="Tu cuota">
    <div class="row">
      <span class="eyebrow">${owed.length ? "Tu cuota" : "Vigilancia"} · ${periodLabel(period).split(" ")[0]}</span>
      ${owed.length ? (overdue ? html`<span class="pill bad"><i></i>Vencida</span>` : STATUS.pending) : STATUS.paid}
    </div>
    ${owed.length
      ? html`<span class="hero-number">${peso(total)}</span>
        ${windowText ? html`<span class="hero-sub">${windowText}</span>` : ""}
        <span class="hero-sub">${behind.length ? `Incluye ${behind.length} mes${behind.length === 1 ? "" : "es"} anterior${behind.length === 1 ? "" : "es"}` : [...new Set(owed.map((d) => d.conceptName))].join(" + ")}</span>
        <a class="btn lime big" href="/r/${token}/pagar">Pagar ahora ${icon("arrow", 20, 2.5)}</a>`
      : html`<span class="hero-number">Al día</span><span class="hero-sub">No tienes cuotas pendientes. ¡Gracias!</span>`}
  </section>

  ${proofs.some((p) => p.status === "pending") ? html`<p class="flash info" role="status">Enviaste un comprobante y está en revisión. <a href="/r/${token}/comprobante">Ver</a></p>` : ""}
  ${proofs[0]?.status === "rejected" && owed.length ? html`<p class="flash err" role="status">El tesorero no pudo confirmar tu último comprobante. Revisa el valor o <a href="/r/${token}/comprobante">súbelo de nuevo</a>.</p>` : ""}

  <section class="card">
    <h2>Tus pagos</h2>
    ${dues.length
      ? html`<ul class="list">${dues.map((d) => html`<li class="due">
          <span class="dot ${d.status === "paid" ? "ok" : "warn"}">${d.status === "paid" ? icon("check", 18, 3) : ""}</span>
          <span class="due-text"><b>${monthName(d.period)}</b><small class="muted">${d.conceptName} · ${d.paidAt ? `Pagado el ${shortDate(d.paidAt)}` : "Pendiente"}</small></span>
          ${d.status === "paid" ? html`<a class="small strong" href="/r/${token}/recibo/${d.id}">Recibo</a>` : html`<b>${peso(d.amountCents)}</b>`}
        </li>`)}</ul>`
      : html`<p class="muted small">Todavía no tienes cuotas.</p>`}
  </section>
</main>`, { manifest: `/r/${token}/manifest.webmanifest` });
}

/** How to pay: the Bre-B key to copy and the exact amount. It refreshes itself so it turns into "Al día" once the bank confirms. */
export function residentPayPage({ tenant, house, dues, token, proofs = [] }) {
  const owed = dues.filter((d) => d.status === "pending");
  const total = owed.reduce((s, d) => s + d.amountCents, 0);
  return layout("Pagar", html`
<main class="narrow res">
  <header class="backbar"><a href="/r/${token}" aria-label="Volver">${icon("back", 24, 2.2)}</a><h1>Pagar vigilancia</h1></header>

  <section class="hero center-text" aria-label="Total a pagar">
    <span class="eyebrow">Total a pagar</span>
    <span class="hero-number">${peso(total)}</span>
    <span class="hero-sub">Casa ${house.code} · ${tenant.name}</span>
  </section>

  ${tenant.payKey
    ? html`<section class="card">
        <span class="eyebrow dim">Paga por Bre-B a la llave</span>
        <p class="key" id="llave" translate="no">${tenant.payKey}</p>
        ${tenant.payHolder ? html`<p class="muted small">Titular: <b>${tenant.payHolder}</b></p>` : ""}
        <button class="btn" type="button" data-copy="${tenant.payKey}" data-copy-target="#llave">Copiar llave</button>
        <ol class="steps small">
          <li>Abre la app de tu banco o billetera.</li>
          <li>Elige pagar o transferir con <b>llave Bre-B</b>.</li>
          <li>Escribe la llave y el valor <b>exacto: ${peso(total)}</b>.</li>
        </ol>
      </section>`
    : html`<section class="card"><p>El tesorero aún no ha configurado cómo pagar. Escríbele para que te indique.</p></section>`}

  <section class="card">
    ${proofs.some((p) => p.status === "pending")
      ? html`<p>Tu comprobante está <b>en revisión</b>. <a href="/r/${token}/comprobante">Ver</a></p>`
      : html`<p><b>¿Ya pagaste?</b> Sube la foto del comprobante para que el tesorero lo confirme más rápido.</p><a class="btn ghost" href="/r/${token}/comprobante">Subir comprobante</a>`}
  </section>

  <p class="waiting" role="status"><span class="pulse"></span>${tenant.pagoradarConfigured
    ? "Esperando tu pago. Esta pantalla se actualiza sola cuando el banco lo confirme."
    : "Cuando pagues, avísale al tesorero para que registre tu pago. Esta pantalla se actualiza cuando lo haga."}</p>
  <p class="muted small center-text">Paga siempre el valor exacto. Si pagas otro valor, el tesorero lo asignará a mano.</p>
</main>`, { refresh: 20, manifest: `/r/${token}/manifest.webmanifest` });
}

export function receiptPage({ tenant, receipt, token }) {
  const medium = receipt.manual ? paymentMedium(receipt) : `Bre-B · ${bankLabel(receipt.bank)}`;
  return layout("Recibo", html`
<main class="receipt">
  <div class="okring">${icon("check", 36, 3)}</div>
  <h1>¡Pago confirmado!</h1>
  <p class="receipt-lead">Gracias, ${firstName(receipt.residentName)}. Tu cuota de ${receipt.conceptName.toLowerCase()} de ${periodLabel(receipt.period).split(" ")[0]} quedó al día.</p>

  <section class="rcard" aria-label="Recibo">
    <div><span class="eyebrow dim">Total pagado</span><span class="rtotal">${peso(receipt.amountCents)}</span></div>
    <hr>
    <dl>
      <div><dt>Concepto</dt><dd>${receipt.conceptName} · ${periodLabel(receipt.period)}</dd></div>
      <div><dt>Casa</dt><dd>Casa ${receipt.houseCode} · ${receipt.residentName}</dd></div>
      <div><dt>Fecha</dt><dd>${shortDateTime(receipt.paidAt)}</dd></div>
      <div><dt>Medio</dt><dd>${medium}</dd></div>
      <div><dt>Recibo</dt><dd>N.º ${receipt.number}</dd></div>
    </dl>
    <hr>
    <p class="muted small">${tenant.name} · Recibo emitido por Cuotia, no válido como factura.</p>
  </section>

  <div class="receipt-actions">
    <button class="btn lime big" type="button" data-print>Descargar recibo en PDF</button>
    <a class="btn outline big" href="/r/${token}">Volver al inicio</a>
  </div>
</main>`, { bodyClass: "receipt-page", manifest: `/r/${token}/manifest.webmanifest` });
}

/** Shown by the service worker when the phone has no connection. Static and public: it is cached when the app is first opened. */
export function offlinePage() {
  return layout("Sin conexión", html`
<main class="center">
  <div class="card login">
    ${BRAND_MARK}
    <h1>Sin conexión</h1>
    <p class="muted">Cuotia necesita internet para mostrar tus pagos. Revisa tu conexión e inténtalo de nuevo.</p>
    <button class="btn" type="button" data-reload>Reintentar</button>
  </div>
</main>`);
}

export function notFoundPage() {
  return layout("No encontrado", html`<main class="center"><div class="card"><h1>No encontrado</h1><p class="muted">Este enlace no existe o ya no está activo.</p></div></main>`);
}
