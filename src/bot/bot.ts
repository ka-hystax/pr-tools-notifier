import { DEFAULT_INTERVAL_MS, formatInterval, readInterval } from "../config/interval.js";
import type { Settings, SettingsStore } from "../config/settings.js";
import type { Snapshot, TrackSnapshot } from "../contract/snapshot.js";
import { entryLabel, parseRef, type TrackedEntry, type TrackedList } from "../config/tracked.js";
import { computeEvents, type MergeGate } from "../diff/diff.js";
import { bold, clip, escapeHtml } from "../format/format.js";
import { sleep } from "../runner/loop.js";
import { errorMessage, type Command, type Logger, type SnapshotSource } from "../runner/types.js";
import type { StateStore } from "../state/store.js";
import { TelegramError, type ApiButton, type BotCommand, type Update } from "../telegram/api.js";
import { LiveView } from "./live.js";
import type { BotStateStore } from "./state.js";
import type { BotApi } from "./types.js";
import { isDone, renderTracked } from "./tracked.js";
import { ago, plural, renderList } from "./views.js";
import { CLOSE, intervalScreen, savedNote, settingsScreen, statusPrompt, type SettingsView } from "./settings.js";

import { KEYBOARD } from "./keyboard.js";

export { KEYBOARD };

export const BOT_COMMANDS: BotCommand[] = [
  { command: "todo", description: "PRs waiting for your review" },
  { command: "mine", description: "your open PRs" },
  { command: "tracked", description: "PRs and Jira tickets you follow" },
  { command: "track", description: "follow PRs or Jira tickets: /track PRJ-1824 1281" },
  { command: "untrack", description: "stop following some" },
  { command: "status", description: "what is being watched" },
  { command: "settings", description: "poll interval and Jira merge status" },
  { command: "help", description: "what the bot can do" },
];

const LABELS: Record<string, Action> = {
  "📥 Todo": "todo",
  "📤 Mine": "mine",
  "📌 Tracked": "tracked",
  "ℹ️ Status": "status",
  "⚙️ Settings": "settings",
};

export type Action = "todo" | "mine" | "tracked" | "track" | "untrack" | "status" | "settings" | "help" | "unknown";

// References in a message, separated by spaces, commas or lines: "PRJ-1824, 1281" names PRJ-1824 and 1281.
export function splitRefs(text: string): string[] {
  return text.split(/[\s,]+/).filter((part) => part !== "");
}

// What follows a command: "/track PRJ-1824 1281" names PRJ-1824 and 1281.
export function commandArgs(text: string): string[] {
  return splitRefs(text.trim().replace(/^\/\S+/, ""));
}

// A slash command (with or without @botname) or the text of a keyboard button.
export function parseAction(text: string): Action {
  const trimmed = text.trim();
  const label = LABELS[trimmed];
  if (label) return label;
  const match = /^\/([a-z_]+)(?:@\w+)?(?:\s|$)/i.exec(trimmed);
  switch (match?.[1]?.toLowerCase()) {
    case "todo":
    case "mine":
    case "tracked":
    case "track":
    case "untrack":
    case "status":
    case "settings":
      return match[1]!.toLowerCase() as Action;
    case "start":
    case "help":
      return "help";
    default:
      return "unknown";
  }
}

const HELP = `👋 ${bold("PR notifier")}
I message you when something changes in your PRs. You can also ask me:

📥 /todo — PRs waiting for your review
📤 /mine — your open PRs
📌 /tracked — PRs and Jira tickets you follow; /track PRJ-1824 adds, /untrack removes
ℹ️ /status — what I am watching
⚙️ /settings — poll interval and Jira merge status

An answer stays on screen until you ask for something else.
<i>This message holds the buttons below; /help brings them back if they go.</i>`;

const ERROR_MAX = 300;
const MAX_REMOVE_BUTTONS = 60;
const BACK_TO_TRACKED: ApiButton = { text: "‹ Back", data: "tv" };
const ADD_TRACKED: ApiButton = { text: "➕ Add", data: "ta" };
const EMPTY_TRACKED = (now: Date, note?: string): string => renderTracked([], null, { now, ...(note ? { note } : {}) })[0]!;
const TRACK_PROMPT = `➕ Send what to follow, several at once if you like: a PR number (<code>1281</code>), a PR link, a Jira ticket (<code>PRJ-1824</code>) or a Jira link.

A ticket stands for every PR whose title names it, including PRs opened later.`;
// A question the bot asked ("send the Jira status") is forgotten after this long.
const ANSWER_WITHIN_MS = 10 * 60_000;

