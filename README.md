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

## Cada mes: cobrar

Las cuotas son mensuales y Cuotia lleva la cuenta mes a mes:

- **Por cobrar** (menú): quién debe, **desde cuándo** (chips `oct`, `nov`… en rojo si son de meses anteriores), cuánto, y dos
  botones por casa: **Registrar pago** y **WhatsApp** (un recordatorio personal ya escrito, con sus meses y la llave Bre-B).
  Se filtra por *Atrasadas* o *Solo este mes* y se busca por casa o nombre. El menú muestra cuántas casas deben.
- **Resumen:** el mes se cambia con las flechas (‹ noviembre 2026 ›). Cada casa que no ha pagado tiene su botón **Registrar pago**
  en la propia fila (ya con esa cuota marcada). Una casa que debe meses anteriores dice **"Debe 2 meses"**, y una tarjeta roja
  suma lo **atrasado**. "Para cobrar primero" lista las cinco casas con la deuda más vieja.
- **Casas:** cada casa muestra si está **al día** o cuánto **debe**, con el botón de cobrar; se puede buscar.
- **Registrar pago:** eliges la casa tocándola (solo salen las que deben algo), marcas qué meses cubre (o *Marcar todas*) y listo;
  al terminar vuelves a *Por cobrar* para seguir con la siguiente.

## Operación diaria

- **Las cuotas del mes se crean solas.** Cuotia las genera al arrancar y revisa cada hora (no duplica nada), así que el día 1
  nadie tiene que pulsar un botón y un pago que llegue temprano ya encuentra su cuota. Una casa nueva o reactivada recibe la
  suya al instante. "Generar cuotas" sigue ahí por si lo necesitas.
- **Importar casas.** En **Casas → Importar varias casas**: pega una lista desde Excel o Google Sheets (`código`, `nombre`,
  `celular`; una por línea). Cuotia crea las casas, sus cuotas y un **enlace personal** para cada una, con botón de WhatsApp.
  Los enlaces se muestran **una sola vez**.
- **Pagos manuales (con o sin pagoradar).** En **Pagos → Registrar pago**: elige la casa, marca **uno o varios meses** que cubre,
  cómo pagó (efectivo, transferencia u otro, con el banco si quieres), la **fecha** en que pagó y una nota. Queda en el historial y
  en el recibo del vecino, y se puede **deshacer**. Sirve para el efectivo, para cuando aún no conectas pagoradar o cuando un aviso
  del banco no llegó. Pagoradar es opcional.
- **Ajustes:** cambia la llave Bre-B y el titular que ven los residentes, el secreto de pagoradar y tu contraseña (al cambiarla
  se cierran las sesiones de otros dispositivos).
- **Perdí el celular del código / la contraseña** (lo hace quien administra el servidor, desde la terminal del contenedor):

  ```bash
  npm run admin -- restablecer-2fa --correo tesorera@ejemplo.com     # la próxima vez activa un código nuevo
  npm run admin -- restablecer-clave --correo tesorera@ejemplo.com   # imprime una contraseña temporal
  ```

### Respaldos

Cuotia guarda todo en un solo archivo (`/app/data/cuotia.db`). Para sacar una copia consistente **sin detener la app**:

```bash
npm run admin -- respaldar            # crea data/backups/cuotia-AAAAMMDD-HHMMSS.db y conserva las últimas 14
npm run admin -- respaldar --conservar 30
```

Desde el servidor, sin entrar al contenedor: `docker exec $(docker ps -qf name=cuotia) npm run admin -- respaldar`.
Prográmalo cada día (cron del servidor o una tarea programada de Dokploy). **Ojo:** el respaldo queda en el mismo disco que la
base; copia la carpeta `backups` a otro lugar (otro servidor, tu computador, la nube) o no te protege de perder el disco.
Y guarda `MASTER_KEY` aparte: sin ella, un respaldo no sirve para entrar.

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
- **Registrar pago** a mano (efectivo, transferencia…), uno o varios meses.
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

## Instalar como app (PWA)

Cuotia se puede instalar en el celular como una app, con su ícono y a pantalla completa. Hace falta abrirla por **https**.

- **Android (Chrome):** menú ⋮ → **Instalar app** (o "Agregar a la pantalla de inicio").
- **iPhone (Safari):** botón Compartir → **Agregar a inicio**.
- **Computador (Chrome/Edge):** el ícono de instalar en la barra de direcciones.

El **tesorero** instala desde el panel y abre directo en `/panel`, con accesos directos a *Registrar pago*, *Pagos* y *Casas*.
Cada **residente** instala desde su enlace personal y obtiene "Cuotia · Casa 14", que abre en su propia cuota.

El ícono es el mismo logo del diseño (`public/icons/`, con versión recortable para Android y para iPhone). Sin conexión se
muestra un aviso con el estilo de la app. El service worker **nunca guarda páginas**: llevan pagos y nombres, así que siempre
vienen del servidor; solo guarda estilos, tipografía e íconos.

## Estado

Funcional para el piloto: base multi-conjunto con aislamiento probado, webhook firmado, conciliación por
alias, doble factor, panel completo y página del residente (responsive). Pendiente: passkeys,
panel del operador, transparencia. Ver `CLAUDE.md`.
