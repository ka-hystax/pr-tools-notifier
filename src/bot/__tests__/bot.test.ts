import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseSnapshot, type MineSnapshot, type Snapshot, type TodoSnapshot } from "../../contract/snapshot.js";
import { readFixture } from "../../__tests__/fixtures.js";
import type { Command, Logger, SnapshotSource } from "../../runner/types.js";
import { StateStore } from "../../state/store.js";
import { TelegramError, type BotCommand, type EditParams, type SendParams, type Update } from "../../telegram/api.js";
import { Bot, BOT_COMMANDS, KEYBOARD, parseAction, type BotDeps } from "../bot.js";
import { BotStateStore } from "../state.js";
import type { BotApi } from "../types.js";

const CHAT = "42";
const mine = parseSnapshot(readFixture("mine")) as MineSnapshot;
const todo = parseSnapshot(readFixture("todo")) as TodoSnapshot;
const GENERATED = Date.parse(mine.generatedAt);

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "prn-bot-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

class FakeApi implements BotApi {
  sent: { id: number; params: SendParams }[] = [];
  edits: EditParams[] = [];
  deleted: number[] = [];
  answers: { id: string; text?: string }[] = [];
  commands: BotCommand[] = [];
  polls: (Update[] | Error)[] = [];
  offsets: (number | undefined)[] = [];
  failDelete = false;
  failEdit: Error | null = null;
  failSend: Error | null = null;
  private next = 100;

  constructor(private readonly signal: AbortSignal) {}

  async getUpdates(offset: number | undefined): Promise<Update[]> {
    this.offsets.push(offset);
    const poll = this.polls.shift();
    if (poll instanceof Error) throw poll;
    if (poll) return poll;
    await new Promise<void>((resolve) => this.signal.addEventListener("abort", () => resolve(), { once: true }));
    throw new TelegramError("getUpdates: aborted", null);
  }
  async sendMessage(params: SendParams) {
    if (this.failSend) {
      const error = this.failSend;
      this.failSend = null;
      throw error;
    }
    const id = this.next++;
    this.sent.push({ id, params });
    return { messageId: id };
  }
  async editMessageText(params: EditParams) {
    if (this.failEdit) throw this.failEdit;
    this.edits.push(params);
  }
  async deleteMessage(_chat: string | number, messageId: number) {
    if (this.failDelete) throw new TelegramError("deleteMessage: 400 message can't be deleted", 400);
    this.deleted.push(messageId);
  }
  async answerCallbackQuery(id: string, text?: string) {
    this.answers.push({ id, ...(text ? { text } : {}) });
  }
  async setMyCommands(commands: BotCommand[]) {
    this.commands = commands;
  }
}

function harness(over: Partial<BotDeps> = {}, options: { saved?: Partial<Record<Command, Snapshot>>; ageMs?: number } = {}) {
  const controller = new AbortController();
  const api = new FakeApi(controller.signal);
  const logs: string[] = [];
  const log: Logger = {
    info: (m) => logs.push(`info: ${m}`),
    warn: (m) => logs.push(`warn: ${m}`),
    error: (m) => logs.push(`error: ${m}`),
  };
  const stores = { mine: new StateStore(root, "work", "mine"), todo: new StateStore(root, "work", "todo") };
  const saved = options.saved ?? { mine, todo };
  for (const [kind, snapshot] of Object.entries(saved)) stores[kind as Command].save({ snapshot, missingTicks: {} });
  const fetched: Command[] = [];
  const failures: { source?: Error } = {};
  const fresh: Record<Command, Snapshot> = { mine: structuredClone(mine), todo: structuredClone(todo) };
  const source: SnapshotSource = async (kind) => {
    fetched.push(kind);
    if (failures.source) throw failures.source;
    return structuredClone(fresh[kind]);
  };
  let clock = GENERATED + (options.ageMs ?? 30_000);
  const state = new BotStateStore(root);
  const bot = new Bot({
    api,
    chatId: CHAT,
    profile: "work",
    commands: ["mine", "todo"],
    source,
    stores,
    state,
    log,
    signal: controller.signal,
    settings: () => ({ intervalMs: 300_000 }),
    timeZone: "UTC",
    now: () => new Date(clock),
    pollSeconds: 1,
    ...over,
  });
  const message = (text: string, id = 1, over: { chat?: number; date?: number } = {}): Update => ({
    update_id: id,
    message: {
      message_id: id,
      date: over.date ?? Math.floor(clock / 1000),
      text,
      chat: { id: over.chat ?? Number(CHAT), type: "private" },
    },
  });
  const tap = (data: string, messageId: number, chat = Number(CHAT)): Update => ({
    update_id: 500,
    callback_query: { id: `q${data}`, data, message: { message_id: messageId, chat: { id: chat, type: "private" } } },
  });
  return {
    api,
    bot,
    controller,
    logs,
    stores,
    state,
    fetched,
    failures,
    fresh,
    message,
    tap,
    advance: (ms: number) => void (clock += ms),
    texts: () => api.sent.map((s) => s.params.text),
  };
}

