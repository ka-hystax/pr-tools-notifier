import { DEFAULT_INTERVAL_MS, formatInterval, readInterval } from "../config/interval.js";
import type { Settings, SettingsStore } from "../config/settings.js";
import type { Snapshot } from "../contract/snapshot.js";
import { computeEvents, type MergeGate } from "../diff/diff.js";
import { bold, clip, escapeHtml } from "../format/format.js";
import { sleep } from "../runner/loop.js";
import { errorMessage, type Command, type Logger, type SnapshotSource } from "../runner/types.js";
import type { StateStore } from "../state/store.js";
import { TelegramError, type ApiButton, type BotCommand, type Update } from "../telegram/api.js";
import { LiveView } from "./live.js";
import type { BotStateStore } from "./state.js";
import type { BotApi } from "./types.js";
import { ago, renderList } from "./views.js";
import { CLOSE, intervalScreen, savedNote, settingsScreen, statusPrompt, type SettingsView } from "./settings.js";

import { KEYBOARD } from "./keyboard.js";

export { KEYBOARD };

export const BOT_COMMANDS: BotCommand[] = [
  { command: "todo", description: "PRs waiting for your review" },
  { command: "mine", description: "your open PRs" },
  { command: "status", description: "what is being watched" },
  { command: "settings", description: "poll interval and Jira merge status" },
  { command: "help", description: "what the bot can do" },
];

const LABELS: Record<string, Action> = {
  "📥 Todo": "todo",
  "📤 Mine": "mine",
  "ℹ️ Status": "status",
  "⚙️ Settings": "settings",
};

export type Action = "todo" | "mine" | "status" | "settings" | "help" | "unknown";

// A slash command (with or without @botname) or the text of a keyboard button.
export function parseAction(text: string): Action {
  const trimmed = text.trim();
  const label = LABELS[trimmed];
  if (label) return label;
  const match = /^\/([a-z_]+)(?:@\w+)?(?:\s|$)/i.exec(trimmed);
  switch (match?.[1]?.toLowerCase()) {
    case "todo":
    case "mine":
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
ℹ️ /status — what I am watching
⚙️ /settings — poll interval and Jira merge status

An answer stays on screen until you ask for something else.`;

const ERROR_MAX = 300;
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
  // Set while the bot waits for the Jira status as a plain message, on the settings message it asked in.
  private asked: { messageId: number; at: number } | null = null;

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
      if (!this.deps.state.load().intro) {
        await this.live.show(HELP, [], { keyboard: KEYBOARD });
        this.deps.state.save({ ...this.deps.state.load(), intro: true });
      }
    } catch (err) {
      if (signal.aborted) return;
      log.warn(`bot setup: ${errorMessage(err)}`);
    }
    log.info("listening for commands: /todo, /mine, /status, /settings");

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
        await this.saveSetting(asked.messageId, "MERGE_STATUS", message.text);
        return;
      }
    }
    if (action === "todo" || action === "mine") return this.openList(action, replaces);
    this.shown = null;
    if (action === "status") {
      await this.live.show(this.statusText(), [[{ text: "⚙️ Settings", data: "s" }, CLOSE]], { replaces });
    } else if (action === "settings") {
      const { text, buttons } = settingsScreen(this.settingsView());
      await this.live.show(text, buttons, { replaces });
    } else {
      const text = action === "unknown" ? `🤷 I did not get that.\n\n${HELP}` : HELP;
      await this.live.show(text, [], { replaces, keyboard: KEYBOARD });
    }
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
      this.asked = { messageId, at: this.now().getTime() };
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
    const match = /^([pr]):(mine|todo)(?::(\d+))?$/.exec(data);
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
    const pages = renderList(snapshot as Parameters<typeof renderList>[0], {
      now: this.now(),
      ...(gate ? { gate } : {}),
      ...(this.deps.timeZone ? { timeZone: this.deps.timeZone } : {}),
      ...(shown.note ? { note: shown.note } : {}),
    });
    const page = Math.min(Math.max(shown.page, 0), pages.length - 1);
    shown.page = page;
    const nav: ApiButton[] = [];
    if (page > 0) nav.push({ text: "◀ Prev", data: `p:${kind}:${page - 1}` });
    if (page < pages.length - 1) nav.push({ text: "Next ▶", data: `p:${kind}:${page + 1}` });
    const actions: ApiButton[] = [{ text: "🔄 Refresh", data: `r:${kind}` }, CLOSE];
    return { text: pages[page]!, buttons: nav.length > 0 ? [nav, actions] : [actions] };
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
      lines.push(
        saved
          ? `${kind === "mine" ? "📤" : "📥"} ${kind}: ${saved.snapshot.prs.length} PRs, polled ${ago(saved.snapshot.generatedAt, this.now())} ago`
          : `${kind === "mine" ? "📤" : "📥"} ${kind}: not polled yet`
      );
    }
    lines.push(`⏱ every ${formatInterval(intervalMs)}`);
    if (mergeStatuses) lines.push(`🎫 "Time to merge" waits for Jira: ${escapeHtml(mergeStatuses.join(", "))}`);
    return lines.join("\n");
  }
}
