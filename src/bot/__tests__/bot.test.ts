import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  parseSnapshot,
  type MineSnapshot,
  type Snapshot,
  type TodoSnapshot,
  type TrackSnapshot,
} from "../../contract/snapshot.js";
import { readFixture } from "../../__tests__/fixtures.js";
import type { Command, Logger, SnapshotSource } from "../../runner/types.js";
import { StateStore } from "../../state/store.js";
import { TelegramError, type BotCommand, type EditParams, type SendParams, type Update } from "../../telegram/api.js";
import { Bot, BOT_COMMANDS, commandArgs, KEYBOARD, parseAction, type BotDeps, type BotProfile } from "../bot.js";
import { BotStateStore } from "../state.js";
import { SettingsStore } from "../../config/settings.js";
import { TrackedList } from "../../config/tracked.js";
import type { BotApi } from "../types.js";

const CHAT = "42";
const mine = parseSnapshot(readFixture("mine")) as MineSnapshot;
const todo = parseSnapshot(readFixture("todo")) as TodoSnapshot;
const track = parseSnapshot(readFixture("track")) as TrackSnapshot;
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

type HarnessDeps = Partial<BotDeps> & { commands?: Command[]; tracked?: TrackedList };

function harness(over: HarnessDeps = {}, options: { saved?: Partial<Record<Command, Snapshot>>; ageMs?: number } = {}) {
  const controller = new AbortController();
  const api = new FakeApi(controller.signal);
  const logs: string[] = [];
  const log: Logger = {
    info: (m) => logs.push(`info: ${m}`),
    warn: (m) => logs.push(`warn: ${m}`),
    error: (m) => logs.push(`error: ${m}`),
  };
  const stores = {
    mine: new StateStore(root, "work", "mine"),
    todo: new StateStore(root, "work", "todo"),
    track: new StateStore(root, "work", "track"),
  };
  const saved = options.saved ?? { mine, todo };
  for (const [kind, snapshot] of Object.entries(saved)) stores[kind as Command].save({ snapshot, missingTicks: {} });
  const fetched: Command[] = [];
  const failures: { source?: Error } = {};
  const fresh: Record<Command, Snapshot> = {
    mine: structuredClone(mine),
    todo: structuredClone(todo),
    track: structuredClone(track),
  };
  const source: SnapshotSource = async (kind) => {
    fetched.push(kind);
    if (failures.source) throw failures.source;
    return structuredClone(fresh[kind]);
  };
  let clock = GENERATED + (options.ageMs ?? 30_000);
  const state = new BotStateStore(root);
  const { commands = ["mine", "todo"], tracked, ...deps } = over;
  const bot = new Bot({
    api,
    chatId: CHAT,
    profiles: [{ profile: "work", commands, source, stores, ...(tracked ? { tracked } : {}) }],
    state,
    log,
    signal: controller.signal,
    settings: () => ({ intervalMs: 300_000 }),
    timeZone: "UTC",
    now: () => new Date(clock),
    pollSeconds: 1,
    ...deps,
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
    ["/settings", "settings"],
    ["⚙️ Settings", "settings"],
    ["/tracked", "tracked"],
    ["📌 Tracked", "tracked"],
    ["/track PRJ-1 2", "track"],
    ["/untrack", "untrack"],
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

  test("the menu outlives the answers, so the keyboard stays", async () => {
    const h = harness();
    await h.bot.handle(h.message("/help", 11));
    const menu = h.api.sent[0]!.id;
    await h.bot.handle(h.message("/mine", 12));
    await h.bot.handle(h.message("/todo", 13));
    await h.bot.handle(h.message("/status", 14));
    await h.bot.handle(h.tap("x", h.api.sent.at(-1)!.id));
    expect(h.api.deleted).not.toContain(menu);
    expect(h.state.load().menu).toBe(menu);
  });

  test("/help moves the menu down: the new one first, then the old one goes", async () => {
    const h = harness();
    await h.bot.handle(h.message("/help", 11));
    const first = h.api.sent[0]!.id;
    await h.bot.handle(h.message("/mine", 12));
    const list = h.api.sent[1]!.id;
    await h.bot.handle(h.message("/help", 13));
    const second = h.api.sent[2]!.id;
    expect(h.api.sent[2]!.params.keyboard).toEqual(KEYBOARD);
    expect(h.api.deleted).toEqual([11, 12, first, 13]);
    expect(h.api.deleted).not.toContain(list);
    expect(h.state.load()).toEqual({ menu: second, view: [list] });
  });

  test("an unknown message gets a short hint, not a second menu", async () => {
    const h = harness();
    await h.bot.handle(h.message("what", 11));
    expect(h.texts()[0]).toMatch(/^🤷 I did not get that\./);
    expect(h.api.sent[0]!.params.keyboard).toBeUndefined();
    expect(buttonData(h.api.sent[0]!.params)).toEqual(["x"]);
  });

  test("/status shows the profile, the last polls and the settings", async () => {
    const h = harness({ settings: () => ({ intervalMs: 300_000, mergeStatuses: ["Merge", "Ready"] }) });
    await h.bot.handle(h.message("/status", 11));
    const text = h.texts()[0]!;
    expect(text).toContain("profile <code>work</code>");
    expect(text).toContain("mine: 3 PRs, polled 0m ago");
    expect(text).toContain("todo: 2 PRs");
    expect(text).toContain("every 5m");
    expect(text).toContain("Jira: Merge, Ready");
    expect(buttonData(h.api.sent[0]!.params)).toEqual(["s", "x"]);
  });

  test("/status says when nothing was polled yet", async () => {
    const h = harness({}, { saved: {} });
    await h.bot.handle(h.message("/status", 11));
    expect(h.texts()[0]).toContain("mine: not polled yet");
  });
});

describe("run", () => {
  test("registers the commands, sends the menu with the keyboard once and stops on abort", async () => {
    const h = harness();
    const done = h.bot.run();
    await new Promise((r) => setTimeout(r, 20));
    h.controller.abort();
    await done;
    expect(h.api.commands).toEqual(BOT_COMMANDS);
    expect(h.texts()).toHaveLength(1);
    expect(h.api.sent[0]!.params.keyboard).toEqual(KEYBOARD);
    expect(h.state.load().menu).toBe(h.api.sent[0]!.id);
  });

  test("does not send the menu again, and takes down the answer a previous run left", async () => {
    const h = harness();
    h.state.save({ menu: 5, view: [77] });
    const done = h.bot.run();
    await new Promise((r) => setTimeout(r, 20));
    h.controller.abort();
    await done;
    expect(h.api.sent).toEqual([]);
    expect(h.api.deleted).toEqual([77]);
    expect(h.state.load()).toEqual({ menu: 5, view: [] });
  });

  test("handles updates in order, confirming each by moving the offset", async () => {
    const h = harness();
    h.state.save({ menu: 1, view: [] });
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
    h.state.save({ menu: 1, view: [] });
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
    h.state.save({ menu: 1, view: [] });
    h.api.polls.push(new TelegramError("getUpdates: 409 Conflict: terminated by other getUpdates request", 409));
    await h.bot.run();
    expect(h.logs.some((l) => l.startsWith("error: commands are off") && l.includes("another program reads"))).toBe(true);
  });

  test("keeps trying after a network failure", async () => {
    const h = harness();
    h.state.save({ menu: 1, view: [] });
    h.api.polls.push(new TelegramError("getUpdates: network error: offline", null));
    const done = h.bot.run();
    await new Promise((r) => setTimeout(r, 30));
    h.controller.abort();
    await done;
    expect(h.logs.filter((l) => l.startsWith("warn: listening for commands"))).toHaveLength(1);
  });
});

describe("settings", () => {
  function withSettings(over: Partial<BotDeps> = {}) {
    const store = new SettingsStore(root);
    const h = harness({ settings: () => store.load(), settingsStore: store, ...over });
    return { ...h, store };
  }
  const last = (h: ReturnType<typeof harness>) => h.api.edits.at(-1)!;

  test("/settings shows both settings with the defaults and the buttons to change them", async () => {
    const h = withSettings();
    await h.bot.handle(h.message("⚙️ Settings", 11));
    const sent = h.api.sent[0]!.params;
    expect(sent.text).toContain("Poll interval: <b>1m (default)</b>");
    expect(sent.text).toContain("Jira merge status: not set");
    expect(sent.text).toContain("apply within a minute");
    expect(buttonData(sent)).toEqual(["si", "sj", "x"]);
    expect(h.api.deleted).toEqual([11]);
  });

  test("without a settings store it only shows them", async () => {
    const h = harness();
    await h.bot.handle(h.message("/settings", 11));
    expect(buttonData(h.api.sent[0]!.params)).toEqual(["x"]);
    expect(h.api.sent[0]!.params.text).toContain("pr-tools-notifier config");
    await h.bot.handle(h.tap("si:5m", h.api.sent[0]!.id));
    expect(h.api.answers.at(-1)).toMatchObject({ text: "Settings cannot be changed from here" });
  });

  test("picks the poll interval with a button and saves it", async () => {
    const h = withSettings();
    await h.bot.handle(h.message("/settings", 11));
    const id = h.api.sent[0]!.id;
    await h.bot.handle(h.tap("si", id));
    expect(last(h).text).toContain("How often to ask GitHub");
    expect(buttonData(last(h))).toEqual(["si:1m", "si:5m", "si:15m", "si:30m", "si:1h", "si:4h", "si:12h", "si:-", "s"]);
    expect(
      last(h)
        .buttons!.flat()
        .find((b) => "data" in b && b.data === "si:-")!.text
    ).toBe("✓ Default");

    await h.bot.handle(h.tap("si:5m", id));
    expect(h.store.load()).toEqual({ intervalMs: 300_000 });
    expect(h.api.answers.at(-1)).toMatchObject({ text: "Saved" });
    expect(last(h).text).toContain("Poll interval: <b>5m</b>");
    expect(last(h).text).toContain("✅ Poll interval: 5m");

    await h.bot.handle(h.tap("si", id));
    expect(
      last(h)
        .buttons!.flat()
        .find((b) => "data" in b && b.data === "si:5m")!.text
    ).toBe("✓ 5m");
    await h.bot.handle(h.tap("si:-", id));
    expect(h.store.load()).toEqual({});
    expect(last(h).text).toContain("✅ Poll interval: 1m (default)");
  });

  test("ignores an interval that is not a valid one", async () => {
    const h = withSettings();
    await h.bot.handle(h.message("/settings", 11));
    await h.bot.handle(h.tap("si:30s", h.api.sent[0]!.id));
    expect(h.store.exists()).toBe(false);
  });

  test("asks for the Jira status and saves the next message, which it then takes down", async () => {
    const h = withSettings();
    await h.bot.handle(h.message("/settings", 11));
    const id = h.api.sent[0]!.id;
    await h.bot.handle(h.tap("sj", id));
    expect(last(h).text).toContain("Send its name as a message");
    expect(buttonData(last(h))).toEqual(["s"]);

    await h.bot.handle(h.message(" Merge , Ready to merge ", 12));
    expect(h.store.load()).toEqual({ mergeStatuses: ["Merge", "Ready to merge"] });
    expect(h.api.deleted).toContain(12);
    expect(last(h).text).toContain("Jira merge status: <b>Merge, Ready to merge</b>");
    expect(last(h).text).toContain("✅ Jira merge status: Merge, Ready to merge");

    await h.bot.handle(h.message("Merge", 13));
    expect(h.texts().at(-1)).toMatch(/^🤷 I did not get that/);
  });

  test("clears the Jira status with a button", async () => {
    const h = withSettings();
    h.store.set("MERGE_STATUS", "Merge");
    await h.bot.handle(h.message("/settings", 11));
    const id = h.api.sent[0]!.id;
    await h.bot.handle(h.tap("sj", id));
    expect(buttonData(last(h))).toEqual(["sj:-", "s"]);
    await h.bot.handle(h.tap("sj:-", id));
    expect(h.store.load()).toEqual({});
    expect(last(h).text).toContain("✅ Jira merge status cleared");
  });

  test("a command instead of the answer cancels the question", async () => {
    const h = withSettings();
    await h.bot.handle(h.message("/settings", 11));
    await h.bot.handle(h.tap("sj", h.api.sent[0]!.id));
    await h.bot.handle(h.message("/mine", 12));
    await h.bot.handle(h.message("Merge", 13));
    expect(h.store.exists()).toBe(false);
  });

  test("a late answer is not taken as the status", async () => {
    const h = withSettings();
    await h.bot.handle(h.message("/settings", 11));
    await h.bot.handle(h.tap("sj", h.api.sent[0]!.id));
    h.advance(11 * 60_000);
    await h.bot.handle(h.message("Merge", 12));
    expect(h.store.exists()).toBe(false);
  });

  test("going back from a question cancels it", async () => {
    const h = withSettings();
    await h.bot.handle(h.message("/settings", 11));
    const id = h.api.sent[0]!.id;
    await h.bot.handle(h.tap("sj", id));
    await h.bot.handle(h.tap("s", id));
    await h.bot.handle(h.message("Merge", 12));
    expect(h.store.exists()).toBe(false);
  });

  test("says why a value was not saved", async () => {
    writeFileSync(join(root, "blocker"), "");
    const store = new SettingsStore(join(root, "blocker")); // a file where the directory should be
    const h = harness({ settings: () => ({}), settingsStore: store });
    await h.bot.handle(h.message("/settings", 11));
    await h.bot.handle(h.tap("si:5m", h.api.sent[0]!.id));
    expect(h.api.edits.at(-1)!.text).toMatch(/⚠️ Not saved: \S+/);
    expect(h.logs.some((l) => l.startsWith("warn: settings: could not save POLL_INTERVAL"))).toBe(true);
  });

  test("shows that --interval wins for this run", async () => {
    const h = withSettings({ intervalFlagMs: 120_000 });
    h.store.set("POLL_INTERVAL", "1h");
    await h.bot.handle(h.message("/settings", 11));
    expect(h.api.sent[0]!.params.text).toContain("<b>2m</b> from <code>--interval</code> for this run (the setting is 1h)");
  });

  test("the Settings button on /status opens them in place", async () => {
    const h = withSettings();
    await h.bot.handle(h.message("/status", 11));
    await h.bot.handle(h.tap("s", h.api.sent[0]!.id));
    expect(h.api.sent).toHaveLength(1);
    expect(last(h).text).toContain("⚙️ <b>Settings</b>");
  });
});

describe("tracking", () => {
  function withTracked(over: HarnessDeps = {}, saved?: Partial<Record<Command, Snapshot>>) {
    const tracked = new TrackedList(root, "work");
    const h = harness({ commands: ["mine", "todo", "track"], tracked, ...over }, saved ? { saved } : {});
    return { ...h, tracked, file: () => tracked.read().entries.map((e) => e.text) };
  }
  const last = (h: ReturnType<typeof harness>) => h.api.edits.at(-1)!;

  test("splits what follows a command", () => {
    expect(commandArgs("/track PRJ-1824, 1281\n#12")).toEqual(["PRJ-1824", "1281", "#12"]);
    expect(commandArgs("/untrack@my_bot")).toEqual([]);
  });

  test("/tracked on an empty list says how to start, without asking GitHub", async () => {
    const h = withTracked();
    await h.bot.handle(h.message("📌 Tracked", 11));
    expect(h.api.sent[0]!.params.text).toContain("Nothing tracked yet");
    expect(buttonData(h.api.sent[0]!.params)).toEqual(["ta", "x"]);
    expect(h.fetched).toEqual([]);
  });

  test("/track with references adds them and shows the list as GitHub has it now", async () => {
    const h = withTracked();
    await h.bot.handle(h.message("/track PRJ-2001 203 foo", 11));
    expect(h.file()).toEqual(["PRJ-2001", "203"]);
    expect(h.fetched).toEqual(["track"]);
    const shown = last(h);
    expect(shown.text).toContain("📌 Tracked</b> · 2");
    expect(shown.text).toContain("✔️ Following PRJ-2001, #203");
    expect(shown.text).toContain("⚠️ Not a PR or a Jira ticket: foo");
    expect(buttonData(shown)).toEqual(["ta", "tr", "tc", "r:track", "x"]);
    expect(h.logs).toContain("info: tracking PRJ-2001, #203 from Telegram");
  });

  test("/track alone asks, and takes the next message as the references", async () => {
    const h = withTracked();
    await h.bot.handle(h.message("/track", 11));
    expect(h.api.sent[0]!.params.text).toContain("Send what to follow");
    expect(buttonData(h.api.sent[0]!.params)).toEqual(["tv", "x"]);
    await h.bot.handle(h.message("PRJ-2050, https://github.com/acme/web/pull/202", 12));
    expect(h.file()).toEqual(["PRJ-2050", "https://github.com/acme/web/pull/202"]);
    expect(h.api.deleted).toContain(12);
    expect(last(h).text).toContain("no PR yet");
  });

  test("➕ asks in place, and a command instead cancels the question", async () => {
    const h = withTracked();
    h.tracked.add(["203"]);
    await h.bot.handle(h.message("/tracked", 11));
    const id = h.api.sent[0]!.id;
    await h.bot.handle(h.tap("ta", id));
    expect(last(h).text).toContain("Send what to follow");
    await h.bot.handle(h.message("/mine", 12));
    await h.bot.handle(h.message("PRJ-2001", 13));
    expect(h.file()).toEqual(["203"]);
  });

  test("➖ lists the entries as buttons and removes the one tapped", async () => {
    const h = withTracked({}, { track });
    h.tracked.add(["PRJ-2001", "203"]);
    await h.bot.handle(h.message("/tracked", 11));
    const id = h.api.sent[0]!.id;
    expect(h.fetched).toEqual([]); // the saved poll is recent
    await h.bot.handle(h.tap("tr", id));
    expect(last(h).text).toBe("➖ Tap what to stop following:");
    expect(buttonData(last(h))).toEqual(["tr:PRJ-2001", "tr:#203", "tv", "x"]);
    await h.bot.handle(h.tap("tr:#203", id));
    expect(h.file()).toEqual(["PRJ-2001"]);
    expect(last(h).text).toContain("✔️ No longer following #203");
    expect(h.api.answers.at(-1)).toMatchObject({ text: "Removed" });
  });

  test("🧹 removes what is done and keeps the rest", async () => {
    const h = withTracked({}, { track });
    h.tracked.add(["PRJ-2001", "203", "PRJ-2050"]);
    await h.bot.handle(h.message("/tracked", 11));
    await h.bot.handle(h.tap("tc", h.api.sent[0]!.id));
    expect(h.file()).toEqual(["PRJ-2001", "PRJ-2050"]);
    expect(last(h).text).toContain("✔️ No longer following #203");
    expect(buttonData(last(h))).toEqual(["ta", "tr", "r:track", "x"]);
  });

  test("/untrack with references removes them", async () => {
    const h = withTracked({}, { track });
    h.tracked.add(["PRJ-2001", "203"]);
    await h.bot.handle(h.message("/untrack prj-2001 PRJ1", 11));
    expect(h.file()).toEqual(["203"]);
    expect(last(h).text).toContain("✔️ No longer following PRJ-2001\n⚠️ Not a PR or a Jira ticket: PRJ1");
  });

  test("a run that does not poll track says so", async () => {
    const h = harness();
    await h.bot.handle(h.message("/track PRJ-1", 11));
    expect(h.api.sent[0]!.params.text).toContain("does not follow other PRs");
  });

  test("/status counts the tracked entries", async () => {
    const h = withTracked({}, { track });
    h.tracked.add(["PRJ-2001", "203"]);
    await h.bot.handle(h.message("/status", 11));
    expect(h.api.sent[0]!.params.text).toContain("📌 tracked: 2 entries, polled 0m ago");
  });
});

describe("several profiles", () => {
  const last = (h: ReturnType<typeof harness>) => h.api.edits.at(-1)!;
  // What `track` answers about a list in this repo: the tickets it takes, each with the PRs it found.
  const answer =
    (repo: string, tickets: Record<string, number[]> = {}) =>
    async (): Promise<TrackSnapshot> => ({
      ...structuredClone(track),
      repo,
      prs: [],
      tickets: Object.entries(tickets).map(([key, prs]) => ({ key, url: null, status: null, prs })),
    });

  // "web" polls everything, "ops" only follows PRs; their saved polls are recent.
  function twoProfiles(probes: { web?: BotProfile["probe"]; ops?: BotProfile["probe"] } = {}) {
    const make = (name: "web" | "ops", commands: Command[]) => {
      const repo = `acme/${name}`;
      const stores = {
        mine: new StateStore(root, name, "mine"),
        todo: new StateStore(root, name, "todo"),
        track: new StateStore(root, name, "track"),
      };
      const fresh = { mine: { ...mine, repo }, todo: { ...todo, repo }, track: { ...track, repo } };
      for (const kind of commands) stores[kind].save({ snapshot: fresh[kind], missingTicks: {} });
      const fetched: Command[] = [];
      const profile: BotProfile = {
        profile: name,
        commands,
        stores,
        tracked: new TrackedList(root, name),
        source: async (kind) => {
          fetched.push(kind);
          return structuredClone(fresh[kind]);
        },
        probe: probes[name] ?? answer(repo),
      };
      return { profile, fetched, list: () => profile.tracked!.read().entries.map((e) => e.text) };
    };
    const web = make("web", ["mine", "todo", "track"]);
    const ops = make("ops", ["track"]);
    return { ...harness({ profiles: [web.profile, ops.profile] }), web, ops };
  }

  test("a list only one profile polls has no profile headings", async () => {
    const h = twoProfiles();
    await h.bot.handle(h.message("/mine", 11));
    expect(h.texts()[0]).toContain("📤 Mine");
    expect(h.texts()[0]).not.toContain("🗂");
  });

  test("/tracked shows a section for each profile that follows something", async () => {
    const h = twoProfiles();
    h.web.profile.tracked!.add(["PRJ-2001"]);
    h.ops.profile.tracked!.add(["203"]);
    await h.bot.handle(h.message("/tracked", 11));
    const text = h.texts()[0]!;
    expect(text).toContain("📌 Tracked</b> · 2");
    expect(text.indexOf("🗂 <b>web</b>")).toBeLessThan(text.indexOf("🗂 <b>ops</b>"));
    expect(h.web.fetched).toEqual([]);
  });

  test("/track puts a ticket where gh-pr-tools finds its PRs", async () => {
    const h = twoProfiles({ web: answer("acme/web"), ops: answer("acme/ops", { "OPS-1": [301] }) });
    await h.bot.handle(h.message("/track OPS-1", 11));
    expect(h.ops.list()).toEqual(["OPS-1"]);
    expect(h.web.list()).toEqual([]);
    expect(last(h).text).toContain("✔️ Following OPS-1 in ops");
    expect(h.ops.fetched).toEqual(["track"]);
    expect(h.logs).toContain("info: tracking OPS-1 in ops from Telegram");
  });

  test("a ticket with no PR yet goes to the one profile that takes it", async () => {
    const h = twoProfiles({ web: answer("acme/web", { "PRJ-9": [] }) });
    await h.bot.handle(h.message("/track PRJ-9", 11));
    expect(h.web.list()).toEqual(["PRJ-9"]);
  });

  test("a ticket no profile takes is reported, and nothing is added", async () => {
    const h = twoProfiles();
    await h.bot.handle(h.message("/track XYZ-1 nope", 11));
    expect(last(h).text).toContain("⚠️ <b>XYZ-1</b>: no profile takes this ticket (another Jira prefix?)");
    expect(last(h).text).toContain("⚠️ Not a PR or a Jira ticket: nope");
    expect(h.web.list()).toEqual([]);
    expect(h.ops.list()).toEqual([]);
  });

  test("a PR link goes to the profile of its repo", async () => {
    const h = twoProfiles();
    await h.bot.handle(h.message("/track https://github.com/ACME/ops/pull/5/files", 11));
    expect(h.ops.list()).toEqual(["https://github.com/ACME/ops/pull/5/files"]);
    expect(h.web.list()).toEqual([]);
  });

  test("a profile that cannot be asked is named, and the others still answer", async () => {
    const down = async (): Promise<TrackSnapshot> => {
      throw new Error("timed out after 120s");
    };
    const h = twoProfiles({ web: down, ops: answer("acme/ops", { "OPS-1": [301] }) });
    await h.bot.handle(h.message("/track OPS-1", 11));
    expect(h.ops.list()).toEqual(["OPS-1"]);
    expect(last(h).text).toContain("⚠️ Could not ask web: timed out after 120s");
  });

  test("a PR number is asked about, one at a time, and Skip leaves it out", async () => {
    const h = twoProfiles();
    await h.bot.handle(h.message("/track 1281 1282", 11));
    const id = h.api.sent[0]!.id;
    expect(last(h).text).toBe("➕ Which profile is <b>#1281</b> in?");
    expect(buttonData(last(h))).toEqual(["tq:0", "tq:1", "tq:-", "x"]);
    await h.bot.handle(h.tap("tq:-", id));
    expect(last(h).text).toBe("➕ Which profile is <b>#1282</b> in?");
    await h.bot.handle(h.tap("tq:1", id));
    expect(h.ops.list()).toEqual(["1282"]);
    expect(h.web.list()).toEqual([]);
    expect(last(h).text).toContain("✔️ Following #1282 in ops");
  });

  test("a ticket with PRs in two repos can be followed in both", async () => {
    const both = { "PRJ-7": [1] };
    const h = twoProfiles({ web: answer("acme/web", both), ops: answer("acme/ops", both) });
    await h.bot.handle(h.message("/track PRJ-7", 11));
    expect(last(h).text).toBe("➕ <b>PRJ-7</b> has PRs in several repos. Follow it in:");
    expect(buttonData(last(h))).toEqual(["tq:0", "tq:1", "tq:*", "tq:-", "x"]);
    await h.bot.handle(h.tap("tq:*", h.api.sent[0]!.id));
    expect(h.web.list()).toEqual(["PRJ-7"]);
    expect(h.ops.list()).toEqual(["PRJ-7"]);
  });

  test("another command drops the question", async () => {
    const h = twoProfiles();
    await h.bot.handle(h.message("/track 1281", 11));
    await h.bot.handle(h.message("/tracked", 12));
    await h.bot.handle(h.tap("tq:0", h.api.sent.at(-1)!.id));
    expect(h.web.list()).toEqual([]);
  });

  test("/untrack takes a ticket off every list and asks about a number two lists name", async () => {
    const h = twoProfiles();
    h.web.profile.tracked!.add(["PRJ-7", "12"]);
    h.ops.profile.tracked!.add(["PRJ-7", "12"]);
    await h.bot.handle(h.message("/untrack PRJ-7 12", 11));
    expect(h.web.list()).toEqual(["12"]);
    expect(h.ops.list()).toEqual(["12"]);
    expect(last(h).text).toContain("➖ <b>#12</b> is followed in several profiles. Stop following it in:");
    expect(last(h).text).toContain("✔️ No longer following PRJ-7 in web\n✔️ No longer following PRJ-7 in ops");
    await h.bot.handle(h.tap("tq:1", h.api.sent[0]!.id));
    expect(h.web.list()).toEqual(["12"]);
    expect(h.ops.list()).toEqual([]);
  });

  test("➖ names the profile of a label two lists share, and removes it from that one", async () => {
    const h = twoProfiles();
    h.web.profile.tracked!.add(["12", "PRJ-1"]);
    h.ops.profile.tracked!.add(["12"]);
    await h.bot.handle(h.message("/untrack", 11));
    const sent = h.api.sent[0]!;
    expect((sent.params.buttons ?? []).flat().map((b) => b.text)).toEqual([
      "✖ #12 · web",
      "✖ PRJ-1",
      "✖ #12 · ops",
      "‹ Back",
      "✖ Close",
    ]);
    expect(buttonData(sent.params)).toEqual(["tr:0:#12", "tr:0:PRJ-1", "tr:1:#12", "tv", "x"]);
    await h.bot.handle(h.tap("tr:1:#12", sent.id));
    expect(h.web.list()).toEqual(["12", "PRJ-1"]);
    expect(h.ops.list()).toEqual([]);
  });

  test("/status lists each profile with what it polls", async () => {
    const h = twoProfiles();
    await h.bot.handle(h.message("/status", 11));
    const text = h.texts()[0]!;
    expect(text).toMatch(/^ℹ️ <b>Status<\/b>\n🗂 <b>web<\/b>\n📤 mine: 3 PRs/);
    expect(text).toContain("🗂 <b>ops</b>\n📌 tracked: nothing yet\n⏱ every 5m");
  });
});