const buttonData = (params: SendParams | EditParams) =>
  (params.buttons ?? []).flat().map((b) => ("data" in b ? b.data : b.url));

describe("parseAction", () => {
  test.each([
    ["/todo", "todo"],
    ["/mine", "mine"],
    ["/status", "status"],
    ["/help", "help"],
    ["/start", "help"],
    ["/start abc123", "help"],
    ["/todo@my_bot", "todo"],
    ["/MINE", "mine"],
    ["📥 Todo", "todo"],
    ["📤 Mine", "mine"],
    ["ℹ️ Status", "status"],
    ["/nope", "unknown"],
    ["hello", "unknown"],
    ["", "unknown"],
  ])("%j is %s", (text, action) => {
    expect(parseAction(text)).toBe(action);
  });
});

describe("who is heard", () => {
  test("ignores another chat, and says so once", async () => {
    const h = harness();
    await h.bot.handle(h.message("/mine", 1, { chat: 7 }));
    await h.bot.handle(h.message("/mine", 2, { chat: 7 }));
    expect(h.api.sent).toEqual([]);
    expect(h.api.deleted).toEqual([]);
    expect(h.logs.filter((l) => l.includes("unknown chat"))).toEqual(["warn: ignored a message from an unknown chat (7)"]);
  });

  test("ignores taps from another chat", async () => {
    const h = harness();
    await h.bot.handle(h.tap("x", 5, 7));
    expect(h.api.answers).toEqual([]);
    expect(h.api.deleted).toEqual([]);
  });

  test("drops a command that is too old, and one without text", async () => {
    const h = harness();
    await h.bot.handle(h.message("/mine", 1, { date: Math.floor((GENERATED + 30_000) / 1000) - 3_600 }));
    await h.bot.handle({
      update_id: 3,
      message: { message_id: 3, date: Math.floor((GENERATED + 30_000) / 1000), chat: { id: 42, type: "private" } },
    });
    expect(h.api.sent).toEqual([]);
    expect(h.logs).toContain("info: ignored a command that is too old");
  });
});

describe("lists", () => {
  test("answers /mine from the saved poll when it is recent, without asking GitHub", async () => {
    const h = harness();
    await h.bot.handle(h.message("/mine", 11));
    expect(h.fetched).toEqual([]);
    expect(h.api.sent).toHaveLength(1);
    expect(h.api.sent[0]!.params.text).toContain("📤");
    expect(h.api.sent[0]!.params.text).toContain("Mine");
    expect(buttonData(h.api.sent[0]!.params)).toEqual(["r:mine", "x"]);
    expect(h.api.deleted).toEqual([11]); // the command itself is taken down
  });

  test("answers /todo the same way", async () => {
    const h = harness();
    await h.bot.handle(h.message("📥 Todo", 12));
    expect(h.api.sent[0]!.params.text).toContain("Todo");
    expect(buttonData(h.api.sent[0]!.params)).toEqual(["r:todo", "x"]);
  });

  test("asks GitHub when the saved poll is old, showing a placeholder first", async () => {
    const h = harness({}, { ageMs: 3_600_000 });
    await h.bot.handle(h.message("/mine", 11));
    expect(h.fetched).toEqual(["mine"]);
    expect(h.texts()).toEqual(["⏳ Loading…"]);
    expect(h.api.edits).toHaveLength(1);
    expect(h.api.edits[0]!.messageId).toBe(h.api.sent[0]!.id);
    expect(h.api.edits[0]!.text).toContain("Mine");
    expect(h.api.deleted).toEqual([11]);
  });

  test("asking does not move the baseline that notifications are computed from", async () => {
    const h = harness({}, { ageMs: 3_600_000 });
    const before = JSON.stringify(h.stores.mine.peek());
    await h.bot.handle(h.message("/mine", 11));
    expect(JSON.stringify(h.stores.mine.peek())).toBe(before);
  });

  test("falls back to the saved poll with a note when GitHub cannot be reached", async () => {
    const h = harness({}, { ageMs: 3_600_000 });
    h.failures.source = new Error("timed out after 120s");
    await h.bot.handle(h.message("/mine", 11));
    expect(h.api.edits[0]!.text).toContain("⚠️ Could not refresh: timed out after 120s");
    expect(h.api.edits[0]!.text).toContain("as of 10:00");
  });

  test("says so when there is nothing saved and GitHub fails", async () => {
    const h = harness({}, { saved: {}, ageMs: 0 });
    h.failures.source = new Error("exited with 1: boom <b>");
    await h.bot.handle(h.message("/mine", 11));
    expect(h.api.edits[0]!.text).toBe("⚠️ Could not load mine: exited with 1: boom &lt;b&gt;");
  });

  test("a list the run does not poll is explained", async () => {
    const h = harness({ commands: ["mine"] });
    await h.bot.handle(h.message("/todo", 11));
    expect(h.texts()[0]).toContain("does not poll todo");
  });

  test("a new answer replaces the previous one and the command that asked for it", async () => {
    const h = harness();
    await h.bot.handle(h.message("/mine", 11));
    const first = h.api.sent[0]!.id;
    await h.bot.handle(h.message("/todo", 12));
    expect(h.api.sent).toHaveLength(2);
    expect(h.api.deleted).toEqual([11, first, 12]);
    expect(h.state.load().view).toEqual([h.api.sent[1]!.id]);
  });

  test("a message that cannot be deleted is not a problem", async () => {
    const h = harness();
    h.api.failDelete = true;
    await h.bot.handle(h.message("/mine", 11));
    await h.bot.handle(h.message("/todo", 12));
    expect(h.api.sent).toHaveLength(2);
    expect(h.logs.some((l) => l.includes("could not delete message"))).toBe(true);
  });
});

