// Operator tasks from the command line (the operator panel is at /operador; these also work without it).
//   npm run admin -- crear-operador --correo dev@ejemplo.com [--nombre "Dev"]     the platform owner: prints a temporary password
//   npm run admin -- restablecer-operador --correo dev@ejemplo.com              lost password or phone: new temporary password and a new code
//   npm run admin -- crear-conjunto --slug jardines-de-ibiza --nombre "Jardines de Ibiza" --correo marta@ejemplo.com [--tesorero "Marta Rojas"] [--llave @llave] [--titular "Marta Rojas"] [--cuota 30000]
//   npm run admin -- agregar-casa --conjunto jardines-de-ibiza --codigo 14 --residente "Sandra Duque" [--telefono 3001234567]
//   npm run admin -- generar-cuotas --conjunto jardines-de-ibiza [--periodo 2026-11]
//   MASTER_KEY=... npm run admin -- configurar-pagoradar --conjunto jardines-de-ibiza --secreto <secreto del webhook de su app en pagoradar>
//   npm run admin -- respaldar [--carpeta data/backups] [--conservar 14]      consistent copy of the live database
//   npm run admin -- respaldar-externo | probar-respaldo                       encrypted copy to the BACKUP1_* … clouds (R2, B2), now
//   npm run admin -- descifrar-respaldo --archivo X.db.enc --salida X.db       restore: decrypt a downloaded copy (same MASTER_KEY)
//   npm run admin -- restablecer-2fa --correo marta@ejemplo.com               lost phone: the next sign-in enrolls a new authenticator
//   npm run admin -- restablecer-clave --correo marta@ejemplo.com             lost password: prints a new temporary one
// Each conjunto has its own pagoradar app, webhook URL and secret (the secret is stored encrypted with MASTER_KEY).
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { openStore } from "../src/store.js";
import { encryptSecret, hashPassword } from "../src/security.js";
import { currentPeriod } from "../src/text.js";
import { backupName, backupTo, pruneBackups } from "../src/backup.js";
import { dirname, join } from "node:path";

const [command, ...rest] = process.argv.slice(2);
const { values: v } = parseArgs({
  args: rest,
  options: {
    slug: { type: "string" }, nombre: { type: "string" }, correo: { type: "string" }, llave: { type: "string" },
    titular: { type: "string" }, cuota: { type: "string" }, conjunto: { type: "string" }, codigo: { type: "string" },
    residente: { type: "string" }, archivo: { type: "string" }, salida: { type: "string" }, telefono: { type: "string" }, periodo: { type: "string" }, secreto: { type: "string" }, tesorero: { type: "string" }, carpeta: { type: "string" }, conservar: { type: "string" },
  },
});

