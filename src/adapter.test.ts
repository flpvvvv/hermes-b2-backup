import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shouldInclude } from "@backblaze-labs/agent-backup-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hermesAdapter, hermesCandidateRoots } from "./adapter.js";

describe("hermesCandidateRoots", () => {
  it("uses ~/.hermes by default and honors HERMES_HOME", () => {
    const def = hermesCandidateRoots({} as NodeJS.ProcessEnv);
    expect(def.find((r) => r.label === "home")?.dir).toBe(path.join(os.homedir(), ".hermes"));

    const overridden = hermesCandidateRoots({ HERMES_HOME: "/custom/hermes" } as NodeJS.ProcessEnv);
    expect(overridden.find((r) => r.label === "home")?.dir).toBe("/custom/hermes");
  });

  it("includes external memory-provider roots", () => {
    const roots = hermesCandidateRoots({} as NodeJS.ProcessEnv);
    expect(roots.map((r) => r.label)).toEqual(["home", "honcho", "hindsight"]);
  });
});

describe("hermesAdapter.resolveRoots", () => {
  let home: string;
  beforeEach(async () => {
    home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "hermes-home-"));
    await fs.promises.mkdir(path.join(home, "memories"), { recursive: true });
  });
  afterEach(async () => {
    await fs.promises.rm(home, { recursive: true, force: true });
  });

  it("returns the home root when it exists, drops absent provider roots", () => {
    const roots = hermesAdapter.resolveRoots({ HERMES_HOME: home } as NodeJS.ProcessEnv);
    expect(roots.map((r) => r.label)).toEqual(["home"]);
  });
});

describe("hermesAdapter include/exclude/sqlite patterns", () => {
  const patterns = {
    include: hermesAdapter.include,
    exclude: hermesAdapter.exclude,
    secretExclude: hermesAdapter.secretExclude,
  };

  it("includes state, secrets, memory, skills, profiles", () => {
    for (const p of [
      "home/state.db",
      "home/config.yaml",
      "home/.env", // secret — INCLUDED (encrypted) by policy
      "home/auth.json", // secret — INCLUDED (encrypted) by policy
      "home/SOUL.md",
      "home/memories/MEMORY.md",
      "home/skills/my-skill/SKILL.md",
      "home/skills/.archive/old.md",
      "home/cron/jobs.json",
      "home/profiles/work/state.db",
      "honcho/store.db",
    ]) {
      expect(shouldInclude(p, patterns)).toBe(true);
    }
  });

  it("excludes regeneratable, machine-local, and sidecar files", () => {
    for (const p of [
      "home/hermes-agent/main.py",
      "home/node/bin/node",
      "home/.venv/lib/python.py",
      "home/cache/images/x.png",
      "home/logs/agent.log",
      "home/backups/pre-update.zip",
      "home/state.db-wal",
      "home/state.db-shm",
      "home/gateway.lock",
      "home/processes.json",
      "home/gateway_state.json",
      // Per-profile copies of regeneratable dirs must be excluded too.
      "home/profiles/work/logs/agent.log",
      "home/profiles/work/node/bin/node",
      "home/profiles/work/checkpoints/x",
      // Per-platform toolchains and Hermes-managed binaries are re-downloadable.
      "home/tools/ffmpeg-9.0.1-linux-x64/ffmpeg",
      "home/tools/node-26.12.1-linux-x64/bin/node",
      "home/tools/python-3.14.9-linux-x64/lib/python3.14/os.py",
      "home/bin/uv",
      "home/lsp/node_modules/typescript/lib/tsc.js",
      "home/profiles/work/tools/node-26.12.1-linux-x64/bin/node",
      // uv-managed venvs / package-manager runtimes.
      "home/installs/13f0a2f8115124fd/environments/abc/bin/python",
      "home/installs/13f0a2f8115124fd/pm-runtime/generations/1/x",
      // Model metadata caches.
      "home/models_dev_cache.json",
      "home/provider_models_cache.json",
      "home/profiles/work/models_dev_cache.json",
      "home/tmp/nvda_spacex.html",
    ]) {
      expect(shouldInclude(p, patterns)).toBe(false);
    }
  });

  it("still includes real per-profile state", () => {
    expect(shouldInclude("home/profiles/work/state.db", patterns)).toBe(true);
    expect(shouldInclude("home/profiles/work/memories/MEMORY.md", patterns)).toBe(true);
    expect(shouldInclude("home/profiles/work/skills/my-skill/SKILL.md", patterns)).toBe(true);
    expect(shouldInclude("home/profiles/work/models_dev_cache.json", patterns)).toBe(false);
  });

  it("flags state.db (incl. per-profile) as SQLite needing a safe snapshot", () => {
    expect(hermesAdapter.sqlite.some((r) => r.test("home/state.db"))).toBe(true);
    expect(hermesAdapter.sqlite.some((r) => r.test("home/profiles/work/state.db"))).toBe(true);
  });
});
