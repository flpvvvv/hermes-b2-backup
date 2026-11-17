import { loadStandaloneConfig, type Logger } from "@backblaze-labs/agent-backup-core";
import {
  listArchives,
  purgeLegacy,
  restoreArchive,
  runBackup,
  type ArchiveConfig,
} from "./archive.js";
import { acquireArchiveLock } from "./lock.js";

const USAGE = `Usage: hermes-b2-backup [command]

Commands:
  (none) / --once          Create, encrypt and upload one archive, then prune old ones
  --list                   List snapshots in B2
  --restore [options]      Download and verify a snapshot
      --snapshot <ts>        Snapshot timestamp (default: newest complete)
      --to <dir>             Extract into <dir> instead of importing
      --import               Run \`hermes import --force\` on the restored zip
  --purge-legacy --yes     Permanently delete pre-archives per-file snapshots
  --help, -h               Show this help

Config: ~/.config/hermes-b2-backup/config.json (or B2_* environment variables).
`;

function takeFlag(args: string[], flag: string): boolean {
  const index = args.indexOf(flag);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function takeValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  args.splice(index, 2);
  return value;
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const args = [...argv];
  if (takeFlag(args, "--help") || takeFlag(args, "-h")) {
    console.log(USAGE);
    return;
  }

  const once = takeFlag(args, "--once");
  const list = takeFlag(args, "--list");
  const restore = takeFlag(args, "--restore");
  const purge = takeFlag(args, "--purge-legacy");
  const importFlag = takeFlag(args, "--import");
  const yes = takeFlag(args, "--yes");
  const snapshot = takeValue(args, "--snapshot");
  const to = takeValue(args, "--to");

  const commands = [once, list, restore, purge].filter(Boolean).length;
  if (commands > 1) throw new Error("choose only one of --once, --list, --restore, --purge-legacy");
  if (args.length > 0) throw new Error(`unknown argument(s): ${args.join(" ")}\n${USAGE}`);

  const command = once ? "once" : list ? "list" : restore ? "restore" : purge ? "purge" : "once";
  if (command !== "restore" && (snapshot || to || importFlag)) {
    throw new Error("--snapshot, --to and --import only apply to --restore");
  }
  if (command !== "purge" && yes) {
    throw new Error("--yes only applies to --purge-legacy");
  }
  if (restore && importFlag && to) {
    throw new Error("choose --to (extract only) or --import, not both");
  }

  const config = loadStandaloneConfig("hermes-b2-backup") as ArchiveConfig;
  const logger: Logger = {
    info: (message) => console.log(message),
    warn: (message) => console.warn(message),
    error: (message) => console.error(message),
    debug: process.env.DEBUG ? (message) => console.debug(message) : undefined,
  };

  if (command === "list") {
    await listArchives(config, logger);
    return;
  }
  if (command === "restore") {
    await restoreArchive(config, { snapshot, to, import: importFlag }, logger);
    return;
  }
  if (command === "purge") {
    const release = acquireArchiveLock();
    try {
      await purgeLegacy(config, { yes }, logger);
    } finally {
      release();
    }
    return;
  }

  const release = acquireArchiveLock();
  try {
    await runBackup(config, logger);
  } finally {
    release();
  }
}