export interface BotDeps {
  api: BotApi;
  chatId: string;
  profile: string;
  // The commands this run polls: a list can only be shown for these.
  commands: Command[];
  source: SnapshotSource;
  stores: Record<Command, StateStore>;
  state: BotStateStore;
  log: Logger;
  signal: AbortSignal;
  // The current settings, re-read on every call.
  settings: () => Settings;
  // The PRs and tickets /tracked shows and /track and /untrack edit; without it there is no tracking.
  tracked?: TrackedList;
  // Where /settings writes; without it the settings can only be looked at.
  settingsStore?: SettingsStore;
  // `run --interval`, which wins over POLL_INTERVAL for this run.
  intervalFlagMs?: number;
  timeZone?: string;
  now?: () => Date;
  // Commands older than this are dropped: Telegram keeps unread ones for a day, long after they were meant.
  maxAgeMs?: number;
  // A saved snapshot younger than this answers a list without asking GitHub again.
  freshMs?: number;
  pollSeconds?: number;
}

interface Shown {
  messageId: number;
  kind: Command;
  snapshot: Snapshot;
  note?: string;
  page: number;
}

type Loaded = { snapshot: Snapshot; note?: string };

// Answers to the owner's commands and button taps. Only the saved chat is heard; everyone else is ignored.
export class Bot {
  private readonly live: LiveView;
  private readonly now: () => Date;
  private readonly maxAgeMs: number;
  private readonly freshMs: number;
  private readonly strangers = new Set<number>();
  private shown: Shown | null = null;
  // Set while the bot waits for a plain message, on the message it asked in: a Jira status, or what to track.
  private asked: { messageId: number; at: number; for: "merge_status" | "track" } | null = null;

  constructor(private readonly deps: BotDeps) {
    this.live = new LiveView(deps.api, deps.chatId, deps.state, deps.log);
    this.now = deps.now ?? (() => new Date());
    this.maxAgeMs = deps.maxAgeMs ?? 120_000;
    this.freshMs = deps.freshMs ?? 120_000;
  }

  // Resolves when the abort signal fires, or when Telegram says this bot cannot be read (another reader, a bad token).
  async run(): Promise<void> {
    const { api, log, signal } = this.deps;
    try {
      await api.setMyCommands(BOT_COMMANDS);
      await this.live.clearLeftovers();
      if (this.deps.state.load().menu === null) await this.showMenu();
    } catch (err) {
      if (signal.aborted) return;
      log.warn(`bot setup: ${errorMessage(err)}`);
    }
    log.info("listening for commands: /todo, /mine, /tracked, /status, /settings");

    let offset: number | undefined;
    let failures = 0;
    while (!signal.aborted) {
      let updates: Update[];
      try {
        updates = await api.getUpdates(offset, this.deps.pollSeconds ?? 25);
        failures = 0;
      } catch (err) {
        if (signal.aborted) return;
        if (err instanceof TelegramError && (err.status === 409 || err.status === 401 || err.status === 404)) {
          log.error(
            `commands are off: ${errorMessage(err)}${err.status === 409 ? " (another program reads this bot's messages)" : ""}`
          );
          return;
        }
        failures += 1;
        if (failures === 1 || failures % 10 === 0) log.warn(`listening for commands: ${errorMessage(err)}`);
        await sleep(Math.min(5_000 * failures, 60_000), signal);
        continue;
      }
      for (const update of updates) {
        offset = update.update_id + 1;
        try {
          await this.handle(update);
        } catch (err) {
          if (signal.aborted) return;
          log.error(`command failed: ${errorMessage(err)}`);
        }
      }
    }
  }

  async handle(update: Update): Promise<void> {
    if (update.message) await this.onMessage(update.message);
    else if (update.callback_query) await this.onCallback(update.callback_query);
  }

