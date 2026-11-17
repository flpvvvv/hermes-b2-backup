# hermes-b2-backup

**Encrypted, versioned, off-site snapshots of your Hermes Agent state to [Backblaze B2](https://www.backblaze.com/cloud-storage).**

Each run creates one filtered `hermes backup` zip, encrypts it client-side, uploads it to B2, and keeps the newest N snapshots. Retention deletes B2 file **versions**, not just the visible object — so old copies stop being billed.

## Why one archive instead of a per-file mirror

The previous engine mirrored every file and used B2 server-side `CopyObject` to carry unchanged files into each new snapshot. That makes every snapshot self-contained, but B2 bills each `CopyObject` as a Class C transaction: ~1,800 copies per run, roughly the entire 2,500/day free-tier allowance. It also duplicated all data per snapshot.

This version uploads one zip, so a run costs about **3 Class C transactions** (one authorize, one list, one version listing when pruning). Uploads and deletes are Class A; downloads are Class B.

The zip starts from Hermes' own `hermes backup` (full mode), which applies Hermes' maintained exclusion list and takes WAL-safe SQLite snapshots. It then rewrites the zip to strip the runtime trees Hermes still includes:

- **Included:** config, `.env`, `auth.json`, `state.db` and profiles, sessions, skills (including archived skills), plugins, cron state, memories, and memory-provider state.
- **Stripped after `hermes backup`:** `bin/`, `logs/`, `tmp/`, `cache/`, `tools/`, `lsp/`, `installs/*/environments`, `state-snapshots/`, `backups/`, `checkpoints/`, browser profiles, `node_modules`, virtualenvs, SQLite sidecars, and machine-local runtime files. That is roughly 182 MB raw → 144 MB filtered today.
- `hermes backup --quick` is **not** used: it writes a local state snapshot, not a restorable zip.

## Install and configure

```bash
npm install -g @backblaze-labs/hermes-b2-backup
```

Put credentials in `~/.config/hermes-b2-backup/config.json`:

```json
{
  "keyId": "003...",
  "applicationKey": "K003...",
  "bucket": "my-hermes-agent-backup",
  "encryptionKey": "a long random passphrase",
  "prefix": "hermes-flp",
  "keepSnapshots": 7
}
```

`chmod 600 ~/.config/hermes-b2-backup/config.json` — it holds both B2 and encryption keys. Environment variables `B2_KEY_ID`, `B2_APPLICATION_KEY`, `B2_BUCKET`, `B2_ENCRYPTION_KEY`, `B2_REGION`, `B2_PREFIX`, and `B2_KEEP_SNAPSHOTS` override the file.

Optional keys:

- `hermesBin` — absolute path to the Hermes CLI (default: `~/.local/bin/hermes`, else `hermes` from `PATH`).
- `keepSnapshots` — complete snapshots to retain (default 7, minimum 1).

## Commands

```bash
hermes-b2-backup                  # same as --once
hermes-b2-backup --once           # create, encrypt, upload, prune
hermes-b2-backup --list           # list snapshots and sizes
hermes-b2-backup --restore        # newest snapshot → ./hermes-restore-<ts>/
hermes-b2-backup --restore --to /tmp/hermes-restore --snapshot <ts>
hermes-b2-backup --restore --import   # decrypt, verify, then `hermes import --force`
hermes-b2-backup --purge-legacy --yes # delete pre-archives per-file snapshots
```

`--restore` extracts into a new directory by default; it never overwrites `~/.hermes` unless you explicitly pass `--import`. `--import` runs Hermes' own importer with `--force`.

## How a run works

1. Run `hermes backup -o <tmp>/hermes-raw.zip -k 0`. A nonzero exit aborts the run before upload and before pruning.
2. Rewrite the zip without `bin/`, `logs/`, `tmp/`, caches, toolchains, and other regenerable trees; `state.db` must be present. A failed integrity check aborts the run.
3. Split the filtered zip into 32 MiB chunks and encrypt each with AES-256-GCM using `encryptionKey` (scrypt-derived key, random salt/IV per chunk).
4. Upload `data-NNN.enc` chunks, then `manifest.enc` last. A snapshot without a manifest is incomplete and is never restored or counted for retention.
5. List `<prefix>/archives/`, keep the newest `keepSnapshots` complete snapshots, and permanently delete every version of older snapshots. Incomplete uploads older than 24 hours are also removed.

Bucket layout:

```
<bucket>/<prefix>/archives/<timestamp>/
  data-000.enc
  data-001.enc
  manifest.enc
```

The manifest records the plaintext and ciphertext SHA-256 of every chunk plus the whole zip. Restore verifies all of them before extracting or importing.

## B2 transaction cost

At 7 snapshots of the current ~144 MB filtered archive:

- About **3 Class C transactions/day** (authorize, list archives, list versions while pruning).
- ~144 MB uploaded per night (Class A, free).
- ~1.0 GB stored (first 10 GB free).
- Uploads and deletes are Class A; downloads are Class B.

Class C counts are what the 2,500/day free-tier limit measures; the old ~1,800 `CopyObject` calls per run were the cause of the daily alerts.

## Migrating from 0.3.x

1. Stop the timer: `systemctl --user stop hermes-b2-backup.timer`.
2. Run one `--once` and verify it with `--list` / `--restore --to /tmp/...`.
3. Delete the old per-file snapshots once the archive restores correctly:
   `hermes-b2-backup --purge-legacy --yes`
   This keeps `<prefix>/archives/` and permanently removes every version under the old timestamp prefixes.
4. Start the timer again.

The old engine created B2 delete markers instead of deleting versions; `--purge-legacy` removes those hidden versions too.

## Scheduling

The CLI is a one-shot process. Example systemd user units:

```ini
# ~/.config/systemd/user/hermes-b2-backup.service
[Unit]
Description=Hermes archive backup to Backblaze B2
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/home/you/.npm-global/bin/hermes-b2-backup --once
TimeoutStartSec=2h
Nice=10
IOSchedulingClass=idle
```

```ini
# ~/.config/systemd/user/hermes-b2-backup.timer
[Unit]
Description=Daily Hermes archive backup

[Timer]
OnCalendar=*-*-* 01:00:00 UTC
Persistent=true
AccuracySec=1min

[Install]
WantedBy=timers.target
```

A background service cannot read shell exports, so keep credentials in the config file.

## Security

- The zip contains `.env`, `auth.json`, and full session history in plaintext before encryption. It is created in a private temp directory, chmod 600, and deleted after upload.
- `encryptionKey` is separate from the B2 credentials: a leaked B2 key cannot decrypt the archive.
- If `encryptionKey` is omitted, the engine falls back to deriving the key from the B2 application key and warns. Set a dedicated key.

## Requirements

- Node.js >= 22.5
- The `hermes` CLI (absolute path recommended; `hermesBin` config or `HERMES_BIN`)
- `python3` for zip integrity checks and safe extraction
- `HERMES_HOME` is honored, so non-default homes and tests work.

## License

MIT
