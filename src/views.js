import { html, raw } from "./http.js";
import { qrSvg } from "./qr.js";
import { MESSAGES, message, renderTemplate } from "./messages.js";
import { MANUAL_LABELS, PAY_KINDS, bankLabel, bogotaDay, currentPeriod, longDate, payMethodAccount, paySummary, payMethodTitle, lastPeriods, matchesSearch, monthName, monthShort, paymentMedium, peso, periodLabel, shortDate, shortDateTime, whatsappNumber } from "./text.js";

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
  mas: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
  bitacora: '<path d="M12 7v5l3 2"/><circle cx="12" cy="12" r="9"/>',
  cuentas: '<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M9 9h6M9 13h6"/>',
  cobrar: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6.5l1 1 2-2M4 12.5l1 1 2-2M4 18.5l1 1 2-2"/>',
};
const icon = (name, size = 20, width = 2) => html`<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${raw(ICONS[name])}</svg>`;

const BRAND_MARK = html`<span class="brand"><span class="brand-mark"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span>cuotia</span>`;

export function layout(title, body, { refresh = 0, bodyClass = "", manifest = "/manifest.webmanifest", legal = true, noindex = false } = {}) {
  return html`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#3B3028">
<meta name="color-scheme" content="light dark">
<script src="/static/theme.js"></script>
<meta name="application-name" content="Cuotia">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Cuotia">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/static/icons/favicon-32.png" type="image/png" sizes="32x32">
<link rel="icon" href="/static/icons/favicon-48.png" type="image/png" sizes="48x48">
<link rel="apple-touch-icon" href="/static/icons/apple-touch-icon.png">
${manifest ? html`<link rel="manifest" href="${manifest}">` : ""}
${noindex ? raw('<meta name="robots" content="noindex,nofollow,noarchive">') : ""}
<title>${title} · Cuotia</title>
${refresh ? raw(`<meta http-equiv="refresh" content="${Number(refresh)}">`) : ""}
<link rel="preload" href="/static/fonts/plus-jakarta-sans-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/static/app.css">
<script src="/static/app.js" defer></script>
</head>
<body${bodyClass ? raw(` class="${bodyClass}"`) : ""}>${body}${legal ? html`<footer class="legal noprint"><a href="/privacidad">Política de privacidad</a></footer>` : ""}</body>
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
  reinicio: () => ({ kind: "ok", text: "Listo: empezaste de cero. Antes de borrar se guardó una copia de seguridad en el servidor, por si algo hiciera falta." }),
  reiniciosc: () => ({ kind: "ok", text: "Listo: empezaste de cero." }),
  rsclave: () => ({ kind: "err", text: "La contraseña no es correcta (o hiciste demasiados intentos). No se borró nada." }),
  rsconf: () => ({ kind: "err", text: "Escribe BORRAR para confirmar. No se borró nada." }),
  rscopia: () => ({ kind: "err", text: "No se pudo guardar la copia de seguridad, así que no se borró nada." }),
  pkquit: () => ({ kind: "ok", text: "Passkey quitado. Ya no se puede entrar con él." }),
  pkbad: () => ({ kind: "err", text: "Ese passkey no existe." }),
  pmok: () => ({ kind: "ok", text: "Medio de pago agregado. Los residentes ya lo ven en su pantalla de pagar." }),
  pmbad: () => ({ kind: "err", text: "Revisa los datos del medio de pago: el celular de Nequi o Daviplata tiene 10 dígitos y empieza por 3; Bancolombia pide el número de cuenta y si es de ahorros o corriente." }),
  pmdup: () => ({ kind: "err", text: "Ya agregaste ese medio de pago." }),
  pmquit: () => ({ kind: "ok", text: "Medio de pago quitado. Los residentes ya no lo ven." }),
  msok: () => ({ kind: "ok", text: "Mensaje guardado. Desde ahora los botones de WhatsApp lo usan." }),
  msreset: () => ({ kind: "ok", text: "Volviste al mensaje original." }),
  msbad: () => ({ kind: "err", text: "Ese mensaje no existe." }),
  anon: () => ({ kind: "ok", text: "Datos personales borrados. El historial de cuotas y pagos quedó sin nombre." }),
  desact: () => ({ kind: "ok", text: "Casa dada de baja. Su historial se conserva y la puedes reactivar cuando quieras." }),
  react: () => ({ kind: "ok", text: "Casa dada de alta otra vez: vuelve a recibir cuotas. Genera su enlace personal nuevo si lo necesita." }),
  undo: () => ({ kind: "ok", text: "Asignación deshecha: el pago volvió a “Por asignar” y la cuota a pendiente." }),
  undoc: () => ({ kind: "ok", text: "Pago anulado: las cuotas que cubría volvieron a pendiente." }),
  sec: () => ({ kind: "ok", text: "Secreto de pagoradar guardado. Envía un evento de prueba desde pagoradar para confirmar la conexión." }),
  secbad: () => ({ kind: "err", text: "El secreto debe tener entre 8 y 200 caracteres y no puede llevar espacios." }),
  comprech: () => ({ kind: "ok", text: "Comprobante rechazado. El residente verá que no se pudo confirmar." }),
  pushprobe: () => ({ kind: "ok", text: "Te enviamos un aviso de prueba. Si no lo ves en unos segundos, revisa que las notificaciones de Cuotia estén permitidas en tu teléfono." }),
  pushsin: () => ({ kind: "err", text: "Primero activa los avisos en este dispositivo." }),
  cnok: () => ({ kind: "ok", text: "Cobro mensual agregado. La cuota de este mes ya está creada para todas las casas." }),
  cnbad: () => ({ kind: "err", text: "Revisa el nombre (2 a 60 letras) y el valor (entre $1.000 y $100.000.000)." }),
  cndup: () => ({ kind: "err", text: "Ya existe un cobro con ese nombre. Usa otro." }),
  cnval: () => ({ kind: "ok", text: "Valor cambiado. Aplica a las cuotas que se creen desde ahora." }),
  cnest: () => ({ kind: "ok", text: "Listo." }),
  cnultimo: () => ({ kind: "err", text: "Debe quedar al menos un cobro mensual activo." }),
  espok: () => ({ kind: "ok", text: "Cobro especial creado. Ya aparece en Por cobrar y en la pantalla de cada casa." }),
  espbad: () => ({ kind: "err", text: "Revisa el nombre, el valor, el mes (no puede ser futuro) y la casa elegida." }),
  gastook: () => ({ kind: "ok", text: "Gasto registrado." }),
  gastobad: () => ({ kind: "err", text: "Revisa el gasto: escribe el valor en pesos, en qué se gastó, la categoría y una fecha que no sea futura." }),
  gastoarchivo: () => ({ kind: "err", text: "El soporte debe ser una foto (JPG, PNG, WebP) o un PDF de máximo 5 MB." }),
  gastogrande: () => ({ kind: "err", text: "El soporte pesa más de 5 MB." }),
  gastoanul: () => ({ kind: "ok", text: "Gasto anulado: sigue visible como anulado y ya no cuenta en el saldo." }),
  cuentasok: () => ({ kind: "ok", text: "Guardado." }),
  trok: () => ({ kind: "ok", text: "La página de transparencia está activa. Copia el enlace y compártelo." }),
  trcambio: () => ({ kind: "ok", text: "Listo: el enlace cambió. El anterior ya no abre nada." }),
  trapagado: () => ({ kind: "ok", text: "La página de transparencia está apagada: el enlace ya no abre nada." }),
  saldobad: () => ({ kind: "err", text: "El saldo inicial debe ser un valor en pesos, por ejemplo 250.000." }),
  eqbad: () => ({ kind: "err", text: "Escribe un correo válido para la invitación." }),
  eqexiste: () => ({ kind: "err", text: "Ese correo ya tiene una cuenta en Cuotia." }),
  eqcanc: () => ({ kind: "ok", text: "Invitación cancelada: su enlace ya no sirve." }),
  eqquit: () => ({ kind: "ok", text: "Listo: esa persona ya no puede entrar y sus sesiones se cerraron." }),
  eqyo: () => ({ kind: "err", text: "No puedes quitarte a ti mismo. Pídele a otra persona del equipo que lo haga." }),
  equltimo: () => ({ kind: "err", text: "No se pudo quitar: debe quedar al menos una persona con acceso." }),
  modo: () => ({ kind: "ok", text: "Guardado. Los residentes ya ven el mensaje que corresponde a cómo confirmas los pagos." }),
  modobad: () => ({ kind: "err", text: "Elige una de las dos opciones." }),
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
    <div class="passkey-box" data-passkey-login-box hidden>
      <p class="muted small center-text">o</p>
      <button class="btn ghost" type="button" data-passkey-login>Entrar con passkey</button>
      <p class="small" data-passkey-status role="status"></p>
    </div>
  </form>
</main>`);
}

// ---------------------------------------------------------------------------------------------------------------
// Operator panel (the platform's owner). Own login, no conjunto data: only counts.
// ---------------------------------------------------------------------------------------------------------------

export function operadorLoginPage({ error } = {}) {
  return layout("Operador", html`
<main class="center">
  <form class="card login" method="post" action="/operador/entrar">
    ${BRAND_MARK}
    <h1>Operador</h1>
    <p class="muted">Panel de Cuotia para crear y acompañar conjuntos</p>
    ${error ? html`<p class="alert" role="alert">${error}</p>` : ""}
    <label>Correo<input type="email" name="email" autocomplete="username" required autofocus></label>
    <label>Contraseña<input type="password" name="password" autocomplete="current-password" required></label>
    <button class="btn" type="submit">Continuar</button>
  </form>
</main>`, { legal: false });
}

const OPERADOR_FLASH = {
  clave: { kind: "ok", text: "Contraseña cambiada. En los demás dispositivos tendrás que entrar de nuevo." },
  claveerr: { kind: "err", text: "La contraseña actual no es correcta, o la nueva tiene menos de 10 caracteres o no coincide." },
  invitado: { kind: "ok", text: "Invitación creada." },
  respaldo: { kind: "ok", text: "Respaldo hecho: la copia cifrada ya está en todos los destinos." },
  respaldoerr: { kind: "err", text: "El respaldo no se completó en todos los destinos. Mira el detalle abajo, en Respaldos." },
  err: { kind: "err", text: "No se pudo completar. Revisa los datos." },
};

