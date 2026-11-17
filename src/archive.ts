import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createB2Client,
  decrypt,
  encrypt,
  isEncrypted,
  resolvePassphrase,
  type B2Client,
  type B2ObjectEntry,
  type Logger,
  type StandaloneConfig,
} from "@backblaze-labs/agent-backup-core";
import { B2Native } from "./b2-native.js";
import { runCommand } from "./process.js";
import { filterArchiveZip } from "./zip-filter.js";

const USER_AGENT = "b2ai-hermes-backup";
const ARCHIVES_DIR = "archives";
const MANIFEST_NAME = "manifest.enc";
const CHUNK_BYTES = 32 * 1024 * 1024;
const STALE_INCOMPLETE_MS = 24 * 60 * 60 * 1000;
const BACKUP_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const RESTORE_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export type ArchiveConfig = StandaloneConfig & { hermesBin?: string };

export type ArchiveSnapshot = {
  ts: string;
  complete: boolean;
  objects: number;
  bytes: number;
  chunks: number;
};

type ChunkEntry = {
  key: string;
  size: number;
  sha256: string;
  plaintextSize: number;
  plaintextSha256: string;
};

export type ArchiveManifest = {
  version: 1;
  snapshot: string;
  createdAt: string;
  zip: { name: string; size: number; sha256: string };
  chunks: ChunkEntry[];
};

function sha256(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function sha256File(filePath: string): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  stream.on("data", (chunk) => hash.update(chunk));
  stream.on("end", () => resolve(hash.digest("hex")));
  stream.on("error", reject);
  return promise;
}

export function formatTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

export function parseTimestamp(ts: string): Date | null {
  const m = ts.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/);
  if (!m) return null;
  const [, year, month, day, hour, minute, second, millis] = m;
  return new Date(
    Date.UTC(+year!, +month! - 1, +day!, +hour!, +minute!, +second!, +millis!),
  );
}

export function chunkRanges(size: number, chunkBytes: number): { offset: number; length: number }[] {
  if (!Number.isInteger(chunkBytes) || chunkBytes <= 0) {
    throw new Error(`chunk size must be a positive integer, got ${chunkBytes}`);
  }
  const ranges: { offset: number; length: number }[] = [];
  for (let offset = 0; offset < size; offset += chunkBytes) {
    ranges.push({ offset, length: Math.min(chunkBytes, size - offset) });
  }
  return ranges;
}

/**
 * Group listed objects under `<prefix>/archives/` into snapshots. A snapshot is
 * complete only when its manifest object exists; data uploaded by a crashed run
 * is deliberately not restorable and is cleaned up separately.
 */
export function groupArchiveObjects(
  archivesPrefix: string,
  objects: readonly Pick<B2ObjectEntry, "key" | "size">[],
): ArchiveSnapshot[] {
  const grouped = new Map<string, ArchiveSnapshot>();
  for (const object of objects) {
    if (!object.key.startsWith(archivesPrefix)) continue;
    const relative = object.key.slice(archivesPrefix.length);
    const slash = relative.indexOf("/");
    if (slash <= 0) continue;
    const ts = relative.slice(0, slash);
    const name = relative.slice(slash + 1);
    const entry = grouped.get(ts) ?? { ts, complete: false, objects: 0, bytes: 0, chunks: 0 };
    entry.objects++;
    entry.bytes += object.size;
    if (name === MANIFEST_NAME) entry.complete = true;
    if (name.startsWith("data-") && name.endsWith(".enc")) entry.chunks++;
    grouped.set(ts, entry);
  }
  return [...grouped.values()].sort((a, b) => a.ts.localeCompare(b.ts));
}

