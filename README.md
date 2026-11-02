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
PAGORADAR_WEBHOOK_SECRET=dev PUBLIC_URL=http://localhost:3000 npm start
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
`PUBLIC_URL`. Dominio hacia el servicio `cuotia`, puerto **3000**, HTTPS. Los datos viven en el volumen
`cuotia-data` (`/app/data/cuotia.db`): respáldalo. Monitor a `/health`.

## Estado

Esqueleto funcional: base multi-conjunto con aislamiento probado, webhook firmado, conciliación por
alias, login del tesorero, panel de lectura y página del residente. Pendiente: doble factor, acciones del
panel (asignar pagos, generar cuotas, pago en efectivo), tipografía propia, panel del operador y
página de transparencia. Ver `CLAUDE.md`.