const operadorShell = (title, { csrf, operator, active }, body) => layout(title, html`
<div class="operador">
  <header class="op-bar">
    <span class="op-brand">${BRAND_MARK}<span class="chip">Operador</span></span>
    <nav class="op-nav" aria-label="Operador">
      <a href="/operador"${active === "conjuntos" ? raw(' aria-current="page"') : ""}>Conjuntos</a>
      <a href="/operador/cuenta"${active === "cuenta" ? raw(' aria-current="page"') : ""}>Mi cuenta</a>
    </nav>
    <form method="post" action="/operador/salir">${csrfField(csrf)}<button class="btn ghost small" type="submit">Salir</button></form>
  </header>
  <main class="op-page">${body}</main>
</div>`, { legal: false });

export function operadorPage({ csrf, operator, flash, tenants, totals, error = "", values = {}, backups = { destinations: [], warnings: [], last: null, lastOk: null, tested: null } }) {
  const flashBox = flash ? html`<p class="flash ${flash.kind}" role="status">${flash.text}</p>` : "";
  return operadorShell("Conjuntos", { csrf, operator, active: "conjuntos" }, html`
  <div class="heading"><h1>Conjuntos</h1><span class="muted">${totals.tenants} conjunto${totals.tenants === 1 ? "" : "s"} · ${totals.houses} casa${totals.houses === 1 ? "" : "s"}</span></div>
  ${flashBox}
  <section class="card">
    <p class="muted small">Aquí solo ves cuántas casas y personas tiene cada conjunto y si está conectado. No ves nombres de residentes, pagos ni cuentas: eso es de cada conjunto.</p>
    ${tenants.length
      ? html`<ul class="list stack">${tenants.map((t) => html`<li class="op-tenant">
          <div class="row"><span><b>${t.name}</b><small class="muted">${t.slug} · creado el ${shortDate(t.createdAt)}</small></span>
            ${t.pagoradarConfigured ? html`<span class="pill ok"><i></i>pagoradar${t.pagoradarLastAt ? ` · ${shortDate(t.pagoradarLastAt)}` : ""}</span>` : html`<span class="pill warn"><i></i>Manual</span>`}</div>
          <dl class="op-stats">
            <div><dt>Casas</dt><dd>${t.houses}</dd></div>
            <div><dt>Equipo</dt><dd>${t.team}</dd></div>
            <div><dt>Invitaciones</dt><dd>${t.invites}</dd></div>
            <div><dt>Último ingreso</dt><dd>${t.lastLogin ? shortDateTime(t.lastLogin) : "—"}</dd></div>
          </dl>
          <details class="undo"><summary>Invitar a otra persona</summary>
            <form class="grid-form" method="post" action="/operador/conjuntos/${t.id}/invitar">${csrfField(csrf)}
              <label>Nombre<input type="text" name="nombre" maxlength="80" placeholder="Pedro Gómez"></label>
              <label>Correo<input type="email" name="correo" maxlength="120" required></label>
              <button class="btn small" type="submit">Crear invitación</button>
            </form>
          </details>
        </li>`)}</ul>`
      : html`<p class="muted">Todavía no hay conjuntos.</p>`}
  </section>

  <section class="card" id="respaldos">
    <h2>Respaldos fuera del servidor</h2>
    ${backups.destinations.length
      ? html`<p class="muted small">Cada noche Cuotia copia toda la base, la <b>cifra con tu MASTER_KEY</b> y la sube a: <b>${backups.destinations.join(" y ")}</b>. Quien guarde el archivo no puede leerlo sin esa llave: <b>guárdala</b>, porque sin ella ni tú puedes restaurar.</p>
        <p class="small">${backups.lastOk ? html`Último respaldo bueno: <b>${shortDateTime(backups.lastOk)}</b>${backups.last?.bytes ? ` · ${(backups.last.bytes / 1048576).toFixed(1)} MB` : ""}` : html`<span class="pill warn"><i></i>Todavía no hay un respaldo bueno</span>`}</p>
        ${backups.last ? html`<ul class="list">${backups.last.results.map((r) => html`<li><span><b>${r.name}</b><small class="muted">${shortDateTime(backups.last.at)}${r.ok ? "" : ` · ${r.error}`}</small></span>${r.ok ? html`<span class="pill ok"><i></i>Listo</span>` : html`<span class="pill bad"><i></i>Falló</span>`}</li>`)}</ul>` : ""}
        ${backups.tested ? html`<p class="small"><b>Prueba de conexión:</b></p><ul class="list">${backups.tested.map((r) => html`<li><span><b>${r.name}</b><small class="muted">${r.ok ? "Se pudo escribir, leer y borrar un archivo de prueba" : r.error}</small></span>${r.ok ? html`<span class="pill ok"><i></i>Funciona</span>` : html`<span class="pill bad"><i></i>No funciona</span>`}</li>`)}</ul>` : ""}
        <div class="actions">
          <form method="post" action="/operador/respaldo/probar">${csrfField(csrf)}<button class="btn ghost" type="submit">Probar conexión</button></form>
          <form method="post" action="/operador/respaldo">${csrfField(csrf)}<button class="btn" type="submit">Respaldar ahora</button></form>
        </div>`
      : html`<p class="muted small">Todavía no hay destinos. Agrega las variables <code>BACKUP1_ENDPOINT</code>, <code>BACKUP1_BUCKET</code>, <code>BACKUP1_KEY_ID</code> y <code>BACKUP1_SECRET</code> (y <code>BACKUP2_…</code> para un segundo destino) en Dokploy y redespliega. Están explicadas en el README.</p>`}
    ${backups.warnings.map((w) => html`<p class="alert" role="alert">${w}</p>`)}
  </section>

  <section class="card" id="nuevo">
    <h2>Crear un conjunto</h2>
    <p class="muted small">Se crea el conjunto con su cobro mensual y se genera un enlace de invitación para quien será su tesorero: esa persona escoge su propia contraseña y activa su código de verificación. Tú nunca ves su contraseña.</p>
    ${error ? html`<p class="alert" role="alert">${error}</p>` : ""}
    <form class="stack-form" method="post" action="/operador/conjuntos">
      ${csrfField(csrf)}
      <fieldset>
        <legend>Conjunto</legend>
        <label>Nombre<input type="text" name="nombre" maxlength="80" required value="${values.nombre ?? ""}" placeholder="Los Robles"></label>
        <label>Cuota mensual (pesos)<input type="text" name="cuota" inputmode="numeric" maxlength="12" required value="${values.cuota ?? "30.000"}"></label>
        <label>Llave Bre-B para cobrar <span class="muted small">(opcional)</span><input type="text" name="llave" maxlength="80" value="${values.llave ?? ""}" placeholder="@mi.llave"></label>
        <label>Titular de la cuenta <span class="muted small">(opcional)</span><input type="text" name="titular" maxlength="80" value="${values.titular ?? ""}"></label>
      </fieldset>
      <fieldset>
        <legend>Tesorero</legend>
        <label>Nombre<input type="text" name="tesorero" maxlength="80" required value="${values.tesorero ?? ""}"></label>
        <label>Correo<input type="email" name="correo" maxlength="120" required value="${values.correo ?? ""}"></label>
      </fieldset>
      <button class="btn" type="submit">Crear conjunto e invitar</button>
    </form>
  </section>`);
}

/** The invitation link, shown once. */
export function operadorLinkPage({ csrf, operator, tenantName, email, url }) {
  const text = `Hola, te invito a ${tenantName} en Cuotia. Crea tu contraseña aquí (el enlace vence en 7 días y sirve una sola vez): ${url}`;
  return operadorShell("Invitación", { csrf, operator, active: "conjuntos" }, html`
  <div class="heading"><h1>Invitación lista</h1><span class="muted">${tenantName}</span></div>
  <section class="card">
    <p class="small">Envíale este enlace a <b>${email}</b>. <b>Solo se muestra ahora</b>; si se pierde, crea otra invitación para el mismo correo y la anterior deja de servir. Sirve una sola vez y vence en 7 días.</p>
    <p class="key url" translate="no" id="enlace">${url}</p>
    <div class="actions">
      <button class="btn" type="button" data-copy="${url}" data-copy-target="#enlace">Copiar enlace</button>
      <a class="btn ghost" href="https://wa.me/?text=${encodeURIComponent(text)}" rel="noopener noreferrer">Enviar por WhatsApp</a>
      <a class="btn ghost" href="/operador">Volver a conjuntos</a>
    </div>
  </section>`);
}

