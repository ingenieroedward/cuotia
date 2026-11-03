import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { openStore } from "./store.js";
import { createApp } from "./app.js";
import { generateAllDues, offsiteDue, sendReminders } from "./schedule.js";
import { runOffsiteBackup } from "./offsite.js";

const config = loadConfig();
const store = openStore(config.databasePath);

if (store.tenants.list().length === 0) {
  // The first conjunto is created from this private, one-use link; it closes for good once a conjunto exists.
  console.log(`Aún no hay conjuntos. Crea el primero en: ${config.publicUrl}/setup?token=${config.setupToken}`);
  console.log("(o por terminal: npm run admin -- crear-conjunto --help)");
}

const app = createApp({ config, store });
const server = createServer(app);
server.listen(config.port, () => console.log(`Cuotia escuchando en ${config.publicUrl} (puerto ${config.port})`));

// Dues of the current month, created on start and checked every hour (cheap and idempotent), so the first of the
// month needs nobody pressing a button and a house added later gets its due too.
const monthlyDues = () => {
  try {
    const n = generateAllDues(store);
    if (n > 0) console.log(`Cuotas del mes creadas: ${n}`);
  } catch (e) {
    console.error("No se pudieron crear las cuotas del mes:", e.message);
  }
};
monthlyDues();
setInterval(monthlyDues, 3600_000).unref();

// "Hoy vence tu cuota" / "Tu cuota venció" for residents with notifications on (only where a last day to pay is set).
const reminders = async () => {
  try {
    const n = await sendReminders(store, app.notifier);
    if (n > 0) console.log(`Recordatorios enviados: ${n}`);
  } catch (e) {
    console.error("No se pudieron enviar los recordatorios:", e.message);
  }
};
setInterval(reminders, 3600_000).unref();
setTimeout(reminders, 60_000).unref();

// Expired sessions are only dead rows; sweep them hourly.
setInterval(() => store.sessions.purgeExpired(), 3600_000).unref();

// Encrypted copy of the database to the configured clouds (R2, B2…), every night. Without destinations nothing happens.
for (const w of config.backupWarnings) console.error(`Respaldo externo: ${w}`);
if (config.backups.length > 0) {
  console.log(`Respaldo externo: ${config.backups.map((b) => b.name).join(", ")} (cada noche, se conservan ${config.backupKeep})`);
  let running = false;
  const offsite = async () => {
    if (running || !offsiteDue(store.settings.get("offsite_last_ok"))) return;
    running = true;
    try {
      const r = await runOffsiteBackup({ store, config });
      for (const x of r.results) console.log(`Respaldo externo ${x.name}: ${x.ok ? "listo" : `FALLÓ (${x.error})`}`);
    } finally {
      running = false;
    }
  };
  setInterval(offsite, 3600_000).unref();
  setTimeout(offsite, 2 * 60_000).unref();
}

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => server.close(() => { store.close(); process.exit(0); }));
}
