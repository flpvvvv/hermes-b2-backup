import fs from "node:fs";
import path from "node:path";
import type { Logger } from "@backblaze-labs/agent-backup-core";
import { runCommand } from "./process.js";

const EXCLUDE_PATTERNS: RegExp[] = [
  // Hermes-owned regenerable dirs at the home root and per profile.
  /^home\/(?:profiles\/[^/]+\/)?(?:hermes-agent|node|cache|image_cache|logs|backups|state-snapshots|checkpoints)\//,
  // Downloaded toolchains and Hermes-managed binaries.
  /^home\/(?:profiles\/[^/]+\/)?(?:tools|lsp|bin)\//,
  // uv-managed virtualenvs and package-manager runtimes.
  /^home\/(?:profiles\/[^/]+\/)?installs\/[^/]+\/(?:environments|pm-runtime|bootstrap)\//,
  // Model metadata caches.
  /^home\/(?:profiles\/[^/]+\/)?(?:models_dev_cache|provider_models_cache)\.json$/,
  // Scratch space.
  /^home\/tmp\//,
  // Caches/deps at any depth.
  /(^|\/)node_modules\//,
  /(^|\/)\.venv\//,
  /(^|\/)venv\//,
  /(^|\/)site-packages\//,
  /(^|\/)\.cache\//,
  /(^|\/)__pycache__\//,
  /(^|\/)\.pytest_cache\//,
  /(^|\/)\.mypy_cache\//,
  /(^|\/)\.ruff_cache\//,
  // SQLite sidecars are regenerated after restore.
  /-wal$/,
  /-shm$/,
  /-journal$/,
  // Machine-local runtime state.
  /\.pid$/,
  /(^|\/)gateway\.lock$/,
  /(^|\/)processes\.json$/,
  /(^|\/)gateway_state\.json$/,
  /(^|\/)\.DS_Store$/,
];

/** Whether a Hermes-home-relative zip member should stay out of the archive. */
export function archiveMemberExcluded(member: string): boolean {
  if (member.startsWith("_external/")) return false;
  return EXCLUDE_PATTERNS.some((pattern) => pattern.test(`home/${member}`));
}

const FILTER_SCRIPT = String.raw`
import json, os, re, shutil, sys, zipfile

src, dst, patterns_path = sys.argv[1:4]
patterns = [re.compile(p) for p in json.load(open(patterns_path))]
tmp = dst + ".tmp"
kept = dropped = 0
with zipfile.ZipFile(src) as zin, zipfile.ZipFile(tmp, "w") as zout:
    for info in zin.infolist():
        name = info.filename
        if name.endswith("/"):
            continue
        if name.startswith("_external/"):
            keep = True
        else:
            probe = "home/" + name
            keep = not any(p.search(probe) for p in patterns)
        if not keep:
            dropped += 1
            continue
        out_info = zipfile.ZipInfo(name, date_time=info.date_time)
        out_info.external_attr = info.external_attr
        out_info.create_system = info.create_system
        out_info.compress_type = zipfile.ZIP_DEFLATED
        with zin.open(info) as fin, zout.open(out_info, "w") as fout:
            shutil.copyfileobj(fin, fout, 1024 * 1024)
        kept += 1
    if "state.db" not in {info.filename for info in zout.infolist()}:
        raise SystemExit("filtered archive is missing state.db")
os.replace(tmp, dst)
print(json.dumps({"kept": kept, "dropped": dropped}))
`;

/**
 * Strip Hermes-managed binaries, logs, scratch space, and caches that
 * `hermes backup` includes. The filtered zip keeps `state.db` at the archive
 * root and `_external/` provider state, so `hermes import` accepts it.
 */
export async function filterArchiveZip(
  inputPath: string,
  outputPath: string,
  logger: Logger,
): Promise<{ kept: number; dropped: number }> {
  const patternsPath = path.join(path.dirname(outputPath), "archive-excludes.json");
  await fs.promises.writeFile(
    patternsPath,
    JSON.stringify(EXCLUDE_PATTERNS.map((pattern) => pattern.source.replaceAll("\\/", "/"))),
    "utf8",
  );
  const { stdout } = await runCommand(
    "python3",
    ["-c", FILTER_SCRIPT, inputPath, outputPath, patternsPath],
    { timeout: 30 * 60 * 1000 },
  );
  const lastLine = stdout.trim().split("\n").at(-1) ?? "{}";
  const summary = JSON.parse(lastLine) as { kept?: number; dropped?: number };
  const kept = summary.kept ?? 0;
  const dropped = summary.dropped ?? 0;
  if (kept === 0) throw new Error("filtered archive is empty");
  logger.info(`archive: filtered zip (${kept} files kept, ${dropped} excluded)`);
  return { kept, dropped };
}
