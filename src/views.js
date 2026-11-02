import { html, raw } from "./http.js";
import { bankLabel, peso, periodLabel, shortDate } from "./text.js";

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
  err: () => ({ kind: "err", text: "No se pudo completar la acción. Revisa los datos e inténtalo de nuevo." }),
};
export function flashOf(query) {
  const make = FLASH[query.get("m")];
  const n = Number.parseInt(query.get("n") ?? "0", 10);
  return make ? make(Number.isSafeInteger(n) && n >= 0 ? n : 0) : null;
}
const flashBox = (f) => (f ? html`<p class="flash ${f.kind}" role="status">${f.text}</p>` : "");

const csrfField = (csrf) => html`<input type="hidden" name="_csrf" value="${csrf}">`;

export function loginPage({ error } = {}) {
  return layout("Entrar", html`
<main class="center">
  <form class="card login" method="post" action="/login">
    ${BRAND_MARK}
    <h1>Entrar</h1>
    <p class="muted">Panel del tesorero</p>
    ${error ? html`<p class="alert" role="alert">${error}</p>` : ""}
    <label>Correo<input type="email" name="email" autocomplete="username" required autofocus></label>
    <label>Contraseña<input type="password" name="password" autocomplete="current-password" required></label>
    <button class="btn" type="submit">Continuar</button>
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
          <li>En la app elige <b>agregar cuenta</b> y escribe esta clave:</li>
        </ol>
        <p class="key secret" translate="no">${grouped}</p>
        <p class="small"><a href="${uri}">Abrir directamente en mi app</a> <span class="muted">(en el celular)</span></p>
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

export function casasPage({ tenant, user, csrf, flash, houses }) {
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
        <form method="post" action="/panel/casas/${h.id}/enlace">${csrfField(csrf)}<button class="btn ghost small" type="submit">Enlace personal</button></form>
      </li>`)}</ul>`}
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