  private async onMessage(message: NonNullable<Update["message"]>): Promise<void> {
    if (String(message.chat.id) !== this.deps.chatId) {
      if (!this.strangers.has(message.chat.id)) {
        this.strangers.add(message.chat.id);
        this.deps.log.warn(`ignored a message from an unknown chat (${message.chat.id})`);
      }
      return;
    }
    if (message.text === undefined) return;
    if (this.now().getTime() - message.date * 1000 > this.maxAgeMs) {
      this.deps.log.info("ignored a command that is too old");
      return;
    }

    const action = parseAction(message.text);
    const replaces = message.message_id;
    const asked = this.asked;
    this.asked = null;
    if (action === "unknown" && asked && !message.text.trim().startsWith("/")) {
      if (asked.messageId === this.live.current && this.now().getTime() - asked.at < ANSWER_WITHIN_MS) {
        await this.live.remove(replaces);
        if (asked.for === "track") await this.addTracked(asked.messageId, splitRefs(message.text));
        else await this.saveSetting(asked.messageId, "MERGE_STATUS", message.text);
        return;
      }
    }
    if (action === "todo" || action === "mine") return this.openList(action, replaces);
    if (action === "tracked" || action === "track" || action === "untrack") {
      return this.onTrackCommand(action, commandArgs(message.text), replaces);
    }
    this.shown = null;
    if (action === "status") {
      await this.live.show(this.statusText(), [[{ text: "⚙️ Settings", data: "s" }, CLOSE]], { replaces });
    } else if (action === "settings") {
      const { text, buttons } = settingsScreen(this.settingsView());
      await this.live.show(text, buttons, { replaces });
    } else if (action === "help") {
      await this.showMenu(replaces);
    } else {
      await this.live.show("🤷 I did not get that. The buttons below and /help show what I can do.", [[CLOSE]], {
        replaces,
      });
    }
  }

  // The help message carries the keyboard and is not an answer: answers replace each other, this one stays,
  // because Telegram takes a keyboard away together with the message that brought it. A new one moves it down.
  private async showMenu(replaces?: number): Promise<void> {
    const previous = this.deps.state.load().menu;
    const { messageId } = await this.deps.api.sendMessage({ chatId: this.deps.chatId, text: HELP, keyboard: KEYBOARD });
    try {
      this.deps.state.save({ ...this.deps.state.load(), menu: messageId });
    } catch (err) {
      this.deps.log.warn(`could not save the bot state: ${errorMessage(err)}`);
    }
    if (previous !== null) await this.live.remove(previous);
    if (replaces !== undefined) await this.live.remove(replaces);
  }

  private settingsView(note?: string): SettingsView {
    return {
      settings: this.deps.settings(),
      editable: this.deps.settingsStore !== undefined,
      ...(this.deps.intervalFlagMs !== undefined ? { intervalFlagMs: this.deps.intervalFlagMs } : {}),
      ...(note ? { note } : {}),
    };
  }

  // Writes one setting and shows the settings with what changed, or why it did not.
  private async saveSetting(messageId: number, key: "MERGE_STATUS" | "POLL_INTERVAL", value: string): Promise<void> {
    let note: string;
    const store = this.deps.settingsStore;
    if (!store) {
      note = "⚠️ Settings cannot be changed from here.";
    } else {
      try {
        const stored = store.set(key, value);
        note =
          key === "MERGE_STATUS"
            ? savedNote(stored ? `Jira merge status: ${stored.split(",").join(", ")}` : "Jira merge status cleared")
            : savedNote(`Poll interval: ${stored || `${formatInterval(DEFAULT_INTERVAL_MS)} (default)`}`);
        this.deps.log.info(`settings: ${key} ${stored ? `set to ${stored}` : "cleared"} from Telegram`);
      } catch (err) {
        note = `⚠️ Not saved: ${this.reason(err)}`;
        this.deps.log.warn(`settings: could not save ${key}: ${errorMessage(err)}`);
      }
    }
    const { text, buttons } = settingsScreen(this.settingsView(note));
    await this.live.update(messageId, text, buttons);
  }

