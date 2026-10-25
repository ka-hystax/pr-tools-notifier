import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ConfigStore } from "../../config/config.js";
import { SettingsStore } from "../../config/settings.js";
import { runInit, type InitApi, type Prompter } from "../init.js";
import type { Update } from "../../telegram/api.js";

let root: string;
let config: ConfigStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "prn-init-"));
  config = new ConfigStore(join(root, "cfg"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const TOKEN = "123456:SECRET-token_value";
const CODE = "abc123";

const start = (id: number, chatId: number, text = `/start ${CODE}`, type = "private"): Update => ({
  update_id: id,
  message: { message_id: id, date: 0, text, chat: { id: chatId, type } },
});

interface Scenario {
  answers?: string[];
  secret?: string;
  confirm?: boolean;
  me?: () => Promise<{ username: string }>;
  polls?: (Update[] | Error)[];
  send?: Error;
  settings?: SettingsStore;
}

function run(s: Scenario = {}) {
  const out: string[] = [];
  const asked: string[] = [];
  const offsets: (number | undefined)[] = [];
  const sent: { chatId: string | number; text: string; keyboard?: string[][] | undefined }[] = [];
  const created: string[] = [];
  const answers = [...(s.answers ?? [])];
  let polls = 0;
  let clock = 0;

  const prompter: Prompter = {
    async ask(question) {
      asked.push(question);
      return answers.shift() ?? "";
    },
    async secret() {
      return s.secret ?? TOKEN;
    },
    async confirm() {
      return s.confirm ?? false;
    },
  };
  const api: InitApi = {
    getMe: s.me ?? (async () => ({ username: "my_pr_bot" })),
    async getUpdates(offset) {
      offsets.push(offset);
      const next = (s.polls ?? [])[polls++] ?? [];
      clock += 70_000;
      if (next instanceof Error) throw next;
      return next;
    },
    async sendMessage(params) {
      if (s.send) throw s.send;
      sent.push({ chatId: params.chatId, text: params.text, keyboard: params.keyboard });
    },
  };

  const result = runInit({
    prompter,
    config,
    ...(s.settings ? { settings: s.settings } : {}),
    createApi: (token) => {
      created.push(token);
      return api;
    },
    out: (line) => out.push(line),
    newCode: () => CODE,
    now: () => clock,
  });
  return { result, out, asked, offsets, sent, created };
}

describe("runInit", () => {
  test("says what is required and what is optional, and installs the buttons with the greeting", async () => {
    const h = run({ polls: [[start(1, 42)]] });
    await h.result;
    expect(h.out.join("\n")).toContain("Needed: gh-pr-tools with a profile");
    expect(h.out.join("\n")).toContain("Jira is optional");
    expect(h.sent[0]!.keyboard).toEqual([
      ["📥 Todo", "📤 Mine"],
      ["ℹ️ Status", "⚙️ Settings"],
    ]);
    expect(h.sent[0]!.text).toContain("/todo");
  });

  test("captures the chat id from the start message that carries the code, then saves", async () => {
    const h = run({ polls: [[start(1, 5, "/start other"), start(2, 42)]] });
    expect(await h.result).toBe(true);
    expect(config.load()).toEqual({ botUsername: "my_pr_bot", chatId: "42", token: TOKEN });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ chatId: "42" });
    expect(h.sent[0]!.text).toContain("Connected");
    expect(h.out.join("\n")).toContain(`https://t.me/my_pr_bot?start=${CODE}`);
  });

  test("never prints the token", async () => {
    const h = run({ polls: [[start(1, 42)]] });
    await h.result;
    expect(h.out.join("\n")).not.toContain("SECRET");
  });

  test("keeps polling past other messages and moves the offset forward", async () => {
    const h = run({ polls: [[start(10, 5, "/start nope")], [start(11, 42)]] });
    expect(await h.result).toBe(true);
    expect(h.offsets).toEqual([undefined, 11]);
  });

  test("ignores the code when it comes from a group chat", async () => {
    const h = run({ polls: [[start(1, -100, `/start ${CODE}`, "group")]], answers: [""] });
    expect(await h.result).toBe(false);
    expect(config.exists()).toBe(false);
  });

  test("falls back to a pasted chat id when nothing arrives in time", async () => {
    const h = run({ answers: ["777"] });
    expect(await h.result).toBe(true);
    expect(config.load()?.chatId).toBe("777");
    expect(h.sent[0]).toMatchObject({ chatId: "777" });
    expect(h.out.join("\n")).toContain("Did not see your message in time");
  });

  test("cancels without saving when no chat id is pasted or it is not a number", async () => {
    expect(await run({ answers: [""] }).result).toBe(false);
    expect(await run({ answers: ["abc"] }).result).toBe(false);
    expect(config.exists()).toBe(false);
  });

  test("rejects something that is not a bot token before calling Telegram", async () => {
    const h = run({ secret: "not a token" });
    expect(await h.result).toBe(false);
    expect(h.created).toEqual([]);
    expect(h.out.join("\n")).toContain("does not look like a bot token");
  });

  test("reports a token Telegram refuses", async () => {
    const h = run({ me: async () => Promise.reject(new Error("getMe: 401 Unauthorized")) });
    expect(await h.result).toBe(false);
    expect(h.out.join("\n")).toContain("Telegram did not accept the token: getMe: 401 Unauthorized");
    expect(config.exists()).toBe(false);
  });

  test("reports when the bot's messages cannot be read, for example while a webhook is set", async () => {
    const h = run({ polls: [new Error("getUpdates: 409 Conflict: can't use getUpdates method while webhook is active")] });
    expect(await h.result).toBe(false);
    expect(h.out.join("\n")).toContain("Could not read the bot's messages");
    expect(config.exists()).toBe(false);
  });

  test("does not save a chat id that Telegram cannot send to", async () => {
    const h = run({ polls: [[start(1, 42)]], send: new Error("sendMessage: 403 Forbidden") });
    expect(await h.result).toBe(false);
    expect(h.out.join("\n")).toContain("Could not send a message to that chat");
    expect(config.exists()).toBe(false);
  });

  test("leaves an existing configuration alone unless told to replace it", async () => {
    config.save({ botUsername: "old_bot", chatId: "1", token: "999:OLD" });
    const declined = run({ confirm: false });
    expect(await declined.result).toBe(false);
    expect(declined.created).toEqual([]);
    expect(config.load()?.botUsername).toBe("old_bot");

    const accepted = run({ confirm: true, polls: [[start(1, 42)]] });
    expect(await accepted.result).toBe(true);
    expect(config.load()).toEqual({ botUsername: "my_pr_bot", chatId: "42", token: TOKEN });
  });
});