export function planPrune(
  snapshots: readonly ArchiveSnapshot[],
  keep: number,
  nowMs = Date.now(),
): { toPrune: ArchiveSnapshot[]; staleIncomplete: ArchiveSnapshot[] } {
  const complete = snapshots
    .filter((snapshot) => snapshot.complete)
    .sort((a, b) => a.ts.localeCompare(b.ts));
  const toPrune = complete.slice(0, Math.max(0, complete.length - keep));
  const cutoff = nowMs - STALE_INCOMPLETE_MS;
  const staleIncomplete = snapshots.filter((snapshot) => {
    if (snapshot.complete) return false;
    const parsed = parseTimestamp(snapshot.ts);
    return parsed !== null && parsed.getTime() < cutoff;
  });
  return { toPrune, staleIncomplete };
}

export function chooseSnapshot(
  snapshots: readonly ArchiveSnapshot[],
  ts?: string,
): ArchiveSnapshot | undefined {
  const complete = snapshots
    .filter((snapshot) => snapshot.complete)
    .sort((a, b) => a.ts.localeCompare(b.ts));
  return ts ? complete.find((snapshot) => snapshot.ts === ts) : complete.at(-1);
}

function normalizePrefix(prefix: string | undefined): string {
  const trimmed = (prefix ?? "hermes-backup").replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : "hermes-backup";
}

function archivesPrefix(prefix: string): string {
  return `${prefix}/${ARCHIVES_DIR}/`;
}

