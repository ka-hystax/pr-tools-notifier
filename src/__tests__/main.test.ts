import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readVersion } from "../cli/version.js";
import { NOT_CONFIGURED } from "../commands/sinks.js";
import { ConfigStore } from "../config/config.js";
import { configDir } from "../config/paths.js";
import { main } from "../main.js";
import { readFixtureText } from "./fixtures.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "prn-main-"));
  vi.stubEnv("XDG_CONFIG_HOME", join(root, "xdg"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

// Runs the CLI in-process and returns its exit code with everything it printed.
async function cli(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const spies = [
    vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" "))),
    vi.spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" "))),
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    }),
  ];
  try {
    const code = await main(argv);
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    spies.forEach((spy) => spy.mockRestore());
  }
}

// A stand-in for `gh pr-tools` that answers `-p PROFILE <command> --json`.
function fakePrTools(body: string): string {
  const path = join(root, "fake-pr-tools");
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return path;
}

function snapshotsStub(): string {
  writeFileSync(join(root, "mine.json"), readFixtureText("mine"));
  writeFileSync(join(root, "todo.json"), readFixtureText("todo"));
  return fakePrTools(`case "$3" in mine) cat "${root}/mine.json";; todo) cat "${root}/todo.json";; esac`);
}

describe("main", () => {
  test("prints the version", async () => {
    expect(await cli("--version")).toMatchObject({ code: 0, out: `pr-tools-notifier ${readVersion()}` });
  });

  test("prints the usage without arguments", async () => {
    const r = await cli();
    expect(r.code).toBe(0);
    expect(r.out).toContain("usage: pr-tools-notifier");
  });

  test("exits with 2 and the usage for an unknown command", async () => {
    const r = await cli("watch");
    expect(r.code).toBe(2);
    expect(r.err).toContain("unknown command 'watch'");
    expect(r.err).toContain("usage: pr-tools-notifier");
  });

  test.each([["send-test"], ["run", "-p", "demo", "--once"]])("%s asks for init when nothing is set up", async (...argv) => {
    const r = await cli(...argv);
    expect(r.code).toBe(1);
    expect(r.err).toContain(NOT_CONFIGURED);
  });

  test("status says nothing is set up and exits with 1", async () => {
    const r = await cli("status");
    expect(r.code).toBe(1);
    expect(r.out).toContain("not set up");
    expect(r.out).toContain("none yet");
  });

  test("reset -y removes the configuration and reminds about the bot", async () => {
    new ConfigStore(configDir()).save({ botUsername: "demo_bot", chatId: "1", token: "123456:TOKEN" });
    const r = await cli("reset", "-y");
    expect(r.code).toBe(0);
    expect(existsSync(configDir())).toBe(false);
    expect(r.out).toContain("/deletebot");
  });

  test("reset has nothing to do without a configuration", async () => {
    expect(await cli("reset", "-y")).toMatchObject({ code: 0 });
  });

  test("a dry run saves a baseline first and finds nothing new on the next poll", async () => {
    const args = ["run", "-p", "demo", "--dry-run", "--once", "--pr-tools", snapshotsStub()];
    const first = await cli(...args);
    expect(first.code).toBe(0);
    expect(first.err).toMatch(/mine: first run, saved \d+ PRs as the baseline/);
    expect(existsSync(join(configDir(), "state", "dry-run", "demo-mine.json"))).toBe(true);

    const second = await cli(...args);
    expect(second.code).toBe(0);
    expect(second.err).toMatch(/mine: \d+ PRs, 0 new events/);
  });

  test("a run stops when the installed gh-pr-tools does not know --json", async () => {
    const stub = fakePrTools(`echo "gh pr-tools $3: unknown option '--json' (supported: --long)" >&2\nexit 1`);
    const r = await cli("run", "-p", "demo", "--dry-run", "--pr-tools", stub);
    expect(r.code).toBe(1);
    expect(r.err).toContain("stopping: this gh-pr-tools is too old");
  });

  test("a run stops when the first poll reports an unknown profile", async () => {
    const stub = fakePrTools(`echo "gh pr-tools: unknown profile 'demo'" >&2\nexit 1`);
    const r = await cli("run", "-p", "demo", "--dry-run", "--pr-tools", stub);
    expect(r.code).toBe(1);
    expect(r.err).toContain("stopping: that gh-pr-tools profile does not exist");
  });

  test("config sets, shows and removes a setting", async () => {
    expect(await cli("config", "set", "merge-status", "Merge")).toMatchObject({ code: 0 });
    expect((await cli("config")).out).toMatch(/MERGE_STATUS\s+Merge/);
    expect(await cli("config", "set", "poll-interval", "30s")).toMatchObject({ code: 1 });
    expect(await cli("config", "unset", "merge-status")).toMatchObject({ code: 0 });
    expect((await cli("config")).out).toMatch(/MERGE_STATUS\s+not set/);
  });

  test("a run refuses a broken settings file before polling anything", async () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(join(configDir(), "settings.env"), "MERGE_STATUSES=Merge\n");
    const r = await cli("run", "-p", "demo", "--dry-run", "--once", "--pr-tools", snapshotsStub());
    expect(r.code).toBe(1);
    expect(r.err).toContain("unknown setting 'MERGE_STATUSES'");
  });

  test("a run with a Jira merge status stops when gh-pr-tools does not report tickets", async () => {
    await cli("config", "set", "merge-status", "Merge");
    const r = await cli("run", "-p", "demo", "--dry-run", "--once", "--pr-tools", snapshotsStub());
    expect(r.code).toBe(1);
    expect(r.err).toContain("waits for the Jira status: Merge");
    expect(r.err).toContain("stopping: this gh-pr-tools is too old for the Jira merge status");
  });

  describe("without -p", () => {
    // The stub answers `profile list` with the given text, and the snapshots otherwise.
    const stub = (profiles: string) => {
      writeFileSync(join(root, "mine.json"), readFixtureText("mine"));
      writeFileSync(join(root, "todo.json"), readFixtureText("todo"));
      return fakePrTools(
        `case "$1" in profile) printf '%s\n' "${profiles}";; *) case "$3" in mine) cat "${root}/mine.json";; todo) cat "${root}/todo.json";; esac;; esac`
      );
    };

    test("polls the only profile there is", async () => {
      const r = await cli("run", "--dry-run", "--once", "--pr-tools", stub("demo (cwd)"));
      expect(r.code).toBe(0);
      expect(r.err).toContain("profile demo (the only one)");
      expect(existsSync(join(configDir(), "state", "dry-run", "demo-mine.json"))).toBe(true);
    });

    test("asks for a choice when there are several", async () => {
      const r = await cli("run", "--dry-run", "--once", "--pr-tools", stub("a\nb"));
      expect(r.code).toBe(1);
      expect(r.err).toContain("there are several gh-pr-tools profiles (a, b): choose one with -p NAME");
    });

    test("sends to init when there is none", async () => {
      const r = await cli("run", "--dry-run", "--once", "--pr-tools", stub("(no profiles — run: gh pr-tools init)"));
      expect(r.code).toBe(1);
      expect(r.err).toContain("run `gh pr-tools init`");
    });
  });

  describe("answering commands while polling", () => {
    // A tiny Telegram: records every call and hands out the queued updates.
    function fakeTelegram() {
      const calls: { method: string; body: Record<string, any> }[] = [];
      const queue: object[] = [];
      let nextId = 500;
      const reply = (result: unknown) =>
        new Response(JSON.stringify({ ok: true, result }), { headers: { "content-type": "application/json" } });
      const fetchFn = async (url: string, init?: { body?: string; signal?: AbortSignal }) => {
        const method = url.split("/").pop()!;
        const body = JSON.parse(init?.body ?? "{}");
        calls.push({ method, body });
        if (method === "getMe") return reply({ username: "demo_bot" });
        if (method === "sendMessage") return reply({ message_id: nextId++ });
        if (method === "getUpdates") {
          await new Promise((resolve) => setTimeout(resolve, 25));
          if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
          return reply(queue.splice(0));
        }
        return reply(true);
      };
      return { calls, queue, fetchFn };
    }

    test("a /mine typed in Telegram is answered from the same process that polls", async () => {
      new ConfigStore(configDir()).save({ botUsername: "demo_bot", chatId: "42", token: "123456:TOKEN" });
      writeFileSync(join(root, "mine.json"), readFixtureText("mine"));
      writeFileSync(join(root, "todo.json"), readFixtureText("todo"));
      const stub = fakePrTools(
        `case "$1" in profile) echo demo;; *) case "$3" in mine) cat "${root}/mine.json";; todo) cat "${root}/todo.json";; esac;; esac`
      );
      const telegram = fakeTelegram();
      vi.stubGlobal("fetch", telegram.fetchFn);

      const running = cli("run", "--pr-tools", stub);
      await vi.waitFor(() => expect(telegram.calls.some((c) => c.method === "setMyCommands")).toBe(true), { timeout: 5_000 });
      telegram.queue.push({
        update_id: 1,
        message: { message_id: 9, date: Math.floor(Date.now() / 1000), text: "/mine", chat: { id: 42, type: "private" } },
      });
      await vi.waitFor(() => expect(telegram.calls.some((c) => (c.body.text ?? "").includes("Mine"))).toBe(true), {
        timeout: 5_000,
      });
      await vi.waitFor(() =>
        expect(telegram.calls.some((c) => c.method === "deleteMessage" && c.body.message_id === 9)).toBe(true)
      );

      process.emit("SIGINT");
      const result = await running;
      vi.unstubAllGlobals();
      expect(result.code).toBe(0);
      expect(result.err).toContain("listening for commands");
      expect(existsSync(join(configDir(), "state", "bot.lock"))).toBe(false);
    });

    test("a second run only sends notifications while the first one answers", async () => {
      new ConfigStore(configDir()).save({ botUsername: "demo_bot", chatId: "42", token: "123456:TOKEN" });
      writeFileSync(join(root, "mine.json"), readFixtureText("mine"));
      writeFileSync(join(root, "todo.json"), readFixtureText("todo"));
      const stub = fakePrTools(
        `case "$1" in profile) echo demo;; *) case "$3" in mine) cat "${root}/mine.json";; todo) cat "${root}/todo.json";; esac;; esac`
      );
      mkdirSync(join(configDir(), "state"), { recursive: true });
      writeFileSync(join(configDir(), "state", "bot.lock"), String(process.pid));
      const telegram = fakeTelegram();
      vi.stubGlobal("fetch", telegram.fetchFn);

      const running = cli("run", "--pr-tools", stub);
      // The first poll saves the baseline, which only happens once the run is up and listening for Ctrl+C.
      await vi.waitFor(() => expect(existsSync(join(configDir(), "state", "demo-mine.json"))).toBe(true), { timeout: 5_000 });
      process.emit("SIGINT");
      const result = await running;
      vi.unstubAllGlobals();
      expect(result.err).toContain("another run already answers commands");
      expect(telegram.calls.some((c) => c.method === "getUpdates")).toBe(false);
    });
  });
});
