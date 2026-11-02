import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const NAME = /^cuotia-\d{8}-\d{6}\.db$/;

/** "cuotia-20261102-183005.db" (UTC, to the second so two runs never collide): sorts by date, which is how old ones are found. */
export const backupName = (date = new Date()) => {
  const iso = date.toISOString();
  return `cuotia-${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}.db`;
};

/**
 * A consistent copy of the live database (VACUUM INTO is safe while the app is running and leaves a compact file).
 * Refuses to overwrite: a backup that replaced a good one would be worse than none.
 */
export function backupTo(db, file) {
  if (existsSync(file)) throw new Error(`Ya existe ${file}: no se sobrescribe un respaldo`);
  mkdirSync(dirname(file), { recursive: true });
  db.prepare("VACUUM INTO ?").run(file);
  return { file, bytes: statSync(file).size };
}

/** Keeps the newest `keep` backups in the folder (only files named like ours) and returns the ones it removed. */
export function pruneBackups(dir, keep) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => NAME.test(f)).sort();
  const old = files.slice(0, Math.max(0, files.length - Math.max(1, keep)));
  for (const f of old) rmSync(join(dir, f));
  return old;
}
