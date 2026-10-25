import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SettingsStore } from "../../config/settings.js";
import type { Logger } from "../../runner/types.js";
import { liveSettings, pollInterval } from "../run.js";

describe("pollInterval", () => {
  test("the --interval flag wins over the setting", () => {
    expect(pollInterval({ intervalMs: 120_000 }, { intervalMs: 300_000 })).toBe(120_000);
  });

  test("the setting wins over the default", () => {
    expect(pollInterval({}, { intervalMs: 300_000 })).toBe(300_000);
  });

  test("falls back to one minute", () => {
    expect(pollInterval({}, {})).toBe(60_000);
  });
});

describe("liveSettings", () => {
  let dir: string;
  let store: SettingsStore;
  let logs: string[];
  const log: Logger = {
    info: (m) => logs.push(`info: ${m}`),
    warn: (m) => logs.push(`warn: ${m}`),
    error: (m) => logs.push(`error: ${m}`),
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "prn-live-"));
    store = new SettingsStore(dir);
    logs = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("picks up a change made while running, and says so once", () => {
    const settings = liveSettings(store, log);
    expect(settings()).toEqual({});
    store.set("POLL_INTERVAL", "5m");
    store.set("MERGE_STATUS", "Merge");
    expect(settings()).toEqual({ intervalMs: 300_000, mergeStatuses: ["Merge"] });
    expect(settings()).toEqual({ intervalMs: 300_000, mergeStatuses: ["Merge"] });
    expect(logs).toEqual(["info: settings changed: poll every 5m, Jira merge status Merge"]);
  });

  test("keeps the last good settings when the file is broken by hand, warning once per mistake", () => {
    store.set("POLL_INTERVAL", "5m");
    const settings = liveSettings(store, log);
    writeFileSync(store.path, "POLL_INTERVAL=5m\nTYPO=1\n");
    expect(settings()).toEqual({ intervalMs: 300_000 });
    expect(settings()).toEqual({ intervalMs: 300_000 });
    expect(logs.filter((l) => l.startsWith("warn:"))).toHaveLength(1);
    expect(logs[0]).toContain("unknown setting 'TYPO'");
    expect(logs[0]).toContain("keeping the previous settings");
    writeFileSync(store.path, "POLL_INTERVAL=10m\n");
    expect(settings()).toEqual({ intervalMs: 600_000 });
  });

  test("without a store there is nothing to read", () => {
    expect(liveSettings(undefined, log)()).toEqual({});
  });
});
