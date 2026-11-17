import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * One backup/prune at a time. Restores and listings stay lock-free: they only
 * read, and a restore while a backup runs is harmless.
 */
export function acquireArchiveLock(): () => void {
  const dir = path.join(os.homedir(), ".agent-backup", "hermes");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "archive.lock");
  try {
    fs.writeFileSync(file, String(process.pid), { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    let holder = Number.NaN;
    try {
      holder = Number(fs.readFileSync(file, "utf8").trim());
    } catch {
      // Unreadable lock: treat as stale.
    }
    if (Number.isFinite(holder) && holder !== process.pid && pidAlive(holder)) {
      throw new Error(`another hermes-b2-backup process (pid ${holder}) is already running`);
    }
    fs.writeFileSync(file, String(process.pid));
  }
  return () => {
    try {
      if (Number(fs.readFileSync(file, "utf8").trim()) === process.pid) {
        fs.rmSync(file, { force: true });
      }
    } catch {
      // Nothing to release.
    }
  };
}