function snapshotPrefix(prefix: string, ts: string): string {
  return `${archivesPrefix(prefix)}${ts}/`;
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

async function verifyZip(zipPath: string, logger: Logger): Promise<void> {
  const script =
    "import sys, zipfile\n" +
    "z = zipfile.ZipFile(sys.argv[1])\n" +
    "bad = z.testzip()\n" +
    "if bad:\n" +
    "    print(bad)\n" +
    "    sys.exit(1)\n";
  try {
    await runCommand("python3", ["-c", script, zipPath], { timeout: 10 * 60 * 1000 });
  } catch (err) {
    const error = err as NodeJS.ErrnoException & { stderr?: string };
    if (error.code === "ENOENT") {
      logger.warn("archive: python3 not found; skipping zip integrity test");
      return;
    }
    throw new Error(`zip integrity check failed: ${(error.stderr ?? error.message).trim()}`);
  }
}

function resolveHermesBin(config: ArchiveConfig): string {
  const configured = config.hermesBin ?? process.env.HERMES_BIN;
  if (configured) return configured;
  const candidate = path.join(os.homedir(), ".local/bin/hermes");
  return fs.existsSync(candidate) ? candidate : "hermes";
}

async function createZip(config: ArchiveConfig, tmpDir: string, logger: Logger): Promise<string> {
  const rawPath = path.join(tmpDir, "hermes-raw.zip");
  const zipPath = path.join(tmpDir, "hermes.zip");
  const hermesBin = resolveHermesBin(config);
  logger.info(`archive: running ${hermesBin} backup`);
  try {
    await runCommand(hermesBin, ["backup", "-o", rawPath, "-k", "0"], {
      timeout: BACKUP_TIMEOUT_MS,
    });
  } catch (err) {
    const error = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const output = `${error.stdout ?? ""}\n${error.stderr ?? ""}`.trim();
    throw new Error(
      `hermes backup failed${output ? `:\n${output.slice(-2000)}` : `: ${error.message}`}`,
    );
  }
  const rawStat = await fs.promises.stat(rawPath).catch(() => null);
  if (!rawStat?.isFile() || rawStat.size === 0) {
    throw new Error(`hermes backup did not produce a non-empty zip at ${rawPath}`);
  }
  logger.info(`archive: hermes zip ${humanBytes(rawStat.size)} before filtering`);
  await filterArchiveZip(rawPath, zipPath, logger);
  await fs.promises.rm(rawPath, { force: true });
  const stat = await fs.promises.stat(zipPath).catch(() => null);
  if (!stat?.isFile() || stat.size === 0) {
    throw new Error(`filtered archive is empty at ${zipPath}`);
  }
  await fs.promises.chmod(zipPath, 0o600);
  await verifyZip(zipPath, logger);
  logger.info(`archive: filtered zip ${humanBytes(stat.size)}`);
  return zipPath;
}

async function uploadArchive(opts: {
  client: B2Client;
  bucket: string;
  prefix: string;
  ts: string;
  zipPath: string;
  passphrase: string;
  logger: Logger;
}): Promise<ArchiveManifest> {
  const stat = await fs.promises.stat(opts.zipPath);
  const zipSha = await sha256File(opts.zipPath);
  const ranges = chunkRanges(stat.size, CHUNK_BYTES);
  const chunks: ChunkEntry[] = [];
  const handle = await fs.promises.open(opts.zipPath, "r");
  try {
    for (const [index, range] of ranges.entries()) {
      const plaintext = Buffer.allocUnsafe(range.length);
      const { bytesRead } = await handle.read(plaintext, 0, range.length, range.offset);
      if (bytesRead !== range.length) {
        throw new Error(`short read from ${opts.zipPath} at offset ${range.offset}`);
      }
      const ciphertext = encrypt(plaintext, opts.passphrase);
      const key = `data-${String(index).padStart(3, "0")}.enc`;
      await opts.client.putObject(
        opts.bucket,
        `${snapshotPrefix(opts.prefix, opts.ts)}${key}`,
        ciphertext,
        "application/octet-stream",
      );
      chunks.push({
        key,
        size: ciphertext.length,
        sha256: sha256(ciphertext),
        plaintextSize: plaintext.length,
        plaintextSha256: sha256(plaintext),
      });
      opts.logger.info(`archive: uploaded ${key} (${humanBytes(plaintext.length)})`);
    }
  } finally {
    await handle.close();
  }

  const manifest: ArchiveManifest = {
    version: 1,
    snapshot: opts.ts,
    createdAt: new Date().toISOString(),
    zip: { name: "hermes.zip", size: stat.size, sha256: zipSha },
    chunks,
  };
  const body = encrypt(Buffer.from(JSON.stringify(manifest), "utf8"), opts.passphrase);
  await opts.client.putObject(
    opts.bucket,
    `${snapshotPrefix(opts.prefix, opts.ts)}${MANIFEST_NAME}`,
    body,
    "application/octet-stream",
  );
  opts.logger.info(`archive: uploaded ${MANIFEST_NAME} (${humanBytes(body.length)})`);
  return manifest;
}

async function listArchiveSnapshots(
  client: B2Client,
  bucket: string,
  prefix: string,
): Promise<ArchiveSnapshot[]> {
  const base = archivesPrefix(prefix);
  const objects = await client.listObjects(bucket, base);
  return groupArchiveObjects(base, objects);
}

export async function runBackup(config: ArchiveConfig, logger: Logger): Promise<void> {
  const prefix = normalizePrefix(config.prefix);
  const keep = config.keepSnapshots ?? 7;
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error(`keepSnapshots must be an integer >= 1, got ${String(keep)}`);
  }
  if (config.encrypt === false) {
    logger.warn("archive: encrypt=false is ignored; archive snapshots are always encrypted");
  }
  const passphrase = resolvePassphrase(config, logger);
  const native = await B2Native.create(config);
  const client = await createB2Client(
    config.keyId,
    config.applicationKey,
    config.region ?? native.region,
    USER_AGENT,
  );
  const ts = formatTimestamp();
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "hermes-archive-"));
  await fs.promises.chmod(tmpDir, 0o700);
  try {
    const zipPath = await createZip(config, tmpDir, logger);
    const manifest = await uploadArchive({
      client,
      bucket: config.bucket,
      prefix,
      ts,
      zipPath,
      passphrase,
      logger,
    });
    logger.info(
      `archive: snapshot ${ts} uploaded (${humanBytes(manifest.zip.size)}, ${manifest.chunks.length} chunks)`,
    );

    const snapshots = await listArchiveSnapshots(client, config.bucket, prefix);
    const { toPrune, staleIncomplete } = planPrune(snapshots, keep);
    for (const snapshot of [...toPrune, ...staleIncomplete]) {
      const target = snapshotPrefix(prefix, snapshot.ts);
      const deleted = await native.purgePrefix(target, {
        deleteManifestFirst: true,
        onProgress: (done) => {
          if (done % 200 === 0) {
            logger.info(`archive: pruned ${done} versions from ${snapshot.ts}`);
          }
        },
      });
      const remaining = await native.listFileVersions(target);
      if (remaining.length > 0) {
        throw new Error(
          `archive: ${remaining.length} versions still exist under ${target} after deleting ${deleted}`,
        );
      }
      const reason = snapshot.complete ? "retention" : "stale incomplete upload";
      logger.info(
        `archive: pruned ${snapshot.ts} (${deleted} versions, ${reason})`,
      );
    }
    const retained = snapshots.filter((snapshot) => snapshot.complete).length - toPrune.length;
    logger.info(`archive: ${retained} snapshot(s) retained under ${archivesPrefix(prefix)}`);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function listArchives(config: ArchiveConfig, logger: Logger): Promise<void> {
  const prefix = normalizePrefix(config.prefix);
  const native = await B2Native.create(config);
  const client = await createB2Client(
    config.keyId,
    config.applicationKey,
    config.region ?? native.region,
    USER_AGENT,
  );
  const snapshots = await listArchiveSnapshots(client, config.bucket, prefix);
  if (snapshots.length === 0) {
    logger.info(`archive: no snapshots under ${archivesPrefix(prefix)}`);
    return;
  }
  logger.info(`archive: ${snapshots.length} snapshot(s) under ${archivesPrefix(prefix)}`);
  for (const snapshot of snapshots) {
    const state = snapshot.complete ? "complete" : "INCOMPLETE";
    logger.info(
      `${snapshot.ts}  ${state}  ${humanBytes(snapshot.bytes)}  ${snapshot.objects} objects`,
    );
  }
}

async function safeExtract(zipPath: string, destination: string): Promise<void> {
  const script =
    "import os, sys, zipfile\n" +
    "src, dst = sys.argv[1], os.path.realpath(sys.argv[2])\n" +
    "zf = zipfile.ZipFile(src)\n" +
    "for name in zf.namelist():\n" +
    "    p = os.path.realpath(os.path.join(dst, name))\n" +
    "    if os.path.commonpath([dst, p]) != dst:\n" +
    "        raise SystemExit('unsafe archive member: ' + name)\n" +
    "zf.extractall(dst)\n";
  await runCommand("python3", ["-c", script, zipPath, destination], {
    timeout: 10 * 60 * 1000,
  });
}

export async function restoreArchive(
  config: ArchiveConfig,
  options: { snapshot?: string; to?: string; import?: boolean },
  logger: Logger,
): Promise<void> {
  const prefix = normalizePrefix(config.prefix);
  const passphrase = resolvePassphrase(config, logger);
  const native = await B2Native.create(config);
  const client = await createB2Client(
    config.keyId,
    config.applicationKey,
    config.region ?? native.region,
    USER_AGENT,
  );
  const snapshots = await listArchiveSnapshots(client, config.bucket, prefix);
  const chosen = chooseSnapshot(snapshots, options.snapshot);
  if (!chosen) {
    const available = snapshots
      .filter((snapshot) => snapshot.complete)
      .map((snapshot) => snapshot.ts)
      .join(", ");
    throw new Error(
      options.snapshot
        ? `snapshot ${options.snapshot} not found or incomplete${available ? ` (available: ${available})` : ""}`
        : "no complete snapshots found in the bucket",
    );
  }

  const base = snapshotPrefix(prefix, chosen.ts);
  const manifestData = await client.getObject(config.bucket, `${base}${MANIFEST_NAME}`);
  const manifestJson = isEncrypted(manifestData)
    ? decrypt(manifestData, passphrase).toString("utf8")
    : manifestData.toString("utf8");
  const manifest = JSON.parse(manifestJson) as ArchiveManifest;
  if (manifest.version !== 1) {
    throw new Error(`unsupported archive manifest version ${String(manifest.version)}`);
  }
  if (manifest.snapshot !== chosen.ts) {
    throw new Error(`manifest snapshot ${manifest.snapshot} does not match ${chosen.ts}`);
  }

  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "hermes-restore-"));
  await fs.promises.chmod(tmpDir, 0o700);
  const zipPath = path.join(tmpDir, "hermes.zip");
  try {
    const handle = await fs.promises.open(zipPath, "w", 0o600);
    const wholeHash = crypto.createHash("sha256");
    try {
      for (const chunk of manifest.chunks) {
        const ciphertext = await client.getObject(config.bucket, `${base}${chunk.key}`);
        if (sha256(ciphertext) !== chunk.sha256) {
          throw new Error(`ciphertext hash mismatch for ${chunk.key}`);
        }
        const plaintext = isEncrypted(ciphertext)
          ? decrypt(ciphertext, passphrase)
          : ciphertext;
        if (plaintext.length !== chunk.plaintextSize || sha256(plaintext) !== chunk.plaintextSha256) {
          throw new Error(`plaintext hash mismatch for ${chunk.key}`);
        }
        await handle.write(plaintext);
        wholeHash.update(plaintext);
      }
    } finally {
      await handle.close();
    }
    if (wholeHash.digest("hex") !== manifest.zip.sha256) {
      throw new Error("restored zip hash does not match the manifest");
    }
    await verifyZip(zipPath, logger);

    if (options.import) {
      const hermesBin = resolveHermesBin(config);
      logger.info(`archive: importing ${chosen.ts} with ${hermesBin} import --force`);
      const result = await runCommand(hermesBin, ["import", "--force", zipPath], {
        timeout: RESTORE_TIMEOUT_MS,
      });
      const output = `${result.stdout}\n${result.stderr}`.trim();
      if (output) logger.info(output.slice(-1000));
      logger.info(`archive: imported snapshot ${chosen.ts}`);
      return;
    }

    const destination =
      options.to ?? path.join(process.cwd(), `hermes-restore-${chosen.ts}`);
    try {
      await fs.promises.stat(destination);
      throw new Error(`restore destination already exists: ${destination}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    await fs.promises.mkdir(destination, { recursive: true });
    await safeExtract(zipPath, destination);
    logger.info(`archive: extracted snapshot ${chosen.ts} to ${destination}`);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function purgeLegacy(
  config: ArchiveConfig,
  options: { yes: boolean },
  logger: Logger,
): Promise<void> {
  if (!options.yes) {
    throw new Error("refusing to delete legacy snapshots without --yes");
  }
  const prefix = normalizePrefix(config.prefix);
  const archives = archivesPrefix(prefix);
  const native = await B2Native.create(config);
  const versions = await native.listFileVersions(`${prefix}/`);
  const legacy = versions.filter((version) => !version.fileName.startsWith(archives));
  logger.info(
    `archive: ${legacy.length} legacy versions under ${prefix}/ (keeping ${archives})`,
  );
  if (legacy.length === 0) return;
  await native.deleteVersions(legacy, (done) => {
    if (done % 500 === 0) logger.info(`archive: purged ${done}/${legacy.length} legacy versions`);
  });
  const remaining = (await native.listFileVersions(`${prefix}/`)).filter(
    (version) => !version.fileName.startsWith(archives),
  );
  if (remaining.length > 0) {
    throw new Error(`archive: ${remaining.length} legacy versions remain after purge`);
  }
  logger.info(`archive: legacy purge complete (${legacy.length} versions deleted)`);
}
