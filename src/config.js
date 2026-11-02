/** Reads the process configuration. Only what cannot live in the database comes from the environment (each conjunto's pagoradar secret does live there). */
export function loadConfig(env = process.env) {
  const masterKey = env.MASTER_KEY;
  if (!/^[0-9a-f]{64}$/i.test(masterKey ?? "")) throw new Error("Falta MASTER_KEY: 64 caracteres hexadecimales (openssl rand -hex 32). Cifra los secretos del doble factor. Guárdala.");
  const publicUrl = (env.PUBLIC_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  return {
    port: Number(env.PORT ?? 3000),
    databasePath: env.DATABASE_PATH ?? "./data/cuotia.db",
    publicUrl,
    secureCookies: publicUrl.startsWith("https://"),
    masterKey,
  };
}
