import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { openStore } from "./store.js";
import { createApp } from "./app.js";

const config = loadConfig();
const store = openStore(config.databasePath);

if (store.tenants.list().length === 0) {
  // The first conjunto is created from this private, one-use link; it closes for good once a conjunto exists.
  console.log(`Aún no hay conjuntos. Crea el primero en: ${config.publicUrl}/setup?token=${config.setupToken}`);
  console.log("(o por terminal: npm run admin -- crear-conjunto --help)");
}

const server = createServer(createApp({ config, store }));
server.listen(config.port, () => console.log(`Cuotia escuchando en ${config.publicUrl} (puerto ${config.port})`));

// Expired sessions are only dead rows; sweep them hourly.
setInterval(() => store.sessions.purgeExpired(), 3600_000).unref();

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => server.close(() => { store.close(); process.exit(0); }));
}
