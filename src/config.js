import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

/** Reads the process configuration. Only what cannot live in the database comes from the environment (each conjunto's pagoradar secret does live there). */
export function loadConfig(env = process.env) {
  const masterKey = env.MASTER_KEY;
  if (!/^[0-9a-f]{64}$/i.test(masterKey ?? "")) throw new Error("Falta MASTER_KEY: 64 caracteres hexadecimales (openssl rand -hex 32). Cifra los secretos del doble factor. Guárdala.");
  // One-use link that creates the first conjunto. Fixed by SETUP_TOKEN, otherwise random on every start (printed in the log).
  const fixed = (env.SETUP_TOKEN ?? "").trim();
  if (fixed && fixed.length < 16) throw new Error("SETUP_TOKEN debe tener al menos 16 caracteres (o déjalo vacío para que se genere uno en cada arranque)");
  const publicUrl = (env.PUBLIC_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  return {
    port: Number(env.PORT ?? 3000),
    databasePath: env.DATABASE_PATH ?? "./data/cuotia.db",
    // Where the copies made before a destructive action are kept (same folder as `npm run admin -- respaldar`).
    backupDir: env.BACKUP_DIR ?? join(dirname(env.DATABASE_PATH ?? "./data/cuotia.db"), "backups"),
    publicUrl,
    secureCookies: publicUrl.startsWith("https://"),
    masterKey,
    setupToken: fixed || randomBytes(24).toString("base64url"),
    // Where people can send a data-protection request (Ley 1581). Optional: without it the policy points to the conjunto's treasurer.
    privacyContact: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((env.PRIVACY_CONTACT ?? "").trim()) ? env.PRIVACY_CONTACT.trim() : "",
  };
}