const fail = (msg) => { console.error(msg); process.exit(1); };
const dbPath = process.env.DATABASE_PATH ?? "./data/cuotia.db";
const store = openStore(dbPath);
const publicUrl = (process.env.PUBLIC_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const webhookUrl = (tenant) => `${publicUrl}/webhooks/pagoradar/${tenant.id}`;
const saveSecret = (tenant, secret) => {
  if (!process.env.MASTER_KEY) fail("Falta MASTER_KEY (la misma del servidor) para cifrar el secreto");
  store.tenants.setPagoradarSecret(tenant.id, encryptSecret(secret, process.env.MASTER_KEY));
};
const tenantOf = () => store.tenants.bySlug(v.conjunto ?? "") ?? fail("Conjunto no encontrado: usa --conjunto <slug>");

if (command === "crear-conjunto") {
  if (!v.slug || !v.nombre || !v.correo) fail("Faltan --slug, --nombre y --correo");
  if (v.secreto && !process.env.MASTER_KEY) fail("Falta MASTER_KEY (la misma del servidor) para cifrar el secreto");
  const tenant = store.tenants.create({ slug: v.slug, name: v.nombre, payKey: v.llave ?? null, payHolder: v.titular ?? null });
  const ledger = store.forTenant(tenant.id);
  ledger.concepts.create({ name: "Vigilancia", amountCents: Number(v.cuota ?? 30000) * 100 });
  const password = randomBytes(9).toString("base64url");
  store.users.create({ tenantId: tenant.id, email: v.correo, passwordHash: await hashPassword(password), name: v.tesorero ?? null });
  console.log(`Conjunto creado: ${tenant.name}\n`);
  if (v.secreto) saveSecret(tenant, v.secreto);
  console.log(`  URL del webhook (en la app de este conjunto en pagoradar): ${webhookUrl(tenant)}`);
  console.log(v.secreto ? "  secreto de pagoradar: guardado (cifrado)" : "  secreto de pagoradar: falta; el tesorero lo pega en Ajustes o usa: configurar-pagoradar");
  console.log(`  tesorero: ${v.correo}\n  contraseña temporal: ${password}   (cámbiala; no se vuelve a mostrar)`);
} else if (command === "configurar-pagoradar") {
  if (!v.secreto) fail("Falta --secreto");
  const tenant = tenantOf();
  saveSecret(tenant, v.secreto);
  console.log(`Secreto de pagoradar guardado para ${tenant.name}.\n  URL del webhook: ${webhookUrl(tenant)}`);
} else if (command === "agregar-casa") {
  if (!v.codigo || !v.residente) fail("Faltan --codigo y --residente");
  const ledger = store.forTenant(tenantOf().id);
  const { house, accessToken } = ledger.houses.create({ code: v.codigo, residentName: v.residente, phone: v.telefono ?? null });
  if (process.env.MASTER_KEY) ledger.houses.setSealedLink(house.id, encryptSecret(accessToken, process.env.MASTER_KEY)); // so the WhatsApp reminders can carry it
  console.log(`Casa ${house.code} (${house.residentName}) creada.\n  Enlace personal: ${process.env.PUBLIC_URL ?? "http://localhost:3000"}/r/${accessToken}`);
} else if (command === "generar-cuotas") {
  const period = v.periodo ?? currentPeriod();
  console.log(`Cuotas nuevas para ${period}: ${store.forTenant(tenantOf().id).dues.generate(period)}`);
} else if (command === "respaldar") {
  const dir = v.carpeta ?? join(dirname(dbPath), "backups");
  let result;
  try {
    result = backupTo(store.db, join(dir, backupName()));
  } catch (e) {
    fail(`No se pudo respaldar: ${e.message}`);
  }
  const { file, bytes } = result;
  const removed = pruneBackups(dir, Number(v.conservar ?? 14));
  console.log(`Respaldo listo: ${file} (${Math.round(bytes / 1024)} KB)`);
  console.log(removed.length ? `Se borraron ${removed.length} respaldo(s) viejo(s); se conservan los últimos ${v.conservar ?? 14}.` : `Se conservan los últimos ${v.conservar ?? 14}.`);
  console.log("Ojo: está en el mismo disco que la base. Copia esa carpeta a otro lugar (otro servidor, tu computador o la nube).");
} else if (command === "respaldar-externo" || command === "probar-respaldo") {
  // Same copy as the nightly one (consistent, encrypted with MASTER_KEY, uploaded to every BACKUP1_* … destination).
  const { loadConfig } = await import("../src/config.js");
  const { runOffsiteBackup, testDestinations } = await import("../src/offsite.js");
  const config = { ...loadConfig(), databasePath: dbPath };
  for (const w of config.backupWarnings) console.error(`Aviso: ${w}`);
  if (config.backups.length === 0) fail("No hay destinos: define BACKUP1_ENDPOINT, BACKUP1_BUCKET, BACKUP1_KEY_ID y BACKUP1_SECRET");
  if (command === "probar-respaldo") {
    for (const r of await testDestinations({ config })) console.log(`${r.name}: ${r.ok ? "funciona" : `NO funciona (${r.error})`}`);
  } else {
    const r = await runOffsiteBackup({ store, config });
    for (const x of r.results) console.log(`${x.name}: ${x.ok ? "listo" : `FALLÓ (${x.error})`}`);
    console.log(`${r.file ?? "(sin archivo)"} · ${(r.bytes / 1048576).toFixed(1)} MB`);
    if (r.results.some((x) => !x.ok)) process.exitCode = 1;
  }
} else if (command === "descifrar-respaldo") {
  // Turns a downloaded cuotia-….db.enc back into a SQLite file (needs the same MASTER_KEY it was made with).
  const { loadConfig } = await import("../src/config.js");
  const { decryptFile } = await import("../src/offsite.js");
  if (!v.archivo || !v.salida) fail("Usa --archivo cuotia-AAAAMMDD-HHMMSS.db.enc --salida cuotia-restaurada.db");
  try {
    await decryptFile(v.archivo, v.salida, loadConfig().masterKey);
  } catch (e) {
    fail(e.message);
  }
  console.log(`Listo: ${v.salida}. Para restaurar: detén la app, reemplaza el archivo de la base (DATABASE_PATH) por este y vuelve a iniciar.`);
} else if (command === "crear-operador" || command === "restablecer-operador") {
  // The operator is the platform's owner (panel at /operador): belongs to no conjunto and sees only counts.
  const correo = (v.correo ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) fail("Usa --correo con un correo válido");
  const password = randomBytes(9).toString("base64url");
  const passwordHash = await hashPassword(password);
  if (command === "crear-operador") {
    if (store.operators.byEmail(correo)) fail("Ya hay un operador con ese correo (para recuperarlo: restablecer-operador)");
    store.operators.create({ email: correo, passwordHash, name: v.nombre ?? null });
    console.log(`Operador creado: ${correo}\nContraseña temporal: ${password}\n(no se vuelve a mostrar). Entra en /operador/entrar: te pedirá activar el código de verificación y puedes cambiar la contraseña en "Mi cuenta".`);
  } else {
    const op = store.operators.byEmail(correo) ?? fail("No hay un operador con ese correo");
    store.operators.setPasswordHash(op.id, passwordHash);
    store.operators.resetTotp(op.id);
    store.operatorSessions.deleteForOperator(op.id);
    console.log(`Listo: ${correo} tiene contraseña temporal ${password} (no se vuelve a mostrar), deberá activar un código nuevo y se cerraron sus sesiones.`);
  }
} else if (command === "restablecer-2fa" || command === "restablecer-clave") {
  const user = store.users.byEmail(v.correo ?? "") ?? fail("No hay un usuario con ese correo: usa --correo");
  if (command === "restablecer-2fa") {
    store.users.resetTotp(user.id);
    store.sessions.deleteForUser(user.id);
    console.log(`Listo: ${user.email} deberá activar un código de verificación nuevo la próxima vez que entre. Sus sesiones se cerraron.`);
  } else {
    const password = randomBytes(9).toString("base64url");
    store.users.setPasswordHash(user.id, await hashPassword(password));
    store.sessions.deleteForUser(user.id);
    console.log(`Contraseña nueva para ${user.email}: ${password}\n(es temporal: que la cambie en Ajustes; no se vuelve a mostrar).`);
  }
} else {
  fail("Comandos: crear-conjunto | configurar-pagoradar | agregar-casa | generar-cuotas | respaldar | restablecer-2fa | restablecer-clave | crear-operador | restablecer-operador | respaldar-externo | probar-respaldo | descifrar-respaldo");
}
store.close();