  // Button taps on the settings screens: s (settings), si / si:<value> (interval), sj / sj:- (Jira status).
  private async onSettingsTap(data: string, messageId: number, answer: (text?: string) => Promise<void>): Promise<void> {
    const editable = this.deps.settingsStore !== undefined;
    if (data === "s") {
      await answer();
      const { text, buttons } = settingsScreen(this.settingsView());
      await this.live.update(messageId, text, buttons);
      return;
    }
    if (!editable) {
      await answer("Settings cannot be changed from here");
      return;
    }
    if (data === "si") {
      await answer();
      const { text, buttons } = intervalScreen(this.settingsView());
      await this.live.update(messageId, text, buttons);
      return;
    }
    if (data.startsWith("si:")) {
      const value = data.slice(3);
      if (value !== "-" && !("ms" in readInterval(value))) {
        await answer();
        return;
      }
      await answer("Saved");
      await this.saveSetting(messageId, "POLL_INTERVAL", value === "-" ? "" : value);
      return;
    }
    if (data === "sj") {
      await answer();
      const { text, buttons } = statusPrompt(this.settingsView());
      await this.live.update(messageId, text, buttons);
      this.asked = { messageId, at: this.now().getTime(), for: "merge_status" };
      return;
    }
    if (data === "sj:-") {
      await answer("Cleared");
      await this.saveSetting(messageId, "MERGE_STATUS", "");
      return;
    }
    await answer();
  }

  private async onCallback(query: NonNullable<Update["callback_query"]>): Promise<void> {
    const { api, chatId } = { api: this.deps.api, chatId: this.deps.chatId };
    if (!query.message || String(query.message.chat.id) !== chatId) return;
    const answer = async (text?: string) => {
      try {
        await api.answerCallbackQuery(query.id, text);
      } catch {
        // a tap that is too old to answer still gets handled
      }
    };

    if (query.message.message_id !== this.live.current) {
      await answer("That message is out of date");
      await this.live.remove(query.message.message_id);
      return;
    }
    const data = query.data ?? "";
    this.asked = null;
    if (data === "x") {
      await answer();
      this.shown = null;
      await this.live.close();
      return;
    }
    if (data === "s" || data.startsWith("si") || data.startsWith("sj")) {
      this.shown = null;
      await this.onSettingsTap(data, query.message.message_id, answer);
      return;
    }
    if (data === "tv" || data === "ta" || data.startsWith("tr") || data === "tc") {
      await this.onTrackTap(data, query.message.message_id, answer);
      return;
    }
    const match = /^([pr]):(mine|todo|track)(?::(\d+))?$/.exec(data);
    if (!match || !this.deps.commands.includes(match[2] as Command)) {
      await answer();
      return;
    }
    const kind = match[2] as Command;
    const messageId = query.message.message_id;

    if (match[1] === "p") {
      await answer();
      if (this.shown?.kind !== kind) return;
      this.shown.page = Number(match[3] ?? 0);
      await this.draw(this.shown);
      return;
    }
    await answer("Refreshing…");
    const previous = this.shown?.kind === kind ? this.shown : null;
    let loaded: Loaded;
    try {
      loaded = { snapshot: await this.fetchFresh(kind) };
    } catch (err) {
      const fallback = previous?.snapshot ?? this.deps.stores[kind].peek()?.snapshot;
      if (!fallback) {
        await this.live.update(messageId, `⚠️ Could not load ${kind}: ${this.reason(err)}`, [[CLOSE]]);
        return;
      }
      loaded = { snapshot: fallback, note: `⚠️ Could not refresh: ${this.reason(err)}` };
    }
    this.shown = { messageId, kind, ...loaded, page: previous?.page ?? 0 };
    await this.draw(this.shown);
  }

  private reason(err: unknown): string {
    return escapeHtml(clip(errorMessage(err), ERROR_MAX));
  }

  private gate(kind: Command): MergeGate | undefined {
    const statuses = this.deps.settings().mergeStatuses;
    return kind === "mine" && statuses ? { statuses } : undefined;
  }

  // The saved snapshot, when it is recent enough to answer with.
  private stored(kind: Command): Snapshot | null {
    const baseline = this.deps.stores[kind].peek();
    if (!baseline) return null;
    return this.now().getTime() - Date.parse(baseline.snapshot.generatedAt) < this.freshMs ? baseline.snapshot : null;
  }

