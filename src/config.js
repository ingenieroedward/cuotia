/** Reads the process configuration. Only what cannot live in the database comes from the environment. */
export function loadConfig(env = process.env) {
  const secret = env.PAGORADAR_WEBHOOK_SECRET;
  if (!secret) throw new Error("Falta la variable PAGORADAR_WEBHOOK_SECRET (el secreto del webhook en pagoradar)");
  const publicUrl = (env.PUBLIC_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  return {
    port: Number(env.PORT ?? 3000),
    databasePath: env.DATABASE_PATH ?? "./data/cuotia.db",
    publicUrl,
    secureCookies: publicUrl.startsWith("https://"),
    pagoradarWebhookSecret: secret,
  };
}
