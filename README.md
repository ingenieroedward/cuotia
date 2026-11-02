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
MASTER_KEY=$(openssl rand -hex 32) PUBLIC_URL=http://localhost:3000 npm start
```

## Primer conjunto

La primera vez, con la base vacía, Cuotia imprime en el **log** un enlace privado de un solo uso:

```
Aún no hay conjuntos. Crea el primero en: https://cuotia.tudominio.com/setup?token=…
```

Ábrelo: un formulario te deja crear el conjunto (nombre, cuota, llave Bre-B, titular) y la cuenta del tesorero con
**su propia contraseña**. En cuanto existe un conjunto, ese enlace deja de funcionar para siempre. El token se genera
en cada arranque; si prefieres uno fijo, define `SETUP_TOKEN` (mínimo 16 caracteres). En Dokploy, el enlace está en
los **logs** del servicio.

No hay registro abierto: los demás conjuntos los crea el operador (por ahora con el script).

Por terminal, también se puede crear el conjunto, una casa y las cuotas del mes:

```bash
npm run admin -- crear-conjunto --slug ibiza --nombre "Jardines de Ibiza" --correo tesorera@ejemplo.com --llave @llave --titular "Titular" --cuota 30000
npm run admin -- agregar-casa --conjunto ibiza --codigo 14 --residente "Sandra Duque" --telefono 3001234567
npm run admin -- generar-cuotas --conjunto ibiza
```

`crear-conjunto` imprime la **URL del webhook** de ese conjunto (ver abajo).

## Conectar con pagoradar (una conexión por conjunto)

Cada conjunto tiene **su propia app en pagoradar, su propia URL de webhook y su propio secreto**; nada se
comparte entre conjuntos.

1. Cuotia da a cada conjunto una URL: `https://cuotia.tudominio.com/webhooks/pagoradar/<id-del-conjunto>`
   (la imprime `crear-conjunto` y aparece en **Ajustes** del panel).
2. En el panel de pagoradar de ese conjunto: **Apps → Nueva app** con esa URL como webhook, y una **cuenta
   receptora** con el Gmail del titular reenviando los avisos del banco (como ya hace pagoradar).
3. Copia el **secreto del webhook** de esa app y pégalo en **Ajustes** de Cuotia (o usa
   `MASTER_KEY=… npm run admin -- configurar-pagoradar --conjunto ibiza --secreto …`). Se guarda **cifrado** y
   no se vuelve a mostrar.
4. Envía el **evento de prueba** desde pagoradar: Ajustes pasa a **Conectado · último aviso …**.

La firma de cada aviso se verifica con el secreto del conjunto de la URL: el secreto de un conjunto no sirve en
la URL de otro. Si la cuenta de pagoradar lleva un `tenantRef`, debe ser el id del conjunto (opcional).
Cuotia solo usa `payment.received`; los demás eventos solo confirman la conexión. Un pago repetido
(reintento del webhook) se registra una sola vez. Mientras un conjunto no tenga secreto, su URL responde
503 y pagoradar reintenta.

## Desplegar en Dokploy

*Create Service → Docker Compose* con este repositorio. Variables:
`MASTER_KEY` (`openssl rand -hex 32`; **guárdala**: cifra el doble factor y sin ella nadie puede entrar), `PUBLIC_URL`, y
opcionalmente `SETUP_TOKEN`. Dominio hacia el servicio `cuotia`, puerto **3000**, HTTPS. Los datos viven en el volumen
`cuotia-data` (`/app/data/cuotia.db`): respáldalo. Monitor a `/health`.

Si el log dice `SQLITE_CANTOPEN` o `readonly database`, el volumen quedó con otro dueño (Cuotia corre como el usuario
`node`, uid 1000). Se arregla una vez, con el servicio detenido:

```sh
docker run --rm -v cuotia-data:/d alpine chown -R 1000:1000 /d
```

Cloudflare: con el proxy activo, pon SSL/TLS en **Full (strict)**.

## El panel del tesorero

Entra con correo y contraseña y luego con un **código de 6 dígitos** de una app (Google Authenticator,
Microsoft Authenticator, 1Password…). La primera vez, Cuotia muestra un **código QR** para escanear con la cámara de la app (y, debajo, la misma clave escrita por si no se puede escanear). Desde el panel:

- **Resumen** del mes: recaudado, al día, pendientes.
- **Por asignar:** elige la casa de cada pago desconocido; Cuotia recuerda el nombre.
- **Generar cuotas** del mes, **pago en efectivo** y **Casas**: agregar, **editar** (código, residente, celular),
  agregar o quitar los **nombres con los que paga** cada casa, **desactivar** y reactivar, y el enlace personal por WhatsApp.
- **Pagos:** historial con filtros (mes, estado, búsqueda), páginas, **descarga para Excel (CSV)** y **Deshacer**: una
  asignación equivocada vuelve a “Por asignar” (y Cuotia olvida el nombre), un pago en efectivo se anula.

## Cómo se ve

El panel sigue el diseño aprobado: en computador, una **barra lateral oscura** (Resumen, Casas, Pagos, Por asignar,
Ajustes) con el conjunto abajo; en celular, una **barra inferior**. El **Resumen** muestra el saludo, lo recaudado
(y lo de la semana), lo que falta con un botón de **recordatorio por WhatsApp** ya escrito con las casas pendientes,
los pagos por asignar, la tabla de casas (filtrable) y los últimos pagos.

El residente ve su cuota, **Pagar ahora** (la llave Bre-B para copiar y el valor exacto; la pantalla se actualiza sola
cuando el banco confirma) y su **recibo** (descargable en PDF desde el navegador).

La tipografía (Plus Jakarta Sans, licencia OFL) se sirve desde el propio servidor.

## Estado

Funcional para el piloto: base multi-conjunto con aislamiento probado, webhook firmado, conciliación por
alias, doble factor, panel completo y página del residente (responsive, claro y oscuro). Pendiente: passkeys,
tipografía propia, panel del operador, transparencia. Ver `CLAUDE.md`.