  // Asks GitHub now. Run through the diff so a status GitHub is still computing keeps its last known value, as in notifications.
  private async fetchFresh(kind: Command): Promise<Snapshot> {
    const current = await this.deps.source(kind);
    const baseline = this.deps.stores[kind].peek();
    return baseline ? computeEvents(baseline, current, this.gate(kind)).next.snapshot : current;
  }

  // Fresh data; when that fails, the last saved poll with a note saying so.
  private async loadFresh(kind: Command): Promise<Loaded> {
    try {
      return { snapshot: await this.fetchFresh(kind) };
    } catch (err) {
      const saved = this.deps.stores[kind].peek();
      if (!saved) throw err;
      return { snapshot: saved.snapshot, note: `⚠️ Could not refresh: ${this.reason(err)}` };
    }
  }

  private async openList(kind: Command, replaces: number): Promise<void> {
    if (!this.deps.commands.includes(kind)) {
      await this.live.show(`ℹ️ This run does not poll ${kind} (see --commands).`, [[CLOSE]], { replaces });
      this.shown = null;
      return;
    }
    const saved = this.stored(kind);
    if (saved) {
      const { text, buttons } = this.page({ messageId: 0, kind, snapshot: saved, page: 0 });
      const messageId = await this.live.show(text, buttons, { replaces });
      this.shown = { messageId, kind, snapshot: saved, page: 0 };
      return;
    }

    const messageId = await this.live.show("⏳ Loading…", [], { replaces });
    this.shown = null;
    try {
      const loaded = await this.loadFresh(kind);
      this.shown = { messageId, kind, ...loaded, page: 0 };
      await this.draw(this.shown);
    } catch (err) {
      await this.live.update(messageId, `⚠️ Could not load ${kind}: ${this.reason(err)}`, [[CLOSE]]);
    }
  }

  private page(shown: Shown): { text: string; buttons: ApiButton[][] } {
    const { kind, snapshot } = shown;
    const gate = this.gate(kind);
    const options = {
      now: this.now(),
      ...(this.deps.timeZone ? { timeZone: this.deps.timeZone } : {}),
      ...(shown.note ? { note: shown.note } : {}),
    };
    const pages =
      kind === "track"
        ? renderTracked(this.trackedEntries(), snapshot as TrackSnapshot, options)
        : renderList(snapshot as Parameters<typeof renderList>[0], { ...options, ...(gate ? { gate } : {}) });
    const page = Math.min(Math.max(shown.page, 0), pages.length - 1);
    shown.page = page;
    const nav: ApiButton[] = [];
    if (page > 0) nav.push({ text: "◀ Prev", data: `p:${kind}:${page - 1}` });
    if (page < pages.length - 1) nav.push({ text: "Next ▶", data: `p:${kind}:${page + 1}` });
    const actions: ApiButton[] = [{ text: "🔄 Refresh", data: `r:${kind}` }, CLOSE];
    const edit = kind === "track" ? [this.trackButtons(snapshot as TrackSnapshot)] : [];
    return { text: pages[page]!, buttons: [...(nav.length > 0 ? [nav] : []), ...edit, actions] };
  }

  private trackedEntries(): TrackedEntry[] {
    return this.deps.tracked?.read().entries ?? [];
  }

  private trackButtons(snapshot: TrackSnapshot | null): ApiButton[] {
    const entries = this.trackedEntries();
    const buttons: ApiButton[] = [ADD_TRACKED];
    if (entries.length > 0) buttons.push({ text: "➖ Remove", data: "tr" });
    if (snapshot && entries.some((e) => isDone(e, snapshot))) buttons.push({ text: "🧹 Clear done", data: "tc" });
    return buttons;
  }