export function operadorCuentaPage({ csrf, operator, flash }) {
  return operadorShell("Mi cuenta", { csrf, operator, active: "cuenta" }, html`
  <div class="heading"><h1>Mi cuenta</h1><span class="muted">${operator.email}</span></div>
  ${flash ? html`<p class="flash ${flash.kind}" role="status">${flash.text}</p>` : ""}
  <section class="card">
    <h2>Cambiar contraseña</h2>
    <form class="grid-form" method="post" action="/operador/cuenta/clave" autocomplete="off">
      ${csrfField(csrf)}
      <label>Contraseña actual<input type="password" name="actual" required autocomplete="current-password"></label>
      <label>Contraseña nueva (mínimo 10 caracteres)<input type="password" name="nueva" minlength="10" maxlength="200" required autocomplete="new-password"></label>
      <label>Repite la nueva<input type="password" name="nueva2" minlength="10" maxlength="200" required autocomplete="new-password"></label>
      <button class="btn" type="submit">Cambiar contraseña</button>
    </form>
    <p class="muted small">Si pierdes el celular del código, desde la terminal: <code>npm run admin -- restablecer-operador --correo ${operator.email}</code></p>
  </section>`);
}
export const OPERADOR_FLASHES = OPERADOR_FLASH;

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
export function twoFaPage({ stage, error, secret, uri, email, action = "/2fa" }) {
  const grouped = secret ? secret.replace(/(.{4})/g, "$1 ").trim() : "";
  return layout("Código de verificación", html`
<main class="center">
  <form class="card login" method="post" action="${action}" autocomplete="off">
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
  { key: "cuentas", href: "/panel/cuentas", label: "Cuentas", icon: "cuentas" },
  { key: "ajustes", href: "/panel/ajustes", label: "Ajustes", icon: "ajustes" },
];

/** Phones get five tabs: the daily ones, and "Más" for what is used less (cuentas, ajustes, bitácora). */
const TABS = [...NAV.slice(0, 4), { key: "mas", href: "/panel/mas", label: "Más", icon: "mas" }];
const MORE_KEYS = ["mas", "cuentas", "conceptos", "mensajes", "ajustes", "bitacora"];

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
      ${sideLink(NAV.find((n) => n.key === "cuentas"))}
      ${sideLink(NAV.find((n) => n.key === "ajustes"))}
    </nav>
    <div class="side-foot">
      <div class="conj">
        <span class="eyebrow">Conjunto</span>
        <b>${tenant.name}</b>
        <small>${houseCount} casa${houseCount === 1 ? "" : "s"}${cuota ? ` · ${cuota}` : ""}</small>
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
    ${TABS.map((n) => html`<a class="tab" href="${n.href}"${n.key === "mas" ? (MORE_KEYS.includes(active) ? raw(' aria-current="page"') : "") : current(n.key)}>${icon(n.icon, 22)}<span>${n.label}</span>${n.key === "resumen" ? unassigned : owes(n)}</a>`)}
  </nav>
</div>`, { legal: false });
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
  return `https://wa.me/?text=${encodeURIComponent(generalReminder(tenant, owing.map((d) => d.houseCode).join("\n"), period, tenant.monthlyCents || owing[0].amountCents))}`;
}

/** "Hasta el 10 de noviembre puedes pagar." when the conjunto set a last day; "" otherwise. */
const deadlineText = (tenant) => (tenant.dueDay ? `El último día para pagar es el ${tenant.dueDay} de ${monthName(currentPeriod()).toLowerCase()}.` : "");

