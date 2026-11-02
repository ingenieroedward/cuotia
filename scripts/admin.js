// Operator tasks from the command line (no panel for the operator yet).
//   npm run admin -- crear-conjunto --slug jardines-de-ibiza --nombre "Jardines de Ibiza" --correo marta@ejemplo.com [--tesorero "Marta Rojas"] [--llave @llave] [--titular "Marta Rojas"] [--cuota 30000]
//   npm run admin -- agregar-casa --conjunto jardines-de-ibiza --codigo 14 --residente "Sandra Duque" [--telefono 3001234567]
//   npm run admin -- generar-cuotas --conjunto jardines-de-ibiza [--periodo 2026-11]
//   MASTER_KEY=... npm run admin -- configurar-pagoradar --conjunto jardines-de-ibiza --secreto <secreto del webhook de su app en pagoradar>
//   npm run admin -- respaldar [--carpeta data/backups] [--conservar 14]      consistent copy of the live database
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
    residente: { type: "string" }, telefono: { type: "string" }, periodo: { type: "string" }, secreto: { type: "string" }, tesorero: { type: "string" }, carpeta: { type: "string" }, conservar: { type: "string" },
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
  const { house, accessToken } = store.forTenant(tenantOf().id).houses.create({ code: v.codigo, residentName: v.residente, phone: v.telefono ?? null });
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
  fail("Comandos: crear-conjunto | configurar-pagoradar | agregar-casa | generar-cuotas | respaldar | restablecer-2fa | restablecer-clave");
}
store.close();
