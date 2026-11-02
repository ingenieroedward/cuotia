# Cuotia

Cobro de cuotas de **vigilancia** (y luego administración) para urbanizaciones y conjuntos. Cada vecino
paga por **Bre-B** y **pagoradar** confirma el pago leyendo el aviso del banco; Cuotia lleva el libro:
casas, cuotas, quién pagó y quién falta. Cada conjunto ve solo sus datos.

```
Residente ──Bre-B──▶ cuenta del conjunto ──aviso del banco──▶ pagoradar ──webhook firmado──▶ Cuotia
                                                                                              │
                                                       cuota marcada como pagada ◀────────────┘
```

## Cómo reconoce cada pago

La cuota se cobra **exacta** (ej. $30.000). Cuando llega el pago:

1. Si el nombre del pagador ya está asociado a una casa (por **alias** o por coincidencia única con el
   nombre del residente) **y** esa casa tiene una cuota abierta por ese monto → se marca pagada sola.
2. Si no, queda en **Por asignar**. El tesorero la asigna a una casa una vez y Cuotia **recuerda el nombre**:
   la próxima vez es automática.
3. Nunca adivina: un monto distinto, una casa dudosa o un nombre compartido esperan al tesorero.

## Desarrollo

Requiere Node ≥ 22.5. No tiene dependencias.

```bash
npm test
PAGORADAR_WEBHOOK_SECRET=dev MASTER_KEY=$(openssl rand -hex 32) PUBLIC_URL=http://localhost:3000 npm start
```

Crear el primer conjunto, una casa y las cuotas del mes:

```bash
npm run admin -- crear-conjunto --slug ibiza --nombre "Jardines de Ibiza" --correo tesorera@ejemplo.com --llave @llave --titular "Titular" --cuota 30000
npm run admin -- agregar-casa --conjunto ibiza --codigo 14 --residente "Sandra Duque" --telefono 3001234567
npm run admin -- generar-cuotas --conjunto ibiza
```

`crear-conjunto` imprime el **tenantRef** del conjunto: ponlo en la **cuenta receptora** de ese conjunto
en pagoradar (campo "referencia externa"). Así pagoradar le dice a Cuotia de qué conjunto es cada pago.

## Conectar con pagoradar

1. En el panel de pagoradar: **Apps → Nueva app** "Cuotia", con la URL del webhook
   `https://cuotia.tudominio.com/webhooks/pagoradar`. Copia su **secreto del webhook**.
2. Por cada conjunto, una **cuenta receptora** con su `tenantRef` (ver arriba) y el Gmail del titular
   reenviando los avisos del banco, como ya hace pagoradar.
3. En Cuotia, la variable `PAGORADAR_WEBHOOK_SECRET` con ese secreto.

Cuotia solo usa `payment.received`; ignora los demás eventos. Un pago repetido (reintento del webhook)
se registra una sola vez.

## Desplegar en Dokploy

*Create Service → Docker Compose* con este repositorio. Variables: `PAGORADAR_WEBHOOK_SECRET`,
`MASTER_KEY` (`openssl rand -hex 32`; **guárdala**: cifra el doble factor y sin ella nadie puede entrar), `PUBLIC_URL`. Dominio hacia el servicio `cuotia`, puerto **3000**, HTTPS. Los datos viven en el volumen
`cuotia-data` (`/app/data/cuotia.db`): respáldalo. Monitor a `/health`.

## El panel del tesorero

Entra con correo y contraseña y luego con un **código de 6 dígitos** de una app (Google Authenticator,
Microsoft Authenticator, 1Password…). La primera vez, Cuotia muestra la clave para agregarla. Desde el panel:

- **Resumen** del mes: recaudado, al día, pendientes.
- **Por asignar:** elige la casa de cada pago desconocido; Cuotia recuerda el nombre.
- **Generar cuotas** del mes, **pago en efectivo** y **Casas** (agregar, enlace personal por WhatsApp).

## Estado

Funcional para el piloto: base multi-conjunto con aislamiento probado, webhook firmado, conciliación por
alias, doble factor, panel completo y página del residente (responsive, claro y oscuro). Pendiente: passkeys,
editar casas, historial y CSV, tipografía propia, panel del operador, transparencia. Ver `CLAUDE.md`.
