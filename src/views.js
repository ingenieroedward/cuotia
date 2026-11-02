import { html } from "./http.js";
import { peso, periodLabel } from "./text.js";

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
    <button class="btn" type="submit">Entrar</button>
  </form>
</main>`);
}

const STATUS = {
  paid: html`<span class="pill ok"><i></i>Pagado</span>`,
  pending: html`<span class="pill warn"><i></i>Pendiente</span>`,
};

export function panelPage({ tenant, user, summary, dues, unassigned }) {
  const pct = summary.expectedCents ? Math.round((summary.collectedCents / summary.expectedCents) * 100) : 0;
  return layout("Resumen", html`
<header class="topbar">
  ${BRAND_MARK}
  <div class="topbar-end">
    <span class="muted small">${user.email}</span>
    <form method="post" action="/logout"><button class="btn ghost" type="submit">Salir</button></form>
  </div>
</header>
<main class="page">
  <div class="heading">
    <h1>${tenant.name}</h1>
    <span class="muted">${periodLabel(summary.period)}</span>
  </div>

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

  ${summary.unassignedCount
    ? html`<section class="callout"><b>${summary.unassignedCount} pago${summary.unassignedCount === 1 ? "" : "s"} por asignar</b>
        <span>${peso(summary.unassignedCents)} entraron sin una casa asociada.</span></section>`
    : ""}

  <section class="card">
    <h2>Casas</h2>
    ${dues.length === 0
      ? html`<p class="muted">Aún no hay cuotas para este mes.</p>`
      : html`<div class="table-wrap"><table>
      <thead><tr><th>Casa</th><th>Residente</th><th>Estado</th><th class="num">Monto</th></tr></thead>
      <tbody>${dues.map((d) => html`<tr><td><b>${d.houseCode}</b></td><td>${d.residentName}</td><td>${STATUS[d.status]}</td><td class="num"><b>${peso(d.amountCents)}</b></td></tr>`)}</tbody>
    </table></div>`}
  </section>
  ${unassigned.length
    ? html`<section class="card"><h2>Por asignar</h2><ul class="list">${unassigned.map((p) => html`<li><span><b>${p.payerName || "Sin nombre"}</b><small class="muted">${p.bank ?? ""} · ${p.paidAt.slice(0, 10)}</small></span><b>${peso(p.amountCents)}</b></li>`)}</ul></section>`
    : ""}
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
