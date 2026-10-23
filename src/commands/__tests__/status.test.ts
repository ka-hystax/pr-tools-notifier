import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseSnapshot } from "../../contract/snapshot.js";
import { ConfigStore } from "../../config/config.js";
import { SettingsStore } from "../../config/settings.js";
import { StateStore } from "../../state/store.js";
import { readFixture as fixture } from "../../__tests__/fixtures.js";
import { runStatus } from "../status.js";
import type { BotCheck } from "../sinks.js";

let root: string;
let config: ConfigStore;
let state: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "prn-status-"));
  config = new ConfigStore(join(root, "cfg"));
  state = join(root, "cfg", "state");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const TOKEN = "123456:SECRET-token_value";

async function status(check: BotCheck = { status: "ok" }, locks: string[] = []) {
  const out: string[] = [];
  const tokens: string[] = [];
  const healthy = await runStatus({
    config,
    stateDir: state,
    settings: new SettingsStore(join(root, "cfg")),
    check: async (token) => {
      tokens.push(token);
      return check;
    },
    activeLocks: () => locks,
    out: (line) => out.push(line),
    now: () => new Date(Date.now() + 5 * 60_000),
    timeZone: "UTC",
  });
  return { healthy, out: out.join("\n"), tokens };
}

describe("runStatus", () => {
  test("says the bot is not set up when there is no config", async () => {
    const r = await status();
    expect(r.healthy).toBe(false);
    expect(r.out).toContain("not set up, run `pr-tools-notifier init`");
    expect(r.tokens).toEqual([]);
  });

  test("shows the bot, the check result and the saved state, never the token", async () => {
    config.save({ botUsername: "my_bot", chatId: "42", token: TOKEN });
    new StateStore(state, "work", "mine").save({ snapshot: parseSnapshot(fixture("mine")), missingTicks: {} });
    const r = await status();
    expect(r.healthy).toBe(true);
    expect(r.tokens).toEqual([TOKEN]);
    expect(r.out).toContain("Bot:     @my_bot, chat 42: token accepted");
    expect(r.out).toMatch(/work mine: \d+ PRs, last poll .* \(5 min ago\)/);
    expect(r.out).not.toContain("SECRET");
  });

  test("marks a state file with a live run", async () => {
    config.save({ botUsername: "my_bot", chatId: "42", token: TOKEN });
    new StateStore(state, "work", "mine").save({ snapshot: parseSnapshot(fixture("mine")), missingTicks: {} });
    const r = await status({ status: "ok" }, [`${join(state, "work-mine.json")}.lock`]);
    expect(r.out).toMatch(/work mine: .*, running$/m);
  });

  test("reports a rejected token as unhealthy and an unreachable Telegram as healthy", async () => {
    config.save({ botUsername: "my_bot", chatId: "42", token: TOKEN });
    const rejected = await status({ status: "rejected", problem: "getMe: 401 Unauthorized (run init)" });
    expect(rejected.healthy).toBe(false);
    expect(rejected.out).toContain("getMe: 401 Unauthorized (run init)");

    const offline = await status({ status: "unreachable", problem: "network error" });
    expect(offline.healthy).toBe(true);
    expect(offline.out).toContain("could not check (network error)");
  });

  test("says when there is no state yet", async () => {
    config.save({ botUsername: "my_bot", chatId: "42", token: TOKEN });
    expect((await status()).out).toContain("State:   none yet");
  });

  test("shows the settings: the Jira merge status and the poll interval", async () => {
    mkdirSync(join(root, "cfg"), { recursive: true });
    writeFileSync(join(root, "cfg", "settings.env"), "MERGE_STATUS=Merge,Ready\nPOLL_INTERVAL=5m\n");
    const r = await status();
    expect(r.out).toContain("settings.env: merge status Merge, Ready, poll every 300s");
  });

  test("shows the defaults without a settings file", async () => {
    expect((await status()).out).toContain("no Jira merge status, default poll interval");
  });

  test("calls a broken settings file unhealthy, since run would refuse it", async () => {
    mkdirSync(join(root, "cfg"), { recursive: true });
    writeFileSync(join(root, "cfg", "settings.env"), "POLL_INTERVAL=1s\n");
    new ConfigStore(join(root, "cfg")).save({ botUsername: "demo_bot", chatId: "1", token: TOKEN });
    const r = await status();
    expect(r.out).toContain("POLL_INTERVAL must be at least 1m");
    expect(r.healthy).toBe(false);
  });
});
