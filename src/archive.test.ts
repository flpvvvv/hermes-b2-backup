import { describe, expect, it } from "vitest";
import {
  chooseSnapshot,
  chunkRanges,
  formatTimestamp,
  groupArchiveObjects,
  parseTimestamp,
  planPrune,
  type ArchiveSnapshot,
} from "./archive.js";
import { archiveMemberExcluded } from "./zip-filter.js";

function snapshot(ts: string, complete: boolean): ArchiveSnapshot {
  return { ts, complete, objects: complete ? 2 : 1, bytes: 10, chunks: complete ? 1 : 1 };
}

describe("timestamps", () => {
  it("round-trips archive directory names", () => {
    const date = new Date("2026-11-18T01:02:03.456Z");
    const ts = formatTimestamp(date);
    expect(ts).toBe("2026-11-18T01-02-03-456Z");
    expect(parseTimestamp(ts)?.toISOString()).toBe(date.toISOString());
  });

  it("rejects malformed names", () => {
    expect(parseTimestamp("2026-11-18T01:02:03Z")).toBeNull();
    expect(parseTimestamp("not-a-snapshot")).toBeNull();
  });
});

describe("chunkRanges", () => {
  it("covers the file exactly", () => {
    expect(chunkRanges(0, 4)).toEqual([]);
    expect(chunkRanges(10, 4)).toEqual([
      { offset: 0, length: 4 },
      { offset: 4, length: 4 },
      { offset: 8, length: 2 },
    ]);
    expect(chunkRanges(8, 4)).toEqual([
      { offset: 0, length: 4 },
      { offset: 4, length: 4 },
    ]);
  });
});

describe("groupArchiveObjects", () => {
  const base = "hermes-flp/archives/";

  it("marks only manifest-bearing snapshots complete", () => {
    const snapshots = groupArchiveObjects(base, [
      { key: `${base}2026-11-17T01-00-00-000Z/data-000.enc`, size: 10 },
      { key: `${base}2026-11-17T01-00-00-000Z/manifest.enc`, size: 5 },
      { key: `${base}2026-11-18T01-00-00-000Z/data-000.enc`, size: 20 },
      { key: "hermes-flp/2026-11-16T01-00-00-000Z/home/config.yaml", size: 99 },
    ]);
    expect(snapshots).toEqual([
      { ts: "2026-11-17T01-00-00-000Z", complete: true, objects: 2, bytes: 15, chunks: 1 },
      { ts: "2026-11-18T01-00-00-000Z", complete: false, objects: 1, bytes: 20, chunks: 1 },
    ]);
  });
});

describe("planPrune", () => {
  const now = Date.parse("2026-11-18T12:00:00.000Z");

  it("keeps exactly the newest N complete snapshots", () => {
    const snapshots = Array.from({ length: 8 }, (_, i) =>
      snapshot(`2026-11-${String(10 + i).padStart(2, "0")}T01-00-00-000Z`, true),
    );
    const { toPrune, staleIncomplete } = planPrune(snapshots, 7, now);
    expect(toPrune.map((s) => s.ts)).toEqual(["2026-11-10T01-00-00-000Z"]);
    expect(staleIncomplete).toEqual([]);
  });

  it("never counts incomplete uploads as retained snapshots", () => {
    const snapshots = [
      snapshot("2026-11-10T01-00-00-000Z", true),
      snapshot("2026-11-11T01-00-00-000Z", true),
      snapshot("2026-11-18T01-00-00-000Z", false),
    ];
    const { toPrune, staleIncomplete } = planPrune(snapshots, 1, now);
    expect(toPrune.map((s) => s.ts)).toEqual(["2026-11-10T01-00-00-000Z"]);
    expect(staleIncomplete).toEqual([]);
  });

  it("cleans incomplete uploads only after a day", () => {
    const snapshots = [
      snapshot("2026-11-18T11-59-00-000Z", false),
      snapshot("2026-11-16T11-59-00-000Z", false),
    ];
    const { staleIncomplete } = planPrune(snapshots, 7, now);
    expect(staleIncomplete.map((s) => s.ts)).toEqual(["2026-11-16T11-59-00-000Z"]);
  });
});

describe("archiveMemberExcluded", () => {
  it("drops Hermes-managed runtime trees but keeps user state", () => {
    for (const member of [
      "bin/hermes",
      "logs/gateway.log",
      "tmp/render.html",
      "models_dev_cache.json",
      "profiles/claire/bin/tool",
      "profiles/claire/logs/session.log",
      "skills/demo/node_modules/pkg/index.js",
      "state.db-wal",
      "gateway_state.json",
    ]) {
      expect(archiveMemberExcluded(member), member).toBe(true);
    }
    for (const member of [
      "config.yaml",
      "state.db",
      ".env",
      "skills/demo/SKILL.md",
      "profiles/claire/state.db",
      "_external/.honcho/state.json",
    ]) {
      expect(archiveMemberExcluded(member), member).toBe(false);
    }
  });
});

describe("chooseSnapshot", () => {
  const snapshots = [
    snapshot("2026-11-16T01-00-00-000Z", true),
    snapshot("2026-11-17T01-00-00-000Z", true),
    snapshot("2026-11-18T01-00-00-000Z", false),
  ];

  it("chooses the newest complete snapshot by default", () => {
    expect(chooseSnapshot(snapshots)?.ts).toBe("2026-11-17T01-00-00-000Z");
  });

  it("honors an explicit complete snapshot", () => {
    expect(chooseSnapshot(snapshots, "2026-11-16T01-00-00-000Z")?.ts).toBe(
      "2026-11-16T01-00-00-000Z",
    );
  });

  it("does not select incomplete or unknown snapshots", () => {
    expect(chooseSnapshot(snapshots, "2026-11-18T01-00-00-000Z")).toBeUndefined();
    expect(chooseSnapshot(snapshots, "2026-11-01T01-00-00-000Z")).toBeUndefined();
  });
});
