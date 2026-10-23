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

import { KEYBOARD } from "./keyboard.js";

export { KEYBOARD };

export const BOT_COMMANDS: BotCommand[] = [
  { command: "todo", description: "PRs waiting for your review" },
  { command: "mine", description: "your open PRs" },
  { command: "status", description: "what is being watched" },
  { command: "help", description: "what the bot can do" },
];

const LABELS: Record<string, Action> = { "📥 Todo": "todo", "📤 Mine": "mine", "ℹ️ Status": "status" };

export type Action = "todo" | "mine" | "status" | "help" | "unknown";

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

An answer stays on screen until you ask for something else.`;

const CLOSE: ApiButton = { text: "✖ Close", data: "x" };
const ERROR_MAX = 300;

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
  settings: () => { intervalMs: number; mergeStatuses?: string[] };
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
    log.info("listening for commands: /todo, /mine, /status");

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
    if (action === "todo" || action === "mine") return this.openList(action, replaces);
    if (action === "status") {
      await this.live.show(this.statusText(), [[CLOSE]], { replaces });
    } else {
      const text = action === "unknown" ? `🤷 I did not get that.\n\n${HELP}` : HELP;
      await this.live.show(text, [], { replaces, keyboard: KEYBOARD });
    }
    this.shown = null;
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
    if (data === "x") {
      await answer();
      this.shown = null;
      await this.live.close();
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
    const { intervalMs, mergeStatuses } = this.deps.settings();
    const lines = [`ℹ️ ${bold("Status")} · profile <code>${escapeHtml(profile)}</code>`];
    for (const kind of commands) {
      const saved = stores[kind].peek();
      lines.push(
        saved
          ? `${kind === "mine" ? "📤" : "📥"} ${kind}: ${saved.snapshot.prs.length} PRs, polled ${ago(saved.snapshot.generatedAt, this.now())} ago`
          : `${kind === "mine" ? "📤" : "📥"} ${kind}: not polled yet`
      );
    }
    lines.push(`⏱ every ${Math.round(intervalMs / 60_000)} min`);
    if (mergeStatuses) lines.push(`🟣 "Time to merge" waits for Jira: ${escapeHtml(mergeStatuses.join(", "))}`);
    return lines.join("\n");
  }
}