describe("buttons", () => {
  test("Refresh fetches fresh data and edits the same message", async () => {
    const h = harness();
    await h.bot.handle(h.message("/mine", 11));
    const id = h.api.sent[0]!.id;
    await h.bot.handle(h.tap("r:mine", id));
    expect(h.api.answers.at(-1)).toEqual({ id: "qr:mine", text: "Refreshing…" });
    expect(h.fetched).toEqual(["mine"]);
    expect(h.api.edits.at(-1)!.messageId).toBe(id);
    expect(h.api.sent).toHaveLength(1);
  });

  test("Refresh keeps what was shown and says so when GitHub fails", async () => {
    const h = harness();
    await h.bot.handle(h.message("/mine", 11));
    h.failures.source = new Error("rate limit");
    await h.bot.handle(h.tap("r:mine", h.api.sent[0]!.id));
    expect(h.api.edits.at(-1)!.text).toContain("Mine");
    expect(h.api.edits.at(-1)!.text).toContain("⚠️ Could not refresh: rate limit");
  });

  test("Refresh with nothing identical to show is quiet about 'not modified'", async () => {
    const h = harness();
    await h.bot.handle(h.message("/mine", 11));
    h.api.failEdit = new TelegramError("editMessageText: 400 Bad Request: message is not modified", 400);
    await expect(h.bot.handle(h.tap("r:mine", h.api.sent[0]!.id))).resolves.toBeUndefined();
  });

  test("Close takes the answer down", async () => {
    const h = harness();
    await h.bot.handle(h.message("/mine", 11));
    const id = h.api.sent[0]!.id;
    await h.bot.handle(h.tap("x", id));
    expect(h.api.deleted).toContain(id);
    expect(h.state.load().view).toEqual([]);
  });

  test("a tap on an answer that was replaced says it is out of date and removes it", async () => {
    const h = harness();
    await h.bot.handle(h.message("/mine", 11));
    const old = h.api.sent[0]!.id;
    await h.bot.handle(h.message("/todo", 12));
    h.api.deleted.length = 0;
    await h.bot.handle(h.tap("r:mine", old));
    expect(h.api.answers.at(-1)).toMatchObject({ text: "That message is out of date" });
    expect(h.api.deleted).toEqual([old]);
    expect(h.fetched).toEqual([]);
  });

  test("pages are turned from what is on screen, without asking GitHub", async () => {
    const many: MineSnapshot = {
      ...mine,
      prs: Array.from({ length: 50 }, (_, i) => ({
        ...structuredClone(mine.prs[1]!),
        number: 2000 + i,
        title: "A pull request title long enough to fill the page quickly",
      })),
    };
    const h = harness({}, { saved: { mine: many } });
    await h.bot.handle(h.message("/mine", 11));
    const first = h.api.sent[0]!;
    expect(buttonData(first.params)).toEqual(["p:mine:1", "r:mine", "x"]);
    await h.bot.handle(h.tap("p:mine:1", first.id));
    expect(h.fetched).toEqual([]);
    expect(h.api.edits.at(-1)!.text).toMatch(/· 2\/\d+/);
    expect(buttonData(h.api.edits.at(-1)!)).toContain("p:mine:0");
  });

  test("an unknown or foreign callback is just acknowledged", async () => {
    const h = harness();
    await h.bot.handle(h.message("/mine", 11));
    await h.bot.handle(h.tap("p:todo:1", h.api.sent[0]!.id));
    await h.bot.handle(h.tap("zzz", h.api.sent[0]!.id));
    expect(h.api.edits).toEqual([]);
  });
});