/** The message to the whole group of neighbours, from the conjunto's own text or the original. */
const generalReminder = (tenant, casas, period, valorCuota) => message(tenant, "recordatorio_general", {
  mes: monthName(period).toLowerCase(), valor_cuota: peso(valorCuota), casas, plazo: deadlineText(tenant), como_pagar: paySummary(tenant),
});

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
  const names = group.months.map((m) => monthName(m).toLowerCase());
  const when = names.length === 1 ? `de ${names[0]}` : `de ${names.slice(0, -1).join(", ")} y ${names.at(-1)}`;
  return message(tenant, "recordatorio_casa", {
    nombre: group.house.residentName.trim().split(/\s+/)[0], casa: group.house.code, meses: when, valor: peso(group.totalCents),
    detalle: group.dues.map((d) => `• ${monthName(d.period)} · ${d.conceptName}: ${peso(d.amountCents)}`).join("\n"),
    plazo: deadlineText(tenant), como_pagar: paySummary(tenant, { asking: true }),
  });
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
      <a class="btn alt small" href="/panel/pagos/nuevo?casa=${house.id}">Registrar pago</a>
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
    { done: Boolean(tenant.payKey) || (tenant.payMethods ?? []).length > 0, title: "Agrega cómo pagar", text: "Tu llave Bre-B, Nequi, Daviplata o cuenta: la ven los vecinos cuando van a pagar.", href: "/panel/ajustes", cta: "Ir a Ajustes" },
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
      <span class="muted">Así va el recaudo del mes.</span>
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
    ? `https://wa.me/?text=${encodeURIComponent(generalReminder(tenant, groups.map((g) => `${g.house.code} (${g.months.map(monthShort).join(", ")})`).join("\n"), current, tenant.monthlyCents || groups[0].dues[0].amountCents))}`
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
              ${g ? html`<a class="btn alt small" href="/panel/pagos/nuevo?casa=${h.id}">Registrar pago</a>` : ""}
              <a class="btn ghost small" href="/panel/casas/${h.id}">Editar</a>
              <form method="post" action="/panel/casas/${h.id}/enlace">${csrfField(csrf)}<button class="btn ghost small" type="submit">Enlace</button></form>
            </span>
          </li>`;
        })}</ul><p class="muted" id="sin-casas" hidden>Ninguna casa coincide.</p>`}
  </section>

  ${inactive.length
    ? html`<section class="card">
        <h2>Casas dadas de baja</h2>
        <p class="muted small">Ya no reciben cuotas ni tienen enlace, pero su historial se conserva.</p>
        <ul class="list">${inactive.map((h) => html`<li>
          <span><b>Casa ${h.code}</b><small class="muted">${h.residentName}</small></span>
          <span class="actions">
            <a class="btn ghost small" href="/panel/casas/${h.id}">Ver</a>
            <form method="post" action="/panel/casas/${h.id}/reactivar">${csrfField(csrf)}<button class="btn ghost small" type="submit">Dar de alta</button></form>
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
              <select name="medio" data-medio>${methods.map(([key, label]) => html`<option value="${key}"${key === "transfer" ? raw(" selected") : ""}>${label}</option>`)}</select>
            </label>
            <label data-banco>Banco o billetera <span class="muted small">(opcional)</span><input type="text" name="banco" maxlength="40" value="Nequi" list="bancos" autocomplete="off" placeholder="Nequi, Bancolombia…"><datalist id="bancos"><option value="Nequi"><option value="Bancolombia"><option value="Daviplata"><option value="Davivienda"><option value="Nu"><option value="Banco de Bogotá"></datalist></label>
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
  const { tenant, csrf, flash, webhookUrl, team = [], invites = [], meId, pushKey = "", pushDevices = 0, passkeys = [] } = args;
  return panelLayout("Ajustes", { ...args, active: "ajustes" }, html`
  <div class="heading"><h1>Ajustes</h1><span class="muted">${tenant.name}</span></div>
  ${flashBox(flash)}

  <section class="card">
    <h2>¿Cómo confirmas los pagos?</h2>
    <p class="muted small">Es lo que el residente lee en su pantalla de pago. Elige <b>manual</b> si tú registras cada pago (con o sin comprobante).</p>
    <form class="stack-form" method="post" action="/panel/ajustes/modo">
      ${csrfField(csrf)}
      <label class="check"><input type="radio" name="modo" value="manual"${tenant.payMode === "manual" ? raw(" checked") : ""}><span><b>Manual</b> · el residente sube su comprobante o te avisa, y tú registras el pago</span></label>
      <label class="check"><input type="radio" name="modo" value="auto"${tenant.payMode === "auto" ? raw(" checked") : ""}><span><b>Automático con pagoradar</b> · el banco avisa y la cuota se marca sola</span></label>
      <button class="btn" type="submit">Guardar</button>
    </form>
  </section>

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

  <section class="card" id="medios">
    <h2>Otros medios de pago</h2>
    <p class="muted small">Además de la llave Bre-B. Los residentes los ven todos en su pantalla de pagar, con un botón para copiar el número. Los pagos que lleguen por aquí los registras tú (o el residente sube su comprobante): pagoradar solo lee los de la cuenta Bre-B.</p>
    ${(tenant.payMethods ?? []).length
      ? html`<ul class="list stack">${tenant.payMethods.map((m) => html`<li class="concept">
          <div class="row"><span><b>${payMethodTitle(m)}</b><small class="muted" translate="no">${payMethodAccount(m)}${m.holder ? ` · ${m.holder}` : ""}${m.note ? ` · ${m.note}` : ""}</small></span>
            <details class="undo"><summary>Quitar</summary>
              <form method="post" action="/panel/ajustes/medios/${m.id}/quitar">${csrfField(csrf)}<button class="btn ghost small" type="submit">Sí, quitar</button></form>
            </details></div>
        </li>`)}</ul>`
      : html`<p class="muted small">Todavía no hay otros medios de pago.</p>`}
    <form class="stack-form" method="post" action="/panel/ajustes/medios">
      ${csrfField(csrf)}
      <div class="grid-form">
        <label>Medio<select name="tipo" id="tipo-medio">${Object.entries(PAY_KINDS).map(([k, v]) => html`<option value="${k}">${v.label}</option>`)}</select></label>
        <label>Número (celular o cuenta)<input type="text" name="cuenta" inputmode="numeric" maxlength="60" required placeholder="3001234567"></label>
        <label>Clase de cuenta <span class="muted small">(solo Bancolombia)</span><select name="clase"><option value="">—</option><option value="ahorros">Ahorros</option><option value="corriente">Corriente</option></select></label>
        <label>Nombre del medio <span class="muted small">(solo "Otro")</span><input type="text" name="nombre" maxlength="30" placeholder="Ahorro a la mano"></label>
        <label>A nombre de <span class="muted small">(opcional)</span><input type="text" name="titular" maxlength="80" placeholder="Quien recibe el dinero"></label>
        <label>Indicación <span class="muted small">(opcional)</span><input type="text" name="nota" maxlength="120" placeholder="Escribe tu número de casa en el mensaje"></label>
      </div>
      <button class="btn" type="submit">Agregar medio de pago</button>
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

  <section class="card" id="apariencia" data-theme-card hidden>
    <h2>Apariencia</h2>
    <p class="muted small">Se guarda solo en este dispositivo. "Automático" sigue el modo claro u oscuro del teléfono.</p>
    <div class="theme-choice">
      <button class="btn ghost" type="button" data-theme-set="light" aria-pressed="false">Claro</button>
      <button class="btn ghost" type="button" data-theme-set="dark" aria-pressed="false">Oscuro</button>
      <button class="btn ghost" type="button" data-theme-set="auto" aria-pressed="false">Automático</button>
    </div>
  </section>

  <section class="card" id="passkeys" data-passkeys data-csrf="${csrf}">
    <div class="row wrap"><h2>Passkeys</h2>${passkeys.length ? html`<span class="pill ok"><i></i>${passkeys.length} activo${passkeys.length === 1 ? "" : "s"}</span>` : html`<span class="pill warn"><i></i>Sin passkeys</span>`}</div>
    <p class="muted small">Entra con la huella, el rostro o el PIN de tu celular o computador, sin escribir contraseña ni código. Es más seguro que la contraseña: no se puede robar con un enlace falso. Tu contraseña y tu código siguen sirviendo si cambias de teléfono.</p>
    ${passkeys.length ? html`<ul class="list stack">${passkeys.map((p) => html`<li class="concept">
      <div class="row"><span><b>${p.name}</b><small class="muted">Agregado el ${shortDate(p.createdAt)}${p.lastUsedAt ? ` · usado el ${shortDate(p.lastUsedAt)}` : " · sin usar"}</small></span>
        <details class="undo"><summary>Quitar</summary>
          <form method="post" action="/panel/passkeys/${p.id}/quitar">${csrfField(csrf)}<button class="btn ghost small" type="submit">Sí, quitar</button></form>
        </details></div>
    </li>`)}</ul>` : ""}
    <p class="small" data-passkey-status role="status"></p>
    <div class="grid-form">
      <label>Nombre del dispositivo<input type="text" name="nombre" maxlength="40" placeholder="iPhone de Marta" data-passkey-name></label>
      <button class="btn" type="button" data-passkey-add hidden>Agregar passkey en este dispositivo</button>
    </div>
  </section>

  <section class="card" id="avisos" data-push data-key="${pushKey}" data-csrf="${csrf}">
    <div class="row wrap"><h2>Avisos en el celular</h2>${pushDevices ? html`<span class="pill ok"><i></i>Activos en ${pushDevices} dispositivo${pushDevices === 1 ? "" : "s"}</span>` : html`<span class="pill warn"><i></i>Sin activar</span>`}</div>
    <p class="muted small">Te avisamos cuando un residente sube un comprobante o entra un pago por pagoradar. Cada persona del equipo los activa en su propio teléfono. En iPhone primero instala la app: Compartir, <b>Añadir a pantalla de inicio</b>, y ábrela desde ahí.</p>
    <p class="small" data-push-status role="status"></p>
    <div class="actions">
      <button class="btn" type="button" data-push-toggle>Activar avisos en este dispositivo</button>
      ${pushDevices ? html`<form method="post" action="/panel/push/probar">${csrfField(csrf)}<button class="btn ghost" type="submit">Enviarme un aviso de prueba</button></form>` : ""}
    </div>
  </section>

  <section class="card">
    <div class="row wrap"><h2>Empezar de cero</h2><a class="btn ghost small" href="/panel/reiniciar">Limpiar los datos</a></div>
    <p class="muted small">Para borrar lo que hiciste de prueba y arrancar limpio. Pide tu contraseña y guarda una copia antes de borrar.</p>
  </section>

  <section class="card">
    <p class="small"><a href="/privacidad" target="_blank" rel="noopener">Política de tratamiento de datos personales</a><br><span class="muted">La ven los residentes en el pie de sus pantallas. Revisa con un abogado que sirva para tu conjunto.</span></p>
    <div class="row wrap"><h2>Bitácora</h2><a class="btn ghost small" href="/panel/bitacora">Ver quién hizo qué</a></div>
    <p class="muted small">Cada pago, cambio de casa, gasto y ajuste queda anotado con la persona y la hora.</p>
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
    <span class="muted">${tenant.name}${house.active ? "" : " · dada de baja"}</span>
  </div>
  <p class="row wrap"><a href="/panel/casas">← Volver a casas</a>${house.active ? html`<a class="small" href="#baja">Dar de baja esta casa</a>` : ""}</p>
  ${flashBox(flash)}

  ${house.active ? "" : html`<p class="flash info" role="status">Esta casa está dada de baja: no recibe cuotas ni tiene enlace. Su historial se conserva. <a href="#baja">Reactivarla</a></p>`}

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
    <h2>Documentos</h2>
    <p class="muted small">Para imprimir o guardar en PDF. El paz y salvo solo se emite si la casa no tiene cuotas vencidas.</p>
    <div class="actions">
      <a class="btn ghost" href="/panel/casas/${house.id}/estado" target="_blank" rel="noopener">Estado de cuenta</a>
      ${house.active ? html`<a class="btn ghost" href="/panel/casas/${house.id}/paz-y-salvo" target="_blank" rel="noopener">Paz y salvo</a>` : ""}
    </div>
  </section>

  ${house.active ? "" : html`<section class="card" id="datos">
    <h2>Datos personales</h2>
    <p class="muted small">Si el residente pidió que borren sus datos (o ya no tiene relación con el conjunto), puedes quitarlos de esta casa. El historial de cuotas y pagos se conserva para la contabilidad, pero sin nombre: la casa queda como "Residente anterior", se borran su celular, los nombres de pago, los comprobantes que subió y los avisos de su celular, y el nombre del pagador de sus pagos. <b>No se puede deshacer.</b></p>
    <details class="undo"><summary>Borrar los datos personales</summary>
      <p class="muted small">Esta acción queda anotada en la bitácora.</p>
      <form method="post" action="/panel/casas/${house.id}/anonimizar">${csrfField(csrf)}<button class="btn small danger" type="submit">Sí, borrar los datos personales</button></form>
    </details>
  </section>`}

  <section class="card" id="baja">
    <h2>Acciones</h2>
    ${house.active
      ? html`<form method="post" action="/panel/casas/${house.id}/enlace">${csrfField(csrf)}<button class="btn ghost" type="submit">Generar enlace personal nuevo</button></form>
        <details class="undo">
          <summary>Dar de baja esta casa</summary>
          <p class="muted small">Úsalo cuando una familia se va o la casa deja de pagar cuota. Deja de recibir cuotas nuevas y su enlace personal deja de servir. Lo que debía sin pagar ya no cuenta como pendiente. Los pagos y el historial se conservan y la puedes reactivar.</p>
          <form method="post" action="/panel/casas/${house.id}/desactivar">${csrfField(csrf)}<button class="btn small danger" type="submit">Sí, dar de baja</button></form>
        </details>`
      : html`<form method="post" action="/panel/casas/${house.id}/reactivar">${csrfField(csrf)}<button class="btn" type="submit">Dar de alta otra vez</button></form>`}
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

/** "noviembre 2026" navigation shared by the treasurer's and the residents' accounts pages. */
const monthNav = (base, period, prev, next) => html`<nav class="monthnav" aria-label="Elegir mes">
  ${prev ? html`<a class="mn-btn" href="${base}?mes=${prev}" aria-label="Mes anterior: ${periodLabel(prev)}">${icon("back", 18, 2.4)}</a>` : html`<span class="mn-btn off" aria-hidden="true">${icon("back", 18, 2.4)}</span>`}
  <span class="mn-label">${icon("calendar", 18)}${periodLabel(period)}</span>
  ${next ? html`<a class="mn-btn" href="${base}?mes=${next}" aria-label="Mes siguiente: ${periodLabel(next)}">${icon("next", 18, 2.4)}</a>` : html`<span class="mn-btn off" aria-hidden="true">${icon("next", 18, 2.4)}</span>`}
</nav>`;

/** The month's accounts as plain text, ready to paste in the neighbours' WhatsApp group. */
function accountsText(tenant, period, books) {
  const lines = [
    `Cuentas de ${periodLabel(period)} · ${tenant.name}`,
    `Recaudado: ${peso(books.incomeCents)}`,
    `Gastado: ${peso(books.spentCents)}`,
    `Saldo del mes: ${peso(books.monthBalanceCents)}`,
    `Saldo en caja: ${peso(books.cashCents)}`,
  ];
  if (books.byCategory.length) lines.push("", "En qué se gastó:", ...books.byCategory.map((c) => `- ${c.category}: ${peso(c.cents)}`));
  return lines.join("\n");
}

const booksHero = (books, period) => html`<section class="hero" aria-label="Cuentas de ${periodLabel(period)}">
  <span class="eyebrow">Saldo en caja · fin de ${periodLabel(period).split(" ")[0]}</span>
  <span class="hero-number">${peso(books.cashCents)}</span>
  <div class="hero-stats">
    <div><b>${peso(books.incomeCents)}</b><span>recaudado</span></div>
    <div><b>${peso(books.spentCents)}</b><span>gastado</span></div>
    <div><b>${peso(books.monthBalanceCents)}</b><span>saldo del mes</span></div>
  </div>
</section>`;

const categoryBars = (books) => books.byCategory.length
  ? html`<ul class="catbars">${books.byCategory.map((c) => html`<li>
      <span class="row"><span>${c.category}</span><b>${peso(c.cents)}</b></span>
      <progress class="bar slim" max="${books.spentCents}" value="${c.cents}"></progress>
    </li>`)}</ul>`
  : "";

/** The treasurer's accounts: what came in, what went out, with the receipts, and who may see it. */
export function cuentasPage(args) {
  const { tenant, csrf, flash, period, current, books, expenses, categories, today, prev, next, publicLink } = args;
  const text = accountsText(tenant, period, books);
  return panelLayout("Cuentas", { ...args, active: "cuentas" }, html`
  <div class="head">
    <div class="head-text"><h1>Cuentas claras</h1><span class="muted">Lo que entra, lo que sale y el saldo en caja</span></div>
    <div class="head-actions">${monthNav("/panel/cuentas", period, prev, next)}</div>
  </div>
  ${flashBox(flash)}
  ${period !== current ? html`<p class="flash info" role="status">Estás viendo ${periodLabel(period)}. <a href="/panel/cuentas">Volver a este mes</a></p>` : ""}

  ${booksHero(books, period)}

  <section class="card">
    <div class="row wrap"><h2>Para compartir</h2></div>
    <p class="muted small">Pega este resumen en el grupo de vecinos de WhatsApp.</p>
    <pre class="share-text" id="resumen-cuentas">${text}</pre>
    <div class="actions">
      <button class="btn" type="button" data-copy="${text}" data-copy-target="#resumen-cuentas">Copiar resumen</button>
      <a class="btn ghost" href="https://wa.me/?text=${encodeURIComponent(text)}" rel="noopener noreferrer">Enviar por WhatsApp</a>
    </div>
  </section>

  <section class="card">
    <div class="row wrap"><h2>Gastos de ${periodLabel(period).split(" ")[0]}</h2><a class="small" href="/panel/cuentas.csv?mes=${period}">Descargar para Excel (CSV)</a></div>
    ${categoryBars(books)}
    ${expenses.length
      ? html`<ul class="list stack">${expenses.map((e) => html`<li class="expense${e.voided ? " voided" : ""}">
          <div class="row">
            <span><b>${e.description}</b><small class="muted">${shortDate(`${e.spentOn}T17:00:00.000Z`)} · ${e.category}${e.voided ? " · anulado" : ""}</small></span>
            <b class="amount">${peso(e.amountCents)}</b>
          </div>
          <div class="actions">
            ${e.hasProof ? html`<a class="small" href="/panel/gastos/${e.id}/soporte" target="_blank" rel="noopener">Ver soporte</a>` : html`<span class="muted small">Sin soporte</span>`}
            ${e.voided ? "" : html`<details class="undo"><summary>Anular</summary>
              <p class="muted small">El gasto no se borra: queda marcado como anulado y deja de contar en el saldo.</p>
              <form method="post" action="/panel/gastos/${e.id}/anular">${csrfField(csrf)}<button class="btn ghost small" type="submit">Sí, anular</button></form>
            </details>`}
          </div>
        </li>`)}</ul>`
      : html`<p class="muted">Aún no hay gastos en ${periodLabel(period)}.</p>`}
  </section>

  <section class="card" id="nuevo-gasto">
    <h2>Registrar un gasto</h2>
    <form class="stack-form" method="post" action="/panel/gastos" enctype="multipart/form-data">
      ${csrfField(csrf)}
      <div class="grid-form">
        <label>¿En qué se gastó?<input type="text" name="descripcion" maxlength="120" required placeholder="Pago del vigilante de noviembre"></label>
        <label>Valor (pesos)<input type="text" name="valor" inputmode="numeric" maxlength="14" required placeholder="1.200.000"></label>
        <label>Categoría<select name="categoria">${categories.map((c) => html`<option value="${c}">${c}</option>`)}</select></label>
        <label>Fecha<input type="date" name="fecha" value="${today}" max="${today}" required></label>
      </div>
      <label>Foto o PDF del soporte <span class="muted small">(opcional, máximo 5 MB)</span><input type="file" name="soporte" accept="image/jpeg,image/png,image/webp,application/pdf"></label>
      <button class="btn" type="submit">Registrar gasto</button>
    </form>
  </section>


  <section class="card" id="transparencia">
    <div class="row wrap"><h2>Página pública de transparencia</h2>${publicLink ? html`<span class="pill ok"><i></i>Activa</span>` : html`<span class="pill"><i></i>Apagada</span>`}</div>
    <p class="muted small">Un enlace que cualquiera puede abrir, sin entrar: muestra lo recaudado, lo gastado y el saldo de cada mes, y los gastos con su descripción. No muestra nombres de residentes, casas ni los archivos de soporte. Revisa que la descripción de tus gastos no lleve datos personales.</p>
    ${publicLink ? html`
      <div class="key url" id="enlace-publico">${publicLink}</div>
      <div class="actions">
        <button class="btn" type="button" data-copy="${publicLink}" data-copy-target="#enlace-publico">Copiar enlace</button>
        <a class="btn ghost" href="${publicLink}" target="_blank" rel="noopener">Ver la página</a>
        <a class="btn ghost" href="https://wa.me/?text=${encodeURIComponent(`Así van las cuentas de ${tenant.name}: ${publicLink}`)}" rel="noopener noreferrer">Enviar por WhatsApp</a>
      </div>
      <details class="undo"><summary>Cambiar el enlace</summary>
        <p class="muted small">Crea un enlace nuevo y el anterior deja de funcionar. Úsalo si el enlace llegó a quien no debía.</p>
        <form method="post" action="/panel/transparencia">${csrfField(csrf)}<input type="hidden" name="accion" value="cambiar"><button class="btn ghost small" type="submit">Sí, cambiar el enlace</button></form>
      </details>
      <details class="undo"><summary>Apagar la página</summary>
        <p class="muted small">El enlace deja de abrir algo. Puedes volver a activarla cuando quieras, con un enlace nuevo.</p>
        <form method="post" action="/panel/transparencia">${csrfField(csrf)}<input type="hidden" name="accion" value="apagar"><button class="btn ghost small" type="submit">Sí, apagarla</button></form>
      </details>`
    : html`<form method="post" action="/panel/transparencia">${csrfField(csrf)}<input type="hidden" name="accion" value="activar"><button class="btn" type="submit">Activar la página pública</button></form>`}
  </section>

  <section class="card" id="ajustes">
    <h2>Saldo inicial y quién lo ve</h2>
    <form class="stack-form" method="post" action="/panel/ajustes/cuentas">
      ${csrfField(csrf)}
      <label>Saldo con el que empiezas (pesos)<input type="text" name="saldo" inputmode="numeric" maxlength="14" value="${(tenant.openingCents / 100).toLocaleString("es-CO")}" placeholder="0"></label>
      <p class="muted small">Es el dinero que ya había en la cuenta antes de usar Cuotia. El saldo en caja es este valor, más todo lo recaudado, menos todos los gastos.</p>
      <label class="check"><input type="checkbox" name="mostrar" value="1"${tenant.showAccounts ? raw(" checked") : ""}><span><b>Mostrar las cuentas a los residentes.</b> Cada uno las ve desde su enlace personal: recaudado, gastado, saldo y los gastos con su soporte.</span></label>
      <button class="btn" type="submit">Guardar</button>
    </form>
  </section>`);
}

/** What a resident sees when the treasurer shares the accounts: totals and the expenses with their receipts. */
export function residentCuentasPage({ tenant, token, period, current, books, expenses, prev, next }) {
  const base = `/r/${token}/cuentas`;
  return layout("Cuentas del conjunto", html`
<main class="narrow res">
  <header class="backbar"><a href="/r/${token}" aria-label="Volver">${icon("back", 24, 2.2)}</a><h1>Cuentas del conjunto</h1></header>
  <div class="row wrap"><span class="muted">${tenant.name}</span>${monthNav(base, period, prev, next)}</div>
  ${booksHero(books, period)}
  <section class="card">
    <h2>En qué se gastó</h2>
    ${categoryBars(books)}
    ${expenses.length
      ? html`<ul class="list stack">${expenses.map((e) => html`<li class="expense">
          <div class="row"><span><b>${e.description}</b><small class="muted">${shortDate(`${e.spentOn}T17:00:00.000Z`)} · ${e.category}</small></span><b class="amount">${peso(e.amountCents)}</b></div>
          ${e.hasProof ? html`<a class="small" href="${base}/${e.id}/soporte" target="_blank" rel="noopener">Ver soporte</a>` : ""}
        </li>`)}</ul>`
      : html`<p class="muted">Aún no hay gastos registrados en ${periodLabel(period)}.</p>`}
  </section>
  <p class="muted small center-text">${period === current ? "Estas cuentas se actualizan cada vez que el tesorero registra un pago o un gasto." : ""}</p>
</main>`, { manifest: `/r/${token}/manifest.webmanifest` });
}


/** The public transparency page: totals and expenses of a month. No resident, no house, no receipt file, nothing to sign in to. */
export function transparenciaPage({ tenant, token, period, current, books, summary, expenses, prev, next }) {
  const base = `/t/${token}`;
  const houses = summary.paidCount + summary.pendingCount;
  return layout(`Transparencia · ${tenant.name}`, html`
<main class="narrow res">
  <header class="public-head"><span class="brand-line">${BRAND_MARK}</span><h1>Transparencia</h1><p class="muted">${tenant.name}</p></header>
  <div class="row wrap">${monthNav(base, period, prev, next)}</div>
  ${booksHero(books, period)}
  ${houses ? html`<section class="card">
    <h2>Cuotas de ${periodLabel(period)}</h2>
    <p><b>${summary.paidCount} de ${houses}</b> casas están al día · se ha recaudado ${peso(summary.collectedCents)} de ${peso(summary.expectedCents)}.</p>
    <progress class="bar" max="${summary.expectedCents || 1}" value="${summary.collectedCents}" aria-label="Recaudado"></progress>
  </section>` : ""}
  <section class="card">
    <h2>En qué se gastó</h2>
    ${categoryBars(books)}
    ${expenses.length
      ? html`<ul class="list stack">${expenses.map((e) => html`<li class="expense">
          <div class="row"><span><b>${e.description}</b><small class="muted">${shortDate(`${e.spentOn}T17:00:00.000Z`)} · ${e.category}</small></span><b class="amount">${peso(e.amountCents)}</b></div>
        </li>`)}</ul>`
      : html`<p class="muted">Aún no hay gastos registrados en ${periodLabel(period)}.</p>`}
  </section>
  <p class="muted small center-text">${period === current ? "Se actualiza cada vez que el tesorero registra un pago o un gasto. " : ""}Esta página no muestra nombres de residentes ni de casas.</p>
</main>`, { manifest: null, noindex: true });
}

/** What the conjunto charges: monthly concepts, and one-off charges (cuota extraordinaria, multa) for all houses or one. */
export function conceptosPage(args) {
  const { tenant, csrf, flash, concepts, houses, current, months } = args;
  const monthly = concepts.filter((c) => c.kind === "monthly");
  const once = concepts.filter((c) => c.kind === "once");
  const sum = monthly.filter((c) => c.active).reduce((n, c) => n + c.amountCents, 0);
  return panelLayout("Qué cobras", { ...args, active: "conceptos" }, html`
  <div class="heading"><h1>Qué cobras</h1><span class="muted">${tenant.name}</span></div>
  ${flashBox(flash)}

  <section class="card">
    <div class="row wrap"><h2>Cuotas mensuales</h2><span class="muted small">Cada casa paga ${peso(sum)} al mes</span></div>
    <p class="muted small">Se cobran todos los meses a todas las casas. Si cambias un valor, aplica a las cuotas que se creen desde ahora: las que ya existen no cambian.</p>
    <ul class="list stack">${monthly.map((c) => html`<li class="concept${c.active ? "" : " paused"}">
      <div class="row"><span><b>${c.name}</b><small class="muted">${c.active ? "Se cobra cada mes" : "En pausa: no se crean cuotas nuevas"}</small></span><b>${peso(c.amountCents)}</b></div>
      <div class="actions">
        <details class="undo"><summary>Cambiar valor</summary>
          <form class="stack-form" method="post" action="/panel/conceptos/${c.id}/valor">${csrfField(csrf)}
            <label>Nuevo valor (pesos)<input type="text" name="valor" inputmode="numeric" maxlength="14" required value="${(c.amountCents / 100).toLocaleString("es-CO")}"></label>
            <button class="btn small" type="submit">Guardar</button>
          </form>
        </details>
        <details class="undo"><summary>${c.active ? "Pausar" : "Reanudar"}</summary>
          <p class="muted small">${c.active ? "No se crean más cuotas de este cobro. Las que ya existen siguen y se pueden pagar." : "Vuelve a crear la cuota de este cobro cada mes."}</p>
          <form method="post" action="/panel/conceptos/${c.id}/estado">${csrfField(csrf)}<input type="hidden" name="activo" value="${c.active ? "0" : "1"}"><button class="btn ghost small" type="submit">Sí, ${c.active ? "pausar" : "reanudar"}</button></form>
        </details>
      </div>
    </li>`)}</ul>
    <form class="grid-form" method="post" action="/panel/conceptos">
      ${csrfField(csrf)}
      <label>Nuevo cobro mensual<input type="text" name="nombre" maxlength="60" required placeholder="Administración"></label>
      <label>Valor (pesos)<input type="text" name="valor" inputmode="numeric" maxlength="14" required placeholder="120.000"></label>
      <button class="btn" type="submit">Agregar cobro mensual</button>
    </form>
  </section>

  <section class="card" id="especial">
    <h2>Cobro especial</h2>
    <p class="muted small">Para una cuota extraordinaria (a todas las casas) o una multa (a una sola). Se crea una cuota por casa para el mes que elijas, y se paga como cualquier otra.</p>
    <form class="stack-form" method="post" action="/panel/conceptos/especial">
      ${csrfField(csrf)}
      <div class="grid-form">
        <label>Nombre<input type="text" name="nombre" maxlength="60" required placeholder="Arreglo del portón"></label>
        <label>Valor por casa (pesos)<input type="text" name="valor" inputmode="numeric" maxlength="14" required placeholder="45.000"></label>
        <label>Mes en que se cobra<select name="mes">${months.map((m) => html`<option value="${m}"${m === current ? raw(" selected") : ""}>${periodLabel(m)}</option>`)}</select></label>
      </div>
      <fieldset>
        <legend>¿A quién?</legend>
        <label class="check"><input type="radio" name="alcance" value="todas" checked><span><b>A todas las casas</b> (${houses.length})</span></label>
        <label class="check"><input type="radio" name="alcance" value="una"><span><b>Solo a una casa</b> (una multa, por ejemplo)</span></label>
        <div class="combo">
          <input type="search" class="combo-search" hidden data-select-filter="#casa-especial" placeholder="Buscar casa o nombre…" aria-label="Buscar la casa" autocomplete="off">
          <select id="casa-especial" name="casa" aria-label="Casa para el cobro"><option value="">Elegir casa…</option>${houseOptions(houses)}</select>
        </div>
      </fieldset>
      <button class="btn" type="submit">Crear el cobro</button>
    </form>
  </section>

  ${once.length
    ? html`<section class="card">
        <h2>Cobros especiales hechos</h2>
        <ul class="list stack">${once.map((c) => html`<li class="concept"><div class="row"><span><b>${c.name}</b><small class="muted">${c.period ? periodLabel(c.period) : ""} · ${c.dues} cuota${c.dues === 1 ? "" : "s"} · ${c.pending ? `${c.pending} sin pagar (${peso(c.pendingCents)})` : "todas pagadas"}</small></span><b>${peso(c.amountCents)}</b></div></li>`)}</ul>
      </section>`
    : ""}`);
}

/** "Empezar de cero": the confirmation screen. Shows what will be erased, asks for the password and the word. */
export function reiniciarPage(args) {
  const { tenant, csrf, flash, preview: p, withBackup } = args;
  const n = (count, one, many) => `${count} ${count === 1 ? one : many}`;
  return panelLayout("Empezar de cero", { ...args, active: "ajustes" }, html`
  <div class="heading"><h1>Empezar de cero</h1><span class="muted">${tenant.name}</span></div>
  <p><a href="/panel/ajustes">← Volver a Ajustes</a></p>
  ${flashBox(flash)}
  <section class="card danger-zone">
    <h2>Esto borra datos y no se puede deshacer</h2>
    <p>Úsalo para quitar las pruebas y empezar a cobrar desde este mes, con las cuentas limpias.</p>
    <h3>Se borra</h3>
    <ul class="check-list">
      <li>${n(p.dues, "cuota", "cuotas")} de todos los meses (las de este mes se vuelven a crear limpias)</li>
      <li>${n(p.payments, "pago", "pagos")} con sus recibos</li>
      <li>${n(p.proofs, "comprobante", "comprobantes")}</li>
      <li>${n(p.expenses, "gasto", "gastos")} de Cuentas claras</li>
      <li>${n(p.specialCharges, "cobro especial", "cobros especiales")} (cuotas extraordinarias y multas)</li>
      <li>Los códigos de paz y salvo y los recordatorios ya enviados</li>
    </ul>
    <h3>Se conserva</h3>
    <ul class="check-list">
      <li>Los ajustes: llave, fechas de pago, saldo inicial, conexión con pagoradar</li>
      <li>Los cobros mensuales (vigilancia, administración…) y sus valores</li>
      <li>El equipo, sus contraseñas y los avisos de sus celulares</li>
      <li>La bitácora, que anotará que empezaste de cero</li>
    </ul>
    <p class="muted small">${withBackup ? "Antes de borrar, Cuotia guarda una copia de seguridad de toda la base en el servidor. Si no la puede guardar, no borra nada." : "Esta instalación no guarda copia antes de borrar."}</p>

    <form class="stack-form" method="post" action="/panel/reiniciar" autocomplete="off">
      ${csrfField(csrf)}
      <fieldset>
        <legend>¿Qué pasa con las casas?</legend>
        <label class="check"><input type="radio" name="alcance" value="conservar" checked><span><b>Conservar las ${n(p.houses, "casa", "casas")}</b> con sus enlaces personales y nombres de pago (lo más común)</span></label>
        <label class="check"><input type="radio" name="alcance" value="todo"><span><b>Borrar también las casas</b>, sus enlaces, nombres de pago y avisos de celular: volverás a cargarlas</span></label>
      </fieldset>
      <label>Para confirmar escribe <b>BORRAR</b><input type="text" name="confirmar" required autocomplete="off" autocapitalize="characters" placeholder="BORRAR"></label>
      <label>Tu contraseña<input type="password" name="clave" required autocomplete="current-password"></label>
      <button class="btn danger" type="submit">Borrar y empezar de cero</button>
    </form>
  </section>`);
}

/** The editor of the WhatsApp messages: each one with its variables, a live preview and "back to the original". */
export function mensajesPage(args) {
  const { tenant, csrf, flash, focus = "", origin = "", error = "", draft = null } = args;
  const sample = (spec, key) => {
    const v = Object.fromEntries(Object.entries(spec.vars).map(([name, [example]]) => [name, example ?? ""]));
    return { ...v, conjunto: tenant.name, tesorero: tenant.sender ?? "Marta", como_pagar: paySummary(tenant, { asking: key === "recordatorio_casa" }) || "Pueden pagar por Nequi 300 123 4567.", plazo: tenant.dueDay ? deadlineText(tenant) : "El último día para pagar es el 10 de noviembre.", enlace: `${origin}/r/…` };
  };
  return panelLayout("Mensajes de WhatsApp", { ...args, active: "mensajes" }, html`
  <div class="heading"><h1>Mensajes de WhatsApp</h1><span class="muted">${tenant.name}</span></div>
  <p class="muted small">Estos son los textos que Cuotia deja escritos cuando tocas un botón de WhatsApp. Cámbialos a tu estilo: las palabras entre llaves, como <code>{nombre}</code>, se reemplazan por los datos de cada casa. Siempre puedes revisar el mensaje en WhatsApp antes de enviarlo.</p>
  ${flashBox(flash)}
  ${Object.entries(MESSAGES).map(([key, spec]) => {
    const custom = tenant.templates?.[key];
    const text = key === focus && draft !== null ? draft : custom ?? spec.default;
    const vars = sample(spec, key);
    return html`<section class="card message" id="${key}">
      <div class="row wrap"><h2>${spec.title}</h2>${custom ? html`<span class="pill info"><i></i>Personalizado</span>` : html`<span class="pill ok"><i></i>Original</span>`}</div>
      <p class="muted small">${spec.when}</p>
      ${key === focus && error ? html`<p class="alert" role="alert">${error}</p>` : ""}
      <form class="stack-form" method="post" action="/panel/mensajes/${key}">
        ${csrfField(csrf)}
        <label>Mensaje<textarea name="texto" rows="9" maxlength="1200" required data-msg data-vars="${JSON.stringify(vars)}" data-preview="#vista-${key}">${text}</textarea></label>
        <div class="msg-vars" aria-label="Variables que puedes usar">
          ${Object.entries(spec.vars).map(([name, [, help]]) => html`<button type="button" class="chip-var" data-insert="{${name}}" data-target-msg hidden title="${help}">{${name}}</button>`)}
        </div>
        <details class="undo"><summary>Qué significa cada variable</summary>
          <ul class="list">${Object.entries(spec.vars).map(([name, [, help]]) => html`<li><span><code>{${name}}</code><small class="muted">${help}${spec.required.includes(name) ? " · obligatoria" : ""}</small></span></li>`)}</ul>
        </details>
        <div><span class="eyebrow dim">Así se ve (con datos de ejemplo)</span><pre class="wa-preview" id="vista-${key}">${renderTemplate(text, vars)}</pre></div>
        <button class="btn" type="submit">Guardar mensaje</button>
      </form>
      ${custom ? html`<form method="post" action="/panel/mensajes/${key}/restablecer">${csrfField(csrf)}<button class="btn ghost small" type="submit">Volver al mensaje original</button></form>` : ""}
    </section>`;
  })}`);
}

/** The "Más" tab on a phone: what is not used every day. */
export function masPage(args) {
  const { tenant } = args;
  const item = (href, iconName, title, text) => html`<a class="card more-item" href="${href}">${icon(iconName, 24)}<span><b>${title}</b><small class="muted">${text}</small></span>${icon("next", 20, 2.4)}</a>`;
  return panelLayout("Más", { ...args, active: "mas" }, html`
  <div class="heading"><h1>Más</h1><span class="muted">${tenant.name}</span></div>
  ${item("/panel/cuentas", "cuentas", "Cuentas claras", "Gastos, saldo en caja y resumen para los vecinos")}
  ${item("/panel/conceptos", "cobrar", "Qué cobras", "Vigilancia, administración, cuotas extraordinarias y multas")}
  ${item("/panel/mensajes", "cuentas", "Mensajes de WhatsApp", "Cambia lo que dicen los recordatorios y el envío del enlace")}
  ${item("/panel/ajustes", "ajustes", "Ajustes", "Cuenta para cobrar, fechas, equipo y avisos")}
  ${item("/panel/bitacora", "bitacora", "Bitácora", "Quién hizo qué en el panel")}`);
}

/** Who did what: the conjunto's audit log, newest first. Read-only. */
export function bitacoraPage(args) {
  const { tenant, result, tipo, q, page, pages, actions } = args;
  const link = (extra = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries({ tipo, q, p: page, ...extra })) if (v && !(k === "p" && Number(v) <= 1)) qs.set(k, String(v));
    return `/panel/bitacora${qs.toString() ? `?${qs}` : ""}`;
  };
  return panelLayout("Bitácora", { ...args, active: "ajustes" }, html`
  <div class="heading"><h1>Bitácora</h1><span class="muted">${tenant.name} · ${result.total} registro${result.total === 1 ? "" : "s"}</span></div>
  <p><a href="/panel/ajustes">← Volver a Ajustes</a></p>
  <section class="card">
    <p class="muted small">Quién hizo qué en el panel. No se puede editar ni borrar. Nunca guarda contraseñas ni secretos, solo la frase de lo que se hizo.</p>
    <form class="filters" method="get" action="/panel/bitacora">
      <label>Tipo
        <select name="tipo"><option value="">Todos</option>${Object.entries(actions).map(([k, label]) => html`<option value="${k}"${tipo === k ? raw(" selected") : ""}>${label}</option>`)}</select>
      </label>
      <label>Buscar<input type="text" name="q" value="${q}" maxlength="60" placeholder="Nombre o texto"></label>
      <button class="btn wide" type="submit">Filtrar</button>
    </form>
  </section>
  <section class="card">
    ${result.rows.length
      ? html`<ul class="list stack">${result.rows.map((r) => html`<li class="audit">
          <span class="who"><b>${r.userName}</b><small class="muted">${shortDateTime(r.at)} · ${actions[r.action] ?? r.action}</small></span>
          <span class="audit-text">${r.summary}</span>
        </li>`)}</ul>
        ${pages > 1 ? html`<nav class="pager" aria-label="Páginas">
          ${page > 1 ? html`<a class="btn ghost small" href="${link({ p: page - 1 })}">← Más recientes</a>` : html`<span></span>`}
          <span class="muted small">Página ${page} de ${pages}</span>
          ${page < pages ? html`<a class="btn ghost small" href="${link({ p: page + 1 })}">Más antiguos →</a>` : html`<span></span>`}
        </nav>` : ""}`
      : html`<p class="muted">No hay registros con ese filtro.</p>`}
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

export function residentPage({ tenant, house, dues, period, token, proofs = [], pushKey = "", pushOn = 0, day = bogotaDay() }) {
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
      <span class="eyebrow">Tu cuota · ${periodLabel(period).split(" ")[0]}</span>
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

  <section class="card" data-push data-key="${pushKey}" data-subscribe-url="/r/${token}/avisos/suscribir" data-unsubscribe-url="/r/${token}/avisos/baja" data-resident>
    <h2>Avisos en este celular</h2>
    <p class="muted small">Te avisamos cuando se confirma tu pago${tenant.dueDay ? " y cuando se acerca el último día para pagar" : ""}.${pushOn ? " Ya están activos en un dispositivo." : ""} En iPhone, primero instala la app: Compartir, <b>Añadir a pantalla de inicio</b>, y ábrela desde ahí.</p>
    <p class="small" data-push-status role="status"></p>
    <button class="btn ghost" type="button" data-push-toggle>Activar avisos</button>
  </section>

  <section class="card">
    <h2>Mis documentos</h2>
    <ul class="list stack docs">
      <li><a class="strong" href="/r/${token}/estado">Estado de cuenta</a><small class="muted">Todo lo que has pagado y lo que debes</small></li>
      <li><a class="strong" href="/r/${token}/paz-y-salvo">Paz y salvo</a><small class="muted">Certificado, cuando no tienes cuotas vencidas</small></li>
    </ul>
  </section>

  ${tenant.showAccounts ? html`<a class="card cuentas-link" href="/r/${token}/cuentas"><span><b>Cuentas del conjunto</b><small class="muted">Qué se recaudó y en qué se gastó</small></span>${icon("next", 20, 2.4)}</a>` : ""}

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
  <header class="backbar"><a href="/r/${token}" aria-label="Volver">${icon("back", 24, 2.2)}</a><h1>Pagar mi cuota</h1></header>

  <section class="hero center-text" aria-label="Total a pagar">
    <span class="eyebrow">Total a pagar</span>
    <span class="hero-number">${peso(total)}</span>
    <span class="hero-sub">Casa ${house.code} · ${tenant.name}</span>
  </section>

  ${tenant.payKey || (tenant.payMethods ?? []).length
    ? html`${tenant.payKey ? html`<section class="card pay-method">
        <span class="eyebrow dim">Bre-B · llave</span>
        <p class="key" id="llave" translate="no">${tenant.payKey}</p>
        ${tenant.payHolder ? html`<p class="muted small">Titular: <b>${tenant.payHolder}</b></p>` : ""}
        <button class="btn" type="button" data-copy="${tenant.payKey}" data-copy-target="#llave">Copiar llave</button>
        <ol class="steps small">
          <li>Abre la app de tu banco o billetera.</li>
          <li>Elige pagar o transferir con <b>llave Bre-B</b>.</li>
          <li>Escribe la llave y el valor <b>exacto: ${peso(total)}</b>.</li>
        </ol>
      </section>` : ""}
      ${(tenant.payMethods ?? []).map((m) => html`<section class="card pay-method">
        <span class="eyebrow dim">${payMethodTitle(m)}</span>
        <p class="key" id="medio-${m.id}" translate="no">${payMethodAccount(m)}</p>
        ${m.holder ? html`<p class="muted small">A nombre de: <b>${m.holder}</b></p>` : ""}
        ${m.note ? html`<p class="small">${m.note}</p>` : ""}
        <button class="btn" type="button" data-copy="${m.account}" data-copy-target="#medio-${m.id}">Copiar ${m.kind === "bancolombia" ? "número de cuenta" : "número"}</button>
        <p class="muted small">Envía el valor <b>exacto: ${peso(total)}</b> y después sube tu comprobante.</p>
      </section>`)}`
    : html`<section class="card"><p>El tesorero aún no ha configurado cómo pagar. Escríbele para que te indique.</p></section>`}

  <section class="card">
    ${proofs.some((p) => p.status === "pending")
      ? html`<p>Tu comprobante está <b>en revisión</b>. <a href="/r/${token}/comprobante">Ver</a></p>`
      : tenant.payMode === "auto"
        ? html`<p><b>¿Ya pagaste?</b> Sube la foto del comprobante para que el tesorero lo confirme más rápido.</p><a class="btn ghost" href="/r/${token}/comprobante">Subir comprobante</a>`
        : html`<p><b>Después de pagar</b>, sube la foto del comprobante. El tesorero lo revisa y marca tu cuota como pagada.</p><a class="btn" href="/r/${token}/comprobante">Subir comprobante</a>`}
  </section>

  ${tenant.payMode === "auto"
    ? html`<p class="waiting" role="status"><span class="pulse"></span>Esperando tu pago. Esta pantalla se actualiza sola cuando el banco lo confirme.</p>`
    : html`<p class="note" role="status">Tu cuota queda <b>pagada</b> cuando el tesorero registre tu pago. Esta pantalla se actualiza cuando lo haga.</p>`}
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
</main>`, { bodyClass: "receipt-page", legal: false, manifest: `/r/${token}/manifest.webmanifest` });
}

// ---------------------------------------------------------------------------------------------------------------
// Printable documents: estado de cuenta and paz y salvo. "Guardar como PDF" is the browser's own print dialog.
// ---------------------------------------------------------------------------------------------------------------

const docShell = (title, tenant, body, { backHref, manifest } = {}) => layout(title, html`
<main class="doc">
  <div class="doc-actions noprint">
    ${backHref ? html`<a class="btn ghost" href="${backHref}">← Volver</a>` : ""}
    <button class="btn" type="button" data-print>Imprimir o guardar como PDF</button>
  </div>
  <article class="doc-sheet">
    <header class="doc-head"><span class="brand"><span class="brand-mark">${icon("check", 16, 3)}</span>cuotia</span><span class="muted small">${tenant.name}</span></header>
    ${body}
  </article>
</main>`, { bodyClass: "doc-page", legal: false, ...(manifest ? { manifest } : {}) });

const dueState = (d) => d.status === "paid"
  ? html`<span class="pill ok"><i></i>Pagada${d.paidAt ? ` el ${shortDate(d.paidAt)}` : ""}</span>`
  : d.late ? html`<span class="pill bad"><i></i>Vencida</span>` : html`<span class="pill warn"><i></i>Pendiente</span>`;

/** Every due of a house with what is paid and owed, as of today. */
export function estadoPage({ tenant, house, doc, backHref, manifest }) {
  return docShell("Estado de cuenta", tenant, html`
    <h1>Estado de cuenta</h1>
    <dl class="doc-meta">
      <div><dt>Casa</dt><dd>${house.code}</dd></div>
      <div><dt>Residente</dt><dd>${house.residentName}</dd></div>
      <div><dt>Fecha</dt><dd>${longDate(doc.today)}</dd></div>
    </dl>
    ${doc.rows.length
      ? html`<div class="table-wrap"><table class="doc-table">
          <thead><tr><th>Mes</th><th class="num">Valor</th><th>Estado</th></tr></thead>
          <tbody>${doc.rows.map((d) => html`<tr><td><b>${periodLabel(d.period)}</b><small class="muted">${d.conceptName}</small></td><td class="num">${peso(d.amountCents)}</td><td>${dueState(d)}</td></tr>`)}</tbody>
        </table></div>`
      : html`<p class="muted">Esta casa todavía no tiene cuotas.</p>`}
    <dl class="doc-totals">
      <div><dt>Total pagado</dt><dd>${peso(doc.paidCents)}</dd></div>
      <div><dt>Total pendiente</dt><dd>${peso(doc.pendingCents)}</dd></div>
      <div class="strong"><dt>De ello, vencido</dt><dd>${peso(doc.lateCents)}</dd></div>
    </dl>
    <p class="muted small">Generado por Cuotia con los pagos que ${tenant.name} tiene registrados al ${longDate(doc.today)}. No es una factura.</p>`, { backHref, manifest });
}

/** The certificate when the house has no overdue dues; otherwise what it owes and a way to the estado de cuenta. */
export function pazYSalvoPage({ tenant, house, doc, code, verifyUrl, backHref, estadoHref, manifest }) {
  if (!code) {
    return docShell("Paz y salvo", tenant, html`
      <h1>Paz y salvo</h1>
      <p class="flash err" role="status">Todavía no se puede emitir: la casa ${house.code} tiene <b>${peso(doc.lateCents)}</b> en cuotas vencidas.</p>
      <p>Cuando esas cuotas queden pagadas, este documento se genera solo. Mientras tanto puedes ver el detalle en el estado de cuenta.</p>
      <p class="noprint"><a class="btn" href="${estadoHref}">Ver el estado de cuenta</a></p>`, { backHref, manifest });
  }
  return docShell("Paz y salvo", tenant, html`
    <h1>Paz y salvo</h1>
    <p class="doc-lead">${tenant.name} certifica que, según los registros de Cuotia al <b>${longDate(doc.today)}</b>, la <b>casa ${house.code}</b>, a nombre de <b>${house.residentName}</b>, <b>no registra cuotas vencidas</b>.</p>
    <p class="muted small">Este certificado tiene validez a la fecha de su expedición y se genera con los pagos registrados por el tesorero. No sustituye el paz y salvo que exija una escritura o un contrato si el reglamento del conjunto pide otro formato.</p>
    <div class="doc-code">
      <span class="eyebrow dim">Código de verificación</span>
      <b class="doc-code-value" translate="no">${code}</b>
      <span class="muted small">Quien reciba este documento puede comprobarlo en <b>${verifyUrl}</b></span>
    </div>`, { backHref, manifest });
}

/** Public: what a code stands for. It never shows a name. */
export function verificarPage({ code = "", found = null, searched = false, error = "" }) {
  return layout("Verificar paz y salvo", html`
<main class="center">
  <form class="card login" method="get" action="/verificar">
    ${BRAND_MARK}
    <h1>Verificar paz y salvo</h1>
    <p class="muted">Escribe el código que aparece en el documento.</p>
    ${error ? html`<p class="alert" role="alert">${error}</p>` : ""}
    ${searched && found ? html`<p class="flash ok" role="status">Documento válido: <b>paz y salvo</b> de la <b>casa ${found.houseCode}</b> de <b>${found.tenantName}</b>, expedido el <b>${longDate(found.issuedOn)}</b>.</p><p class="muted small">Confirma que en esa fecha la casa no tenía cuotas vencidas. No dice cómo está hoy.</p>` : ""}
    ${searched && !found ? html`<p class="alert" role="alert">No encontramos ese código. Revísalo o pide un documento nuevo.</p>` : ""}
    <label>Código<input type="text" name="codigo" value="${code}" maxlength="12" autocomplete="off" autocapitalize="characters" placeholder="XXXXX-XXXXX" required></label>
    <button class="btn" type="submit">Verificar</button>
  </form>
</main>`);
}

/**
 * Política de tratamiento de datos personales (Ley 1581 de 2012). Public and the same for every conjunto: the conjunto is the
 * "responsable" and Cuotia the "encargado". It is a base text: the owner must have it reviewed before relying on it.
 */
export function privacidadPage({ contact = "" } = {}) {
  const ask = contact ? html`escribe a <b translate="no">${contact}</b> o pídeselo al tesorero de tu conjunto` : html`pídeselo al tesorero de tu conjunto`;
  return layout("Política de privacidad", html`
<main class="doc">
  <article class="doc-sheet legal-text">
    <header class="doc-head"><span class="brand"><span class="brand-mark">${icon("check", 16, 3)}</span>cuotia</span></header>
    <h1>Política de tratamiento de datos personales</h1>
    <p class="muted small">Ley 1581 de 2012 y Decreto 1377 de 2013. Última actualización: noviembre de 2026.</p>

    <h2>1. Quién es quién</h2>
    <p>El <b>responsable</b> de tus datos es el conjunto o urbanización donde vives, a través de su administración o tesorería: es quien decide qué datos se cargan y para qué. <b>Cuotia</b> es la herramienta con la que el conjunto lleva sus cuotas y actúa como <b>encargado</b>: trata los datos solo por cuenta del conjunto y siguiendo sus instrucciones.</p>

    <h2>2. Qué datos se tratan</h2>
    <ul>
      <li><b>De los residentes:</b> nombre, número de casa, celular (opcional), el historial de sus cuotas y pagos, el nombre con el que aparece el pago en el banco, los comprobantes que el propio residente sube y, si los activa, la suscripción a los avisos de su celular.</li>
      <li><b>Del equipo del conjunto (tesorería):</b> nombre, correo y un registro de lo que hace en el panel (bitácora).</li>
    </ul>
    <p>No se tratan datos sensibles, ni datos de menores de edad, ni se piden documentos de identidad, números de cuenta o claves bancarias. Los comprobantes pueden mostrar datos del banco de quien los sube: súbelos solo si estás de acuerdo.</p>

    <h2>3. Para qué se usan</h2>
    <ul>
      <li>Cobrar y conciliar las cuotas del conjunto y confirmar los pagos.</li>
      <li>Mostrarte lo que debes, tus recibos, tu estado de cuenta y tu paz y salvo.</li>
      <li>Enviarte avisos de tus pagos y recordatorios de vencimiento, si los activaste.</li>
      <li>Rendir cuentas del conjunto y mantener la seguridad del servicio.</li>
    </ul>

    <h2>4. Con quién se comparten</h2>
    <p>Tus datos no se venden ni se usan para publicidad. Solo los ve la administración de tu conjunto; los demás residentes no ven tus datos ni tus pagos (las "cuentas del conjunto", si la tesorería las muestra, solo traen totales y gastos). Para funcionar intervienen proveedores técnicos:</p>
    <ul>
      <li>El servicio donde está alojada la aplicación y el que protege su tráfico (hospedaje y red).</li>
      <li><b>pagoradar</b>, que lee el aviso del banco de la cuenta del conjunto y le informa a Cuotia el valor y el nombre del pagador.</li>
      <li>Los servicios de notificaciones del navegador o del teléfono (Google, Apple, Mozilla o Microsoft), solo si activas los avisos; el mensaje viaja cifrado.</li>
      <li>Un servicio de almacenamiento en la nube donde se guardan copias de seguridad de la base de datos, <b>cifradas</b>: quien las aloja no puede leerlas.</li>
    </ul>

    <h2>5. Cómo se protegen</h2>
    <p>Cada residente entra con un enlace personal secreto; cada conjunto solo accede a sus propios datos; el equipo entra con contraseña y verificación en dos pasos; las conexiones van cifradas; los cambios del panel quedan en una bitácora y se hacen copias de seguridad de la base de datos.</p>

    <h2>6. Cuánto tiempo se guardan</h2>
    <p>Mientras tu conjunto use Cuotia y mientras el conjunto necesite conservar el historial de cuotas y pagos para su contabilidad. Cuando una casa se da de baja, la tesorería puede borrar sus datos personales y dejar solo los valores del historial, sin nombre.</p>

    <h2>7. Tus derechos</h2>
    <p>Como titular puedes <b>conocer</b> tus datos, <b>actualizarlos y rectificarlos</b>, pedir <b>prueba de la autorización</b> que diste, ser <b>informado del uso</b> que se les da, <b>revocar la autorización o pedir la supresión</b> de tus datos cuando no haya un deber legal o contractual de conservarlos, y presentar quejas ante la Superintendencia de Industria y Comercio.</p>
    <p>Para ejercerlos ${ask}. Las consultas se responden en máximo 10 días hábiles y los reclamos en máximo 15 días hábiles, contados desde que se reciben (con las prórrogas que la ley permite).</p>

    <h2>8. Cambios</h2>
    <p>Si esta política cambia, se publica en esta misma dirección con la nueva fecha.</p>
  </article>
</main>`, { legal: false });
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
