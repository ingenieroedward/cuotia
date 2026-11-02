// Operator tasks from the command line (no panel for the operator yet).
//   npm run admin -- crear-conjunto --slug jardines-de-ibiza --nombre "Jardines de Ibiza" --correo marta@ejemplo.com [--llave @llave] [--titular "Marta Rojas"] [--cuota 30000]
//   npm run admin -- agregar-casa --conjunto jardines-de-ibiza --codigo 14 --residente "Sandra Duque" [--telefono 3001234567]
//   npm run admin -- generar-cuotas --conjunto jardines-de-ibiza [--periodo 2026-11]
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { openStore } from "../src/store.js";
import { hashPassword } from "../src/security.js";
import { currentPeriod } from "../src/text.js";

const [command, ...rest] = process.argv.slice(2);
const { values: v } = parseArgs({
  args: rest,
  options: {
    slug: { type: "string" }, nombre: { type: "string" }, correo: { type: "string" }, llave: { type: "string" },
    titular: { type: "string" }, cuota: { type: "string" }, conjunto: { type: "string" }, codigo: { type: "string" },
    residente: { type: "string" }, telefono: { type: "string" }, periodo: { type: "string" },
  },
});

const fail = (msg) => { console.error(msg); process.exit(1); };
const store = openStore(process.env.DATABASE_PATH ?? "./data/cuotia.db");
const tenantOf = () => store.tenants.bySlug(v.conjunto ?? "") ?? fail("Conjunto no encontrado: usa --conjunto <slug>");

if (command === "crear-conjunto") {
  if (!v.slug || !v.nombre || !v.correo) fail("Faltan --slug, --nombre y --correo");
  const tenant = store.tenants.create({ slug: v.slug, name: v.nombre, payKey: v.llave ?? null, payHolder: v.titular ?? null });
  const ledger = store.forTenant(tenant.id);
  ledger.concepts.create({ name: "Vigilancia", amountCents: Number(v.cuota ?? 30000) * 100 });
  const password = randomBytes(9).toString("base64url");
  store.users.create({ tenantId: tenant.id, email: v.correo, passwordHash: await hashPassword(password) });
  console.log(`Conjunto creado: ${tenant.name}\n`);
  console.log(`  tenantRef (ponlo en la cuenta receptora de pagoradar): ${tenant.id}`);
  console.log(`  tesorero: ${v.correo}\n  contraseña temporal: ${password}   (cámbiala; no se vuelve a mostrar)`);
} else if (command === "agregar-casa") {
  if (!v.codigo || !v.residente) fail("Faltan --codigo y --residente");
  const { house, accessToken } = store.forTenant(tenantOf().id).houses.create({ code: v.codigo, residentName: v.residente, phone: v.telefono ?? null });
  console.log(`Casa ${house.code} (${house.residentName}) creada.\n  Enlace personal: ${process.env.PUBLIC_URL ?? "http://localhost:3000"}/r/${accessToken}`);
} else if (command === "generar-cuotas") {
  const period = v.periodo ?? currentPeriod();
  console.log(`Cuotas nuevas para ${period}: ${store.forTenant(tenantOf().id).dues.generate(period)}`);
} else {
  fail("Comandos: crear-conjunto | agregar-casa | generar-cuotas");
}
store.close();