describe("help and status", () => {
  test("/help and /start answer with the keyboard", async () => {
    const h = harness();
    await h.bot.handle(h.message("/start abc", 11));
    expect(h.api.sent[0]!.params.keyboard).toEqual(KEYBOARD);
    expect(h.texts()[0]).toContain("/todo");
    expect(h.api.deleted).toEqual([11]);
  });

  test("an unknown message gets the help with a hint", async () => {
    const h = harness();
    await h.bot.handle(h.message("what", 11));
    expect(h.texts()[0]).toMatch(/^🤷 I did not get that\./);
  });

  test("/status shows the profile, the last polls and the settings", async () => {
    const h = harness({ settings: () => ({ intervalMs: 300_000, mergeStatuses: ["Merge", "Ready"] }) });
    await h.bot.handle(h.message("/status", 11));
    const text = h.texts()[0]!;
    expect(text).toContain("profile <code>work</code>");
    expect(text).toContain("mine: 3 PRs, polled 0m ago");
    expect(text).toContain("todo: 2 PRs");
    expect(text).toContain("every 5 min");
    expect(text).toContain("Jira: Merge, Ready");
    expect(buttonData(h.api.sent[0]!.params)).toEqual(["x"]);
  });

  test("/status says when nothing was polled yet", async () => {
    const h = harness({}, { saved: {} });
    await h.bot.handle(h.message("/status", 11));
    expect(h.texts()[0]).toContain("mine: not polled yet");
  });
});

describe("run", () => {
  test("registers the commands, introduces itself once and stops on abort", async () => {
    const h = harness();
    const done = h.bot.run();
    await new Promise((r) => setTimeout(r, 20));
    h.controller.abort();
    await done;
    expect(h.api.commands).toEqual(BOT_COMMANDS);
    expect(h.texts()).toHaveLength(1);
    expect(h.api.sent[0]!.params.keyboard).toEqual(KEYBOARD);
    expect(h.state.load().intro).toBe(true);
  });

  test("does not introduce itself again, and takes down the answer a previous run left", async () => {
    const h = harness();
    h.state.save({ intro: true, view: [77] });
    const done = h.bot.run();
    await new Promise((r) => setTimeout(r, 20));
    h.controller.abort();
    await done;
    expect(h.api.sent).toEqual([]);
    expect(h.api.deleted).toEqual([77]);
    expect(h.state.load().view).toEqual([]);
  });

  test("handles updates in order, confirming each by moving the offset", async () => {
    const h = harness();
    h.state.save({ intro: true, view: [] });
    h.api.polls.push([h.message("/mine", 5), h.message("/todo", 6)]);
    const done = h.bot.run();
    await new Promise((r) => setTimeout(r, 30));
    h.controller.abort();
    await done;
    expect(h.api.sent).toHaveLength(2);
    expect(h.api.offsets.slice(0, 2)).toEqual([undefined, 7]);
  });

  test("one command failing does not stop the next", async () => {
    const h = harness();
    h.state.save({ intro: true, view: [] });
    h.api.failSend = new TelegramError("sendMessage: 502 Bad Gateway", 502);
    h.api.polls.push([h.message("/mine", 5), h.message("/status", 6)]);
    const done = h.bot.run();
    await new Promise((r) => setTimeout(r, 30));
    h.controller.abort();
    await done;
    expect(h.logs.some((l) => l.startsWith("error: command failed: sendMessage: 502"))).toBe(true);
    expect(h.texts()).toHaveLength(1);
    expect(h.texts()[0]).toContain("Status");
  });

  test("gives up when Telegram says another reader has the bot", async () => {
    const h = harness();
    h.state.save({ intro: true, view: [] });
    h.api.polls.push(new TelegramError("getUpdates: 409 Conflict: terminated by other getUpdates request", 409));
    await h.bot.run();
    expect(h.logs.some((l) => l.startsWith("error: commands are off") && l.includes("another program reads"))).toBe(true);
  });

  test("keeps trying after a network failure", async () => {
    const h = harness();
    h.state.save({ intro: true, view: [] });
    h.api.polls.push(new TelegramError("getUpdates: network error: offline", null));
    const done = h.bot.run();
    await new Promise((r) => setTimeout(r, 30));
    h.controller.abort();
    await done;
    expect(h.logs.filter((l) => l.startsWith("warn: listening for commands"))).toHaveLength(1);
  });
});