  // /tracked shows the list; /track and /untrack change it first (with nothing after them, they ask).
  private async onTrackCommand(action: "tracked" | "track" | "untrack", refs: string[], replaces: number): Promise<void> {
    this.shown = null;
    if (!this.deps.tracked || !this.deps.commands.includes("track")) {
      await this.live.show("ℹ️ This run does not follow other PRs (see --commands).", [[CLOSE]], { replaces });
      return;
    }
    if (action === "track" && refs.length === 0) {
      const messageId = await this.live.show(TRACK_PROMPT, [[BACK_TO_TRACKED, CLOSE]], { replaces });
      this.asked = { messageId, at: this.now().getTime(), for: "track" };
      return;
    }
    if (action === "untrack" && refs.length === 0) {
      const { text, buttons } = this.removeScreen();
      await this.live.show(text, buttons, { replaces });
      return;
    }
    // Without anything to fetch the list is shown at once, not after a placeholder.
    const saved = this.stored("track");
    if (action === "tracked" && (saved || this.trackedEntries().length === 0)) {
      if (!saved) {
        await this.live.show(EMPTY_TRACKED(this.now()), [[ADD_TRACKED, CLOSE]], { replaces });
        return;
      }
      const shown: Shown = { messageId: 0, kind: "track", snapshot: saved, page: 0 };
      const { text, buttons } = this.page(shown);
      shown.messageId = await this.live.show(text, buttons, { replaces });
      this.shown = shown;
      return;
    }
    const messageId = await this.live.show("⏳ Loading…", [], { replaces });
    if (action === "track") return this.addTracked(messageId, refs);
    if (action === "untrack") {
      const invalid = refs.filter((r) => parseRef(r) === null);
      return this.removeTracked(
        messageId,
        refs.flatMap((r) => parseRef(r) ?? []),
        invalid
      );
    }
    await this.showTracked(messageId, { fresh: true });
  }

  // Button taps on the tracked list: tv (back to it), ta (asks what to add), tr / tr:<entry> (remove), tc (clear done).
  private async onTrackTap(data: string, messageId: number, answer: (text?: string) => Promise<void>): Promise<void> {
    if (!this.deps.tracked) {
      await answer();
      return;
    }
    if (data === "ta") {
      await answer();
      this.shown = null;
      await this.live.update(messageId, TRACK_PROMPT, [[BACK_TO_TRACKED, CLOSE]]);
      this.asked = { messageId, at: this.now().getTime(), for: "track" };
      return;
    }
    if (data === "tr") {
      await answer();
      this.shown = null;
      const { text, buttons } = this.removeScreen();
      await this.live.update(messageId, text, buttons);
      return;
    }
    if (data.startsWith("tr:")) {
      await answer("Removed");
      const entry = parseRef(data.slice(3));
      await this.removeTracked(messageId, entry ? [entry] : []);
      return;
    }
    if (data === "tc") {
      const snapshot = (this.shown?.kind === "track" ? this.shown.snapshot : this.deps.stores.track.peek()?.snapshot) as
        | TrackSnapshot
        | undefined;
      const done = snapshot ? this.trackedEntries().filter((e) => isDone(e, snapshot)) : [];
      await answer(done.length > 0 ? "Cleared" : "Nothing is done yet");
      await this.removeTracked(messageId, done);
      return;
    }
    await answer();
    await this.showTracked(messageId, {});
  }

  private removeScreen(note?: string): { text: string; buttons: ApiButton[][] } {
    const entries = this.trackedEntries().slice(0, MAX_REMOVE_BUTTONS);
    const rows: ApiButton[][] = [];
    for (let i = 0; i < entries.length; i += 3) {
      rows.push(entries.slice(i, i + 3).map((e) => ({ text: `✖ ${entryLabel(e)}`, data: `tr:${entryLabel(e)}` })));
    }
    const text = entries.length > 0 ? "➖ Tap what to stop following:" : "📭 Nothing tracked yet.";
    return { text: `${text}${note ? `\n\n${note}` : ""}`, buttons: [...rows, [BACK_TO_TRACKED, CLOSE]] };
  }

  private async addTracked(messageId: number, refs: string[]): Promise<void> {
    let note: string;
    try {
      const { added, already, invalid } = this.deps.tracked!.add(refs);
      const parts: string[] = [];
      if (added.length > 0) parts.push(`✔️ Following ${escapeHtml(added.map(entryLabel).join(", "))}`);
      if (already.length > 0) parts.push(`Already followed: ${escapeHtml(already.map(entryLabel).join(", "))}`);
      if (invalid.length > 0) parts.push(`⚠️ Not a PR or a Jira ticket: ${escapeHtml(clip(invalid.join(", "), ERROR_MAX))}`);
      note = parts.join("\n") || "Nothing to add.";
      if (added.length > 0) this.deps.log.info(`tracking ${added.map(entryLabel).join(", ")} from Telegram`);
      await this.showTracked(messageId, { note, fresh: added.length > 0 });
    } catch (err) {
      this.deps.log.warn(`could not change the tracked list: ${errorMessage(err)}`);
      await this.showTracked(messageId, { note: `⚠️ Not saved: ${this.reason(err)}` });
    }
  }