describe("runInit: the optional Jira question", () => {
  let settings: SettingsStore;

  beforeEach(() => {
    settings = new SettingsStore(join(root, "cfg"));
  });

  test("is not asked without a settings store", async () => {
    const h = run({ polls: [[start(1, 42)]], confirm: true });
    await h.result;
    expect(h.out.join("\n")).not.toContain("Jira:");
  });

  test("can be skipped: nothing is saved and the later command is shown", async () => {
    const h = run({ polls: [[start(1, 42)]], settings });
    expect(await h.result).toBe(true);
    expect(h.out.join("\n")).toContain("Optional, Jira:");
    expect(h.out.join("\n")).toContain("`pr-tools-notifier config set merge-status Merge`");
    expect(settings.exists()).toBe(false);
  });

  test("saves the statuses and reminds that Jira is read through the gh-pr-tools profile", async () => {
    const h = run({ polls: [[start(1, 42)]], settings, confirm: true, answers: [" Merge , Ready "] });
    expect(await h.result).toBe(true);
    expect(settings.load().mergeStatuses).toEqual(["Merge", "Ready"]);
    expect(h.out.join("\n")).toContain("Saved MERGE_STATUS=Merge,Ready.");
    expect(h.out.join("\n")).toContain("gh-pr-tools profile");
  });

  test("an empty answer saves nothing", async () => {
    const h = run({ polls: [[start(1, 42)]], settings, confirm: true, answers: ["  "] });
    expect(await h.result).toBe(true);
    expect(settings.exists()).toBe(false);
    expect(h.out.join("\n")).toContain("No status entered, skipped.");
  });

  test("is not asked again when a status is already set", async () => {
    settings.set("MERGE_STATUS", "Merge");
    const h = run({ polls: [[start(1, 42)]], settings, confirm: true });
    await h.result;
    expect(h.out.join("\n")).toContain("waits for Merge (already set");
    expect(h.out.join("\n")).not.toContain("Set it up now");
  });

  test("a broken settings file does not undo a saved bot", async () => {
    mkdirSync(join(root, "cfg"), { recursive: true });
    writeFileSync(settings.path, "NOPE=1\n");
    const h = run({ polls: [[start(1, 42)]], settings });
    expect(await h.result).toBe(true);
    expect(config.exists()).toBe(true);
    expect(h.out.join("\n")).toContain("Could not save the Jira setting");
  });
});
