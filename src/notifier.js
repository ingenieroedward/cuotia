import { decryptSecret, encryptSecret } from "./security.js";
import { newVapidKeys, sendPush } from "./webpush.js";

/**
 * Phone notifications for the treasurer's team and for residents. One instance per process, shared by the web app and
 * the hourly reminders, so both use the same VAPID keys. `pushSend` is replaceable in tests.
 * Nothing here throws or waits for the user: a failed notification is never worth an error.
 */
export function createNotifier({ store, config, pushSend = sendPush }) {
  let keys = null;
  /** The VAPID key pair is made once per instance (private half encrypted with MASTER_KEY). If MASTER_KEY changed, the
   *  old private key can't be read: make new keys and forget every subscription, which belonged to the old ones. */
  function vapid() {
    if (keys) return keys;
    const publicKey = store.settings.get("vapid_public");
    const encrypted = store.settings.get("vapid_private");
    if (publicKey && encrypted) {
      try {
        keys = { publicKey, privateKey: decryptSecret(encrypted, config.masterKey) };
        return keys;
      } catch { /* fall through and regenerate */ }
    }
    keys = newVapidKeys();
    store.settings.resetPush();
    store.settings.set("vapid_public", keys.publicKey);
    store.settings.set("vapid_private", encryptSecret(keys.privateKey, config.masterKey));
    return keys;
  }

  /** The last thing that went wrong (and when something last worked), so the panel can say WHY a notification didn't go. */
  let failure = null;
  let okAt = 0;
  const hostOf = (endpoint) => { try { return new URL(endpoint).hostname; } catch { return ""; } };

  async function deliver(subs, message, forget) {
    if (!subs.length) return 0;
    const k = vapid();
    let sent = 0;
    await Promise.all(subs.map(async (sub) => {
      const r = await pushSend(sub, message, k, { subject: config.publicUrl });
      if (r?.ok) { sent += 1; okAt = Date.now(); }
      else {
        failure = { at: Date.now(), host: hostOf(sub.endpoint), status: Number(r?.status ?? 0), detail: String(r?.detail ?? ""), gone: !!r?.gone };
        console.warn(`[avisos] ${failure.host} respondió ${failure.status || "sin respuesta"}${failure.detail ? `: ${failure.detail}` : ""}`);
      }
      if (r?.gone) forget(sub.endpoint);
    }));
    return sent;
  }

  return {
    publicKey: () => vapid().publicKey,
    /** The latest failed delivery, unless something has been delivered since. For the treasurer's screen. */
    lastFailure: () => (failure && failure.at > okAt ? failure : null),
    /** To a conjunto's people (or just one of them). */
    async team(tenantId, message, { userId = null } = {}) {
      try {
        const ledger = store.forTenant(tenantId);
        return await deliver(ledger.push.list({ userId }), message, (e) => ledger.push.remove(e));
      } catch { return 0; }
    },
    /** To the phones one house installed the app on. */
    async house(tenantId, houseId, message) {
      try {
        const ledger = store.forTenant(tenantId);
        return await deliver(ledger.housePush.list(houseId), message, (e) => ledger.housePush.remove(e));
      } catch { return 0; }
    },
  };
}