  private async removeTracked(messageId: number, entries: TrackedEntry[], invalid: string[] = []): Promise<void> {
    let note: string;
    try {
      const removed = this.deps.tracked!.remove(entries);
      note =
        removed.length > 0 ? `✔️ No longer following ${escapeHtml(removed.map(entryLabel).join(", "))}` : "Nothing to remove.";
      if (invalid.length > 0) note += `\n⚠️ Not a PR or a Jira ticket: ${escapeHtml(clip(invalid.join(", "), ERROR_MAX))}`;
      if (removed.length > 0) this.deps.log.info(`stopped tracking ${removed.map(entryLabel).join(", ")} from Telegram`);
    } catch (err) {
      this.deps.log.warn(`could not change the tracked list: ${errorMessage(err)}`);
      note = `⚠️ Not saved: ${this.reason(err)}`;
    }
    await this.showTracked(messageId, { note });
  }

  // The tracked list on this message: from what is on screen or the last poll, or asked for now (after an addition).
  private async showTracked(messageId: number, { note, fresh = false }: { note?: string; fresh?: boolean }): Promise<void> {
    if (this.trackedEntries().length === 0) {
      this.shown = null;
      await this.live.update(messageId, EMPTY_TRACKED(this.now(), note), [[ADD_TRACKED, CLOSE]]);
      return;
    }
    let loaded: Loaded | null = null;
    const current = this.shown?.kind === "track" ? this.shown.snapshot : (this.deps.stores.track.peek()?.snapshot ?? null);
    if (fresh || !current) {
      if (fresh) await this.live.update(messageId, "⏳ Loading…", []);
      try {
        loaded = await this.loadFresh("track");
      } catch (err) {
        await this.live.update(messageId, `⚠️ Could not load the tracked PRs: ${this.reason(err)}`, [[BACK_TO_TRACKED, CLOSE]]);
        return;
      }
    }
    const snapshot = loaded?.snapshot ?? current!;
    const notes = [note, loaded?.note].filter((n): n is string => n !== undefined);
    this.shown = { messageId, kind: "track", snapshot, page: 0, ...(notes.length > 0 ? { note: notes.join("\n") } : {}) };
    await this.draw(this.shown);
  }

  private async draw(shown: Shown): Promise<void> {
    const { text, buttons } = this.page(shown);
    await this.live.update(shown.messageId, text, buttons);
  }

  private statusText(): string {
    const { profile, commands, stores } = this.deps;
    const settings = this.deps.settings();
    const intervalMs = this.deps.intervalFlagMs ?? settings.intervalMs ?? DEFAULT_INTERVAL_MS;
    const { mergeStatuses } = settings;
    const lines = [`ℹ️ ${bold("Status")} · profile <code>${escapeHtml(profile)}</code>`];
    for (const kind of commands) {
      const saved = stores[kind].peek();
      const icon = { mine: "📤", todo: "📥", track: "📌" }[kind];
      if (kind === "track") {
        const count = this.trackedEntries().length;
        lines.push(
          count === 0
            ? `${icon} tracked: nothing yet`
            : `${icon} tracked: ${plural(count, "entry", "entries")}${saved ? `, polled ${ago(saved.snapshot.generatedAt, this.now())} ago` : ", not polled yet"}`
        );
        continue;
      }
      lines.push(
        saved
          ? `${icon} ${kind}: ${saved.snapshot.prs.length} PRs, polled ${ago(saved.snapshot.generatedAt, this.now())} ago`
          : `${icon} ${kind}: not polled yet`
      );
    }
    lines.push(`⏱ every ${formatInterval(intervalMs)}`);
    if (mergeStatuses) lines.push(`🎫 "Time to merge" waits for Jira: ${escapeHtml(mergeStatuses.join(", "))}`);
    return lines.join("\n");
  }
}
