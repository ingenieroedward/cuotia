import { html, raw } from "./http.js";
import { qrSvg } from "./qr.js";
import { bankLabel, lastPeriods, peso, periodLabel, shortDate, shortDateTime } from "./text.js";

const BRAND_MARK = html`<span class="brand"><span class="brand-mark"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span>cuotia</span>`;

export function layout(title, body) {
  return html`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0B1B2B">
<title>${title} · Cuotia</title>
<link rel="stylesheet" href="/static/app.css">
</head>
<body>${body}</body>
</html>`;
}

/** Fixed messages the panel can show after an action. The query string only picks a key, never the text. */
const FLASH = {
  gen: (n) => ({ kind: "ok", text: n > 0 ? `Se crearon ${n} cuota${n === 1 ? "" : "s"} nueva${n === 1 ? "" : "s"}.` : "Las cuotas de este mes ya estaban creadas." }),
  asig: () => ({ kind: "ok", text: "Pago asignado y cuota marcada como pagada. Cuotia recordó el nombre." }),
  asigsin: () => ({ kind: "info", text: "Pago asignado, pero esa casa no tenía una cuota abierta por ese monto." }),
  efec: () => ({ kind: "ok", text: "Pago en efectivo registrado." }),
  dup: () => ({ kind: "err", text: "Ya existe una casa con ese código." }),
  ed: () => ({ kind: "ok", text: "Datos de la casa guardados." }),
  aliasok: () => ({ kind: "ok", text: "Nombre agregado: los pagos con ese nombre se asignarán a esta casa." }),
  aliasdel: () => ({ kind: "ok", text: "Nombre quitado." }),
  desact: () => ({ kind: "ok", text: "Casa desactivada. Su historial se conserva." }),
  react: () => ({ kind: "ok", text: "Casa reactivada." }),
  undo: () => ({ kind: "ok", text: "Asignación deshecha: el pago volvió a “Por asignar” y la cuota a pendiente." }),
  undoc: () => ({ kind: "ok", text: "Pago en efectivo anulado: la cuota volvió a pendiente." }),
  sec: () => ({ kind: "ok", text: "Secreto de pagoradar guardado. Envía un evento de prueba desde pagoradar para confirmar la conexión." }),
  secbad: () => ({ kind: "err", text: "El secreto debe tener entre 8 y 200 caracteres y no puede llevar espacios." }),
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

function topbar({ user, csrf, active }) {
  return html`<header class="topbar">
  ${BRAND_MARK}
  <nav class="tabs" aria-label="Principal">
    <a href="/panel"${active === "resumen" ? raw(' aria-current="page"') : ""}>Resumen</a>
    <a href="/panel/casas"${active === "casas" ? raw(' aria-current="page"') : ""}>Casas</a>
    <a href="/panel/pagos"${active === "pagos" ? raw(' aria-current="page"') : ""}>Pagos</a>
    <a href="/panel/ajustes"${active === "ajustes" ? raw(' aria-current="page"') : ""}>Ajustes</a>
  </nav>
  <div class="topbar-end">
    <span class="muted small">${user.email}</span>
    <form method="post" action="/logout">${csrfField(csrf)}<button class="btn ghost" type="submit">Salir</button></form>
  </div>
</header>`;
}

const STATUS = {
  paid: html`<span class="pill ok"><i></i>Pagado</span>`,
  pending: html`<span class="pill warn"><i></i>Pendiente</span>`,
};

const houseOptions = (houses) => houses.map((h) => html`<option value="${h.id}">Casa ${h.code} · ${h.residentName}</option>`);

export function panelPage({ tenant, user, csrf, flash, summary, dues, unassigned, houses }) {
  const pct = summary.expectedCents ? Math.round((summary.collectedCents / summary.expectedCents) * 100) : 0;
  const owing = houses.filter((h) => dues.some((d) => d.houseId === h.id && d.status === "pending"));
  return layout("Resumen", html`
${topbar({ user, csrf, active: "resumen" })}
<main class="page">
  <div class="heading">
    <h1>${tenant.name}</h1>
    <span class="muted">${periodLabel(summary.period)}</span>
  </div>
  ${flashBox(flash)}

  <section class="hero" aria-label="Resumen del mes">
    <span class="eyebrow">Recaudado</span>
    <span class="hero-number">${peso(summary.collectedCents)}</span>
    <span class="hero-sub">de ${peso(summary.expectedCents)} esperados · ${pct} %</span>
    <progress class="bar" max="100" value="${pct}" aria-label="Porcentaje recaudado">${pct} %</progress>
    <div class="hero-stats">
      <div><b>${summary.paidCount}</b><span>al día</span></div>
      <div><b>${summary.pendingCount}</b><span>pendientes</span></div>
    </div>
  </section>

  ${unassigned.length
    ? html`<section class="card" id="por-asignar">
        <h2>Por asignar <span class="count">${unassigned.length}</span></h2>
        <p class="muted small">Estos pagos entraron a la cuenta pero el nombre no coincide con ninguna casa. Asígnalos una vez y Cuotia recordará el nombre.</p>
        <ul class="list stack">${unassigned.map((p) => html`<li>
          <div class="row"><span><b>${p.payerName || "Sin nombre"}</b><small class="muted">${bankLabel(p.bank)} · ${shortDate(p.paidAt)}</small></span><b>${peso(p.amountCents)}</b></div>
          <form class="assign" method="post" action="/panel/pagos/${p.id}/asignar">
            ${csrfField(csrf)}
            <select name="house" required aria-label="Casa de ${p.payerName}"><option value="">Elegir casa…</option>${houseOptions(houses)}</select>
            <label class="check"><input type="checkbox" name="remember" value="1" checked> Recordar nombre</label>
            <button class="btn small" type="submit">Asignar</button>
          </form>
        </li>`)}</ul>
      </section>`
    : ""}

  <section class="card">
    <div class="row wrap">
      <h2>Casas</h2>
      <form method="post" action="/panel/cuotas/generar">${csrfField(csrf)}<button class="btn ghost small" type="submit">Generar cuotas de ${periodLabel(summary.period)}</button></form>
    </div>
    ${dues.length === 0
      ? html`<p class="muted">Aún no hay cuotas para este mes. Pulsa “Generar cuotas”.</p>`
      : html`<div class="table-wrap"><table>
      <thead><tr><th>Casa</th><th>Residente</th><th>Estado</th><th class="num">Monto</th></tr></thead>
      <tbody>${dues.map((d) => html`<tr><td><b>${d.houseCode}</b></td><td>${d.residentName}</td><td>${STATUS[d.status]}</td><td class="num"><b>${peso(d.amountCents)}</b></td></tr>`)}</tbody>
    </table></div>`}
  </section>

  ${owing.length
    ? html`<section class="card">
        <h2>Pago en efectivo</h2>
        <p class="muted small">Si un vecino te pagó en mano, regístralo para dejar su cuota al día.</p>
        <form class="assign" method="post" action="/panel/efectivo">
          ${csrfField(csrf)}
          <select name="house" required aria-label="Casa que pagó en efectivo"><option value="">Elegir casa…</option>${houseOptions(owing)}</select>
          <button class="btn small" type="submit">Registrar efectivo</button>
        </form>
      </section>`
    : ""}
</main>`);
}

export function casasPage({ tenant, user, csrf, flash, houses, inactive = [] }) {
  return layout("Casas", html`
${topbar({ user, csrf, active: "casas" })}
<main class="page">
  <div class="heading"><h1>Casas</h1><span class="muted">${tenant.name} · ${houses.length} casa${houses.length === 1 ? "" : "s"}</span></div>
  ${flashBox(flash)}

  <section class="card">
    <h2>Agregar casa</h2>
    <form class="grid-form" method="post" action="/panel/casas">
      ${csrfField(csrf)}
      <label>Código<input type="text" name="code" maxlength="12" required placeholder="14"></label>
      <label>Residente<input type="text" name="residente" maxlength="80" required placeholder="Sandra Duque"></label>
      <label>Celular (opcional)<input type="tel" name="telefono" maxlength="20" inputmode="tel" placeholder="3001234567"></label>
      <button class="btn" type="submit">Agregar y ver enlace</button>
    </form>
  </section>

  <section class="card">
    <h2>Listado</h2>
    ${houses.length === 0
      ? html`<p class="muted">Aún no hay casas.</p>`
      : html`<ul class="list">${houses.map((h) => html`<li>
        <span><b>Casa ${h.code}</b><small class="muted">${h.residentName}${h.phone ? ` · ${h.phone}` : ""}</small></span>
        <span class="actions">
          <a class="btn ghost small" href="/panel/casas/${h.id}">Editar</a>
          <form method="post" action="/panel/casas/${h.id}/enlace">${csrfField(csrf)}<button class="btn ghost small" type="submit">Enlace</button></form>
        </span>
      </li>`)}</ul>`}
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
    : ""}
</main>`);
}

export function ajustesPage({ tenant, user, csrf, flash, webhookUrl }) {
  return layout("Ajustes", html`
${topbar({ user, csrf, active: "ajustes" })}
<main class="page">
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
    <h2>Cuenta para cobrar</h2>
    <p class="small">Llave Bre-B: <b>${tenant.payKey ?? "sin configurar"}</b>${tenant.payHolder ? html` · Titular: <b>${tenant.payHolder}</b>` : ""}</p>
    <p class="muted small">Es la que ven los residentes en su enlace personal.</p>
  </section>
</main>`);
}


const payMethod = (p) => (p.method === "cash" ? "Efectivo" : bankLabel(p.bank));
const PAY_STATUS = {
  assigned: html`<span class="pill ok"><i></i>Asignado</span>`,
  unassigned: html`<span class="pill info"><i></i>Por asignar</span>`,
};

/** The undo control: a <details> so a stray tap never undoes anything and no script is needed. */
const undoControl = (p, csrf) => html`<details class="undo">
  <summary>Deshacer</summary>
  <p class="muted small">${p.method === "cash"
    ? "Se anula este pago en efectivo y la cuota vuelve a pendiente."
    : "El pago vuelve a “Por asignar”, la cuota queda pendiente y Cuotia olvida el nombre que aprendió para esta casa."}</p>
  <form method="post" action="/panel/pagos/${p.id}/deshacer">${csrfField(csrf)}<button class="btn ghost small" type="submit">Sí, deshacer</button></form>
</details>`;

export function pagoItem(p, csrf) {
  return html`<li class="pay">
    <div class="row">
      <span>
        <b>${p.payerName || "Sin nombre"}</b>
        <small class="muted">${shortDateTime(p.paidAt)}${p.method === "cash" ? "" : ` · ${payMethod(p)}`}${p.houseCode ? ` · Casa ${p.houseCode}` : ""}${p.duePeriod ? ` · ${p.conceptName} ${periodLabel(p.duePeriod)}` : ""}</small>
      </span>
      <span class="amount"><b>${peso(p.amountCents)}</b>${PAY_STATUS[p.status]}</span>
    </div>
    ${p.status === "assigned" ? undoControl(p, csrf) : html`<a class="small" href="/panel#por-asignar">Asignar a una casa →</a>`}
  </li>`;
}

export function pagosPage({ tenant, user, csrf, flash, result, filters, page, pages, period }) {
  const link = (extra = {}) => {
    const qs = new URLSearchParams();
    const all = { ...filters, ...extra };
    for (const [k, v] of Object.entries(all)) if (v !== undefined && v !== null && v !== "" && !(k === "p" && Number(v) <= 1)) qs.set(k, String(v));
    const text = qs.toString();
    return text ? `?${text}` : "";
  };
  return layout("Pagos", html`
${topbar({ user, csrf, active: "pagos" })}
<main class="page">
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
      <label>Buscar<input type="text" name="q" value="${filters.q ?? ""}" maxlength="60" placeholder="Nombre, casa o residente"></label>
      <button class="btn" type="submit">Filtrar</button>
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
  </section>
</main>`);
}

export function casaPage({ tenant, user, csrf, flash, house, aliases, dues, payments }) {
  return layout(`Casa ${house.code}`, html`
${topbar({ user, csrf, active: "casas" })}
<main class="page">
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
  </section>
</main>`);
}

/** Shown once after creating a house or rotating its link: only the token's hash is stored. */
export function linkPage({ user, csrf, house, url, whatsapp }) {
  return layout("Enlace personal", html`
${topbar({ user, csrf, active: "casas" })}
<main class="narrow">
  <h1>Casa ${house.code}</h1>
  <p class="muted">${house.residentName}</p>
  <section class="card">
    <h2>Enlace personal</h2>
    <p class="small">Envíaselo al residente: ahí ve su cuota y cómo pagar. <b>Solo se muestra ahora</b>; si lo pierdes, genera uno nuevo (el anterior deja de servir).</p>
    <p class="key url" translate="no">${url}</p>
    ${whatsapp ? html`<a class="btn" href="${whatsapp}" rel="noopener noreferrer">Enviar por WhatsApp</a>` : ""}
    <a class="btn ghost" href="/panel/casas">Volver a casas</a>
  </section>
</main>`);
}

export function residentPage({ tenant, house, dues, period }) {
  const current = dues.filter((d) => d.period === period);
  const open = current.filter((d) => d.status === "pending");
  const total = open.reduce((s, d) => s + d.amountCents, 0);
  return layout("Mi cuota", html`
<main class="narrow">
  <header class="topbar plain">${BRAND_MARK}<span class="chip">Casa ${house.code}</span></header>
  <h1>Hola, ${house.residentName.split(" ")[0]}</h1>
  <p class="muted">${tenant.name}</p>

  <section class="hero" aria-label="Tu cuota">
    <span class="eyebrow">${periodLabel(period)}</span>
    ${open.length
      ? html`<span class="hero-number">${peso(total)}</span><span class="hero-sub">${open.map((d) => d.conceptName).join(" + ")}</span>`
      : html`<span class="hero-number">Al día</span><span class="hero-sub">No tienes cuotas pendientes este mes. ¡Gracias!</span>`}
  </section>

  ${open.length && tenant.payKey
    ? html`<section class="card">
        <h2>Cómo pagar</h2>
        <p>Paga <b>${peso(total)}</b> exactos por Bre-B a la llave:</p>
        <p class="key">${tenant.payKey}</p>
        ${tenant.payHolder ? html`<p class="muted small">Titular: ${tenant.payHolder}</p>` : ""}
        <p class="muted small">Cuando el banco confirme, tu cuota se marca sola.</p>
      </section>`
    : ""}

  <section class="card">
    <h2>Tus cuotas</h2>
    <ul class="list">${dues.map((d) => html`<li><span><b>${d.conceptName}</b><small class="muted">${periodLabel(d.period)}</small></span>${STATUS[d.status]}</li>`)}</ul>
  </section>
</main>`);
}

export function notFoundPage() {
  return layout("No encontrado", html`<main class="center"><div class="card"><h1>No encontrado</h1><p class="muted">Este enlace no existe o ya no está activo.</p></div></main>`);
}
