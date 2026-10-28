import { DEFAULT_INTERVAL_MS, formatInterval, readInterval } from "../config/interval.js";
import type { Settings, SettingsStore } from "../config/settings.js";
import type { MineSnapshot, Snapshot, TodoSnapshot, TrackSnapshot } from "../contract/snapshot.js";
import { entryLabel, linkRepo, parseRef, sameEntry, type TrackedEntry, type TrackedList } from "../config/tracked.js";
import { computeEvents, type MergeGate } from "../diff/diff.js";
import { bold, clip, escapeHtml } from "../format/format.js";
import { sleep } from "../runner/loop.js";
import { errorMessage, type Command, type Logger, type SnapshotSource } from "../runner/types.js";
import type { StateStore } from "../state/store.js";
import { TelegramError, type ApiButton, type BotCommand, type Update } from "../telegram/api.js";
import { LiveView } from "./live.js";
import type { BotStateStore } from "./state.js";
import type { BotApi } from "./types.js";
import { isDone, renderTrackedParts } from "./tracked.js";
import { ago, plural, profileHeading, renderLists } from "./views.js";
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
const EMPTY_TRACKED = (now: Date, note?: string): string => renderTrackedParts([], { now, ...(note ? { note } : {}) })[0]!;
const TRACK_PROMPT = `➕ Send what to follow, several at once if you like: a PR number (<code>1281</code>), a PR link, a Jira ticket (<code>PRJ-1824</code>) or a Jira link.

A ticket stands for every PR whose title names it, including PRs opened later.`;
// A question the bot asked ("send the Jira status") is forgotten after this long.
const ANSWER_WITHIN_MS = 10 * 60_000;

// One gh-pr-tools profile the run polls.
export interface BotProfile {
  profile: string;
  // The commands polled for it: a list can only be shown for these.
  commands: Command[];
  source: SnapshotSource;
  stores: Record<Command, StateStore>;
  // The PRs and tickets /tracked shows and /track and /untrack edit; without it there is no tracking.
  tracked?: TrackedList;
  // Asks gh-pr-tools about references without following them, to find their profile.
  probe?: (refs: string[]) => Promise<TrackSnapshot>;
}

export interface BotDeps {
  api: BotApi;
  chatId: string;
  // With several, answers get a section per profile and /track finds the profile of what it adds.
  profiles: BotProfile[];
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

// One profile's data in an answer; null for a tracked list whose PRs could not be loaded.
interface Part {
  profile: BotProfile;
  snapshot: Snapshot | null;
}

interface Shown {
  messageId: number;
  kind: Command;
  parts: Part[];
  note?: string;
  page: number;
}

type Loaded = { parts: Part[]; note?: string };

type Removal = { profile: BotProfile; entries: TrackedEntry[] };

// A reference that fits several profiles, asked about with a button for each.
interface Question {
  action: "add" | "remove";
  entry: TrackedEntry;
  candidates: BotProfile[];
  // A ticket can have PRs in several repos, so following it in all of them is a choice too.
  all: boolean;
  text: string;
}

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
  // Set while /track or /untrack asks which profile a reference is for, one question at a time.
  private choosing: {
    messageId: number;
    action: "add" | "remove";
    questions: Question[];
    notes: string[];
    changed: BotProfile[];
  } | null = null;

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
    this.choosing = null;
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
    if (!data.startsWith("tq:")) this.choosing = null;
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
    if (data.startsWith("tq:")) {
      await this.onChoose(data, query.message.message_id, answer);
      return;
    }
    const match = /^([pr]):(mine|todo|track)(?::(\d+))?$/.exec(data);
    if (!match || this.polling(match[2] as Command).length === 0) {
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
    const profiles = kind === "track" ? this.followed() : this.polling(kind);
    if (profiles.length === 0) {
      await this.showTracked(messageId, {});
      return;
    }
    let loaded: Loaded;
    try {
      loaded = await this.load(kind, profiles, previous?.parts);
    } catch (err) {
      await this.live.update(messageId, `⚠️ Could not load ${kind}: ${this.reason(err)}`, [[CLOSE]]);
      return;
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

  // The profiles that poll this command; with several, an answer has a section for each.
  private polling(kind: Command): BotProfile[] {
    return this.deps.profiles.filter((p) => p.commands.includes(kind) && (kind !== "track" || p.tracked !== undefined));
  }

  private entries(profile: BotProfile): TrackedEntry[] {
    return profile.tracked?.read().entries ?? [];
  }

  // The profiles whose tracked list names something.
  private followed(): BotProfile[] {
    return this.polling("track").filter((p) => this.entries(p).length > 0);
  }

  // " in <profile>" after what changed, when several profiles follow PRs.
  private where(profile: BotProfile): string {
    return this.polling("track").length > 1 ? ` in ${profile.profile}` : "";
  }

  // The repo of a profile, from its last poll of anything.
  private repoOf(profile: BotProfile): string | null {
    const kinds: Command[] = ["track", "mine", "todo"];
    return kinds.map((k) => profile.stores[k].peek()?.snapshot.repo.toLowerCase()).find((r) => r !== undefined) ?? null;
  }

  // The saved snapshots, when every one is recent enough to answer with.
  private stored(kind: Command): Part[] | null {
    const parts: Part[] = [];
    for (const profile of kind === "track" ? this.followed() : this.polling(kind)) {
      const baseline = profile.stores[kind].peek();
      if (!baseline || this.now().getTime() - Date.parse(baseline.snapshot.generatedAt) >= this.freshMs) return null;
      parts.push({ profile, snapshot: baseline.snapshot });
    }
    return parts;
  }

  // Asks GitHub now. Run through the diff so a status GitHub is still computing keeps its last known value, as in notifications.
  private async fetchFresh(profile: BotProfile, kind: Command): Promise<Snapshot> {
    const current = await profile.source(kind);
    const baseline = profile.stores[kind].peek();
    return baseline ? computeEvents(baseline, current, this.gate(kind)).next.snapshot : current;
  }

  // Fresh data from each profile. One that fails keeps what was shown or its last saved poll, with a note saying so;
  // it is an error only when no profile has anything to show.
  private async load(kind: Command, profiles: BotProfile[], keep: Part[] = []): Promise<Loaded> {
    const results = await Promise.all(
      profiles.map(async (profile) => {
        try {
          return { profile, snapshot: (await this.fetchFresh(profile, kind)) as Snapshot | null };
        } catch (error) {
          const kept = keep.find((p) => p.profile === profile)?.snapshot ?? profile.stores[kind].peek()?.snapshot ?? null;
          return { profile, snapshot: kept, error };
        }
      })
    );
    const failed = results.filter((r) => "error" in r);
    if (results.every((r) => r.snapshot === null)) throw failed[0]?.error;
    const several = this.polling(kind).length > 1;
    const notes = failed.map(
      (r) =>
        `⚠️ Could not ${r.snapshot ? "refresh" : "load"}${several ? ` ${escapeHtml(r.profile.profile)}` : ""}: ${this.reason(r.error)}`
    );
    const parts = results
      .filter((r) => r.snapshot !== null || kind === "track")
      .map(({ profile, snapshot }) => ({ profile, snapshot }));
    return notes.length > 0 ? { parts, note: notes.join("\n") } : { parts };
  }

  private async openList(kind: Command, replaces: number): Promise<void> {
    const profiles = this.polling(kind);
    if (profiles.length === 0) {
      await this.live.show(`ℹ️ This run does not poll ${kind} (see --commands).`, [[CLOSE]], { replaces });
      this.shown = null;
      return;
    }
    const saved = this.stored(kind);
    if (saved) {
      const shown: Shown = { messageId: 0, kind, parts: saved, page: 0 };
      const { text, buttons } = this.page(shown);
      shown.messageId = await this.live.show(text, buttons, { replaces });
      this.shown = shown;
      return;
    }

    const messageId = await this.live.show("⏳ Loading…", [], { replaces });
    this.shown = null;
    try {
      const loaded = await this.load(kind, profiles);
      this.shown = { messageId, kind, ...loaded, page: 0 };
      await this.draw(this.shown);
    } catch (err) {
      await this.live.update(messageId, `⚠️ Could not load ${kind}: ${this.reason(err)}`, [[CLOSE]]);
    }
  }

  private page(shown: Shown): { text: string; buttons: ApiButton[][] } {
    const { kind, parts } = shown;
    const gate = this.gate(kind);
    const named = (p: BotProfile) => (this.polling(kind).length > 1 ? { profile: p.profile } : {});
    const options = {
      now: this.now(),
      ...(this.deps.timeZone ? { timeZone: this.deps.timeZone } : {}),
      ...(shown.note ? { note: shown.note } : {}),
    };
    const pages =
      kind === "track"
        ? renderTrackedParts(
            parts.map((p) => ({
              ...named(p.profile),
              entries: this.entries(p.profile),
              snapshot: p.snapshot as TrackSnapshot | null,
            })),
            options
          )
        : renderLists(
            parts.map((p) => ({ ...named(p.profile), snapshot: p.snapshot as MineSnapshot | TodoSnapshot })),
            { ...options, ...(gate ? { gate } : {}) }
          );
    const page = Math.min(Math.max(shown.page, 0), pages.length - 1);
    shown.page = page;
    const nav: ApiButton[] = [];
    if (page > 0) nav.push({ text: "◀ Prev", data: `p:${kind}:${page - 1}` });
    if (page < pages.length - 1) nav.push({ text: "Next ▶", data: `p:${kind}:${page + 1}` });
    const actions: ApiButton[] = [{ text: "🔄 Refresh", data: `r:${kind}` }, CLOSE];
    const edit = kind === "track" ? [this.trackButtons(parts)] : [];
    return { text: pages[page]!, buttons: [...(nav.length > 0 ? [nav] : []), ...edit, actions] };
  }

  // What is done in each profile: PRs that merged or closed, tickets whose PRs all did.
  private done(parts: Part[]): Removal[] {
    return parts
      .map((p) => ({
        profile: p.profile,
        entries: p.snapshot ? this.entries(p.profile).filter((e) => isDone(e, p.snapshot as TrackSnapshot)) : [],
      }))
      .filter((r) => r.entries.length > 0);
  }

  private trackButtons(parts: Part[]): ApiButton[] {
    const buttons: ApiButton[] = [ADD_TRACKED];
    if (this.followed().length > 0) buttons.push({ text: "➖ Remove", data: "tr" });
    if (this.done(parts).length > 0) buttons.push({ text: "🧹 Clear done", data: "tc" });
    return buttons;
  }

  // /tracked shows the list; /track and /untrack change it first (with nothing after them, they ask).
  private async onTrackCommand(action: "tracked" | "track" | "untrack", refs: string[], replaces: number): Promise<void> {
    this.shown = null;
    if (this.polling("track").length === 0) {
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
    if (action === "tracked") {
      if (this.followed().length === 0) {
        await this.live.show(EMPTY_TRACKED(this.now()), [[ADD_TRACKED, CLOSE]], { replaces });
        return;
      }
      const saved = this.stored("track");
      if (saved) {
        const shown: Shown = { messageId: 0, kind: "track", parts: saved, page: 0 };
        const { text, buttons } = this.page(shown);
        shown.messageId = await this.live.show(text, buttons, { replaces });
        this.shown = shown;
        return;
      }
    }
    const messageId = await this.live.show("⏳ Loading…", [], { replaces });
    if (action === "track") return this.addTracked(messageId, refs);
    if (action === "untrack") return this.untrack(messageId, refs);
    await this.showTracked(messageId, { fresh: this.followed() });
  }

  // Button taps on the tracked list: tv (back to it), ta (asks what to add), tr / tr:[<profile>:]<entry> (remove),
  // tc (clear done).
  private async onTrackTap(data: string, messageId: number, answer: (text?: string) => Promise<void>): Promise<void> {
    if (this.polling("track").length === 0) {
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
      const match = /^tr:(?:(\d+):)?(.+)$/.exec(data)!;
      const profile = match[1] === undefined ? this.polling("track")[0] : this.deps.profiles[Number(match[1])];
      const entry = parseRef(match[2]!);
      await this.removeAndShow(messageId, profile?.tracked && entry ? [{ profile, entries: [entry] }] : []);
      return;
    }
    if (data === "tc") {
      const parts =
        this.shown?.kind === "track"
          ? this.shown.parts
          : this.followed().map((profile) => ({ profile, snapshot: profile.stores.track.peek()?.snapshot ?? null }));
      const done = this.done(parts);
      await answer(done.length > 0 ? "Cleared" : "Nothing is done yet");
      await this.removeAndShow(messageId, done);
      return;
    }
    await answer();
    await this.showTracked(messageId, {});
  }

  // One button per entry; with several profiles, a label that two lists share names its profile.
  private removeScreen(note?: string): { text: string; buttons: ApiButton[][] } {
    const targets = this.polling("track");
    const items = targets.flatMap((profile) => this.entries(profile).map((entry) => ({ profile, entry })));
    const buttons = items.slice(0, MAX_REMOVE_BUTTONS).map(({ profile, entry }) => {
      const label = entryLabel(entry);
      const shared = items.filter((i) => entryLabel(i.entry) === label).length > 1;
      return {
        text: `✖ ${label}${shared ? ` · ${profile.profile}` : ""}`,
        data: targets.length > 1 ? `tr:${this.deps.profiles.indexOf(profile)}:${label}` : `tr:${label}`,
      };
    });
    const rows: ApiButton[][] = [];
    for (let i = 0; i < buttons.length; i += 3) rows.push(buttons.slice(i, i + 3));
    const text = buttons.length > 0 ? "➖ Tap what to stop following:" : "📭 Nothing tracked yet.";
    return { text: `${text}${note ? `\n\n${note}` : ""}`, buttons: [...rows, [BACK_TO_TRACKED, CLOSE]] };
  }

  // Adds to each profile's list; says what was added, what was there already and what could not be read.
  private addEntries(additions: { profile: BotProfile; refs: string[] }[]): { notes: string[]; changed: BotProfile[] } {
    const notes: string[] = [];
    const changed: BotProfile[] = [];
    for (const { profile, refs } of additions) {
      try {
        const { added, already, invalid } = profile.tracked!.add(refs);
        const where = this.where(profile);
        if (added.length > 0) {
          const labels = added.map(entryLabel).join(", ");
          notes.push(`✔️ Following ${escapeHtml(labels + where)}`);
          this.deps.log.info(`tracking ${labels}${where} from Telegram`);
          changed.push(profile);
        }
        if (already.length > 0) notes.push(`Already followed: ${escapeHtml(already.map(entryLabel).join(", ") + where)}`);
        if (invalid.length > 0) notes.push(`⚠️ Not a PR or a Jira ticket: ${escapeHtml(clip(invalid.join(", "), ERROR_MAX))}`);
      } catch (err) {
        this.deps.log.warn(`could not change the tracked list: ${errorMessage(err)}`);
        notes.push(`⚠️ Not saved: ${this.reason(err)}`);
      }
    }
    return { notes, changed };
  }

  private removeEntries(removals: Removal[]): string[] {
    const notes: string[] = [];
    for (const { profile, entries } of removals) {
      try {
        const removed = profile.tracked!.remove(entries);
        if (removed.length === 0) continue;
        const labels = removed.map(entryLabel).join(", ");
        notes.push(`✔️ No longer following ${escapeHtml(labels + this.where(profile))}`);
        this.deps.log.info(`stopped tracking ${labels}${this.where(profile)} from Telegram`);
      } catch (err) {
        this.deps.log.warn(`could not change the tracked list: ${errorMessage(err)}`);
        notes.push(`⚠️ Not saved: ${this.reason(err)}`);
      }
    }
    return notes;
  }

  private async removeAndShow(messageId: number, removals: Removal[]): Promise<void> {
    const notes = this.removeEntries(removals);
    await this.showTracked(messageId, { note: notes.length > 0 ? notes.join("\n") : "Nothing to remove." });
  }

  private async addTracked(messageId: number, refs: string[]): Promise<void> {
    const targets = this.polling("track");
    if (targets.length === 1) {
      const { notes, changed } = this.addEntries([{ profile: targets[0]!, refs }]);
      await this.showTracked(messageId, { note: notes.join("\n") || "Nothing to add.", fresh: changed });
      return;
    }
    const routed = await this.route(messageId, refs, targets);
    const { notes, changed } = this.addEntries(routed.additions);
    this.choosing = { messageId, action: "add", questions: routed.questions, notes: [...notes, ...routed.notes], changed };
    await this.askNext();
  }

  // Finds the profile of each reference: a PR link by its repo, a ticket by the repo that has its PRs or, with none
  // yet, by the profiles that take it. A PR number, or anything several profiles fit, is asked about.
  private async route(
    messageId: number,
    refs: string[],
    targets: BotProfile[]
  ): Promise<{ additions: { profile: BotProfile; refs: string[] }[]; questions: Question[]; notes: string[] }> {
    const entries: TrackedEntry[] = [];
    const invalid: string[] = [];
    for (const ref of refs) {
      const entry = parseRef(ref);
      if (!entry) invalid.push(ref.trim());
      else if (!entries.some((e) => e.text === entry.text)) entries.push(entry);
    }
    const notes: string[] = [];
    const lookups = entries.filter((e) => e.kind === "ticket" || linkRepo(e) !== null);
    let answers: { profile: BotProfile; snapshot?: TrackSnapshot; error?: unknown }[] = [];
    if (lookups.length > 0) {
      await this.live.update(messageId, "⏳ Loading…", []);
      answers = await Promise.all(
        targets.map(async (profile) => {
          try {
            if (!profile.probe) throw new Error("cannot look it up");
            return { profile, snapshot: await profile.probe(lookups.map((e) => e.text)) };
          } catch (error) {
            return { profile, error };
          }
        })
      );
    }
    for (const a of answers)
      if ("error" in a) notes.push(`⚠️ Could not ask ${escapeHtml(a.profile.profile)}: ${this.reason(a.error)}`);
    const unknown = answers.filter((a) => !a.snapshot).map((a) => a.profile);
    const additions = new Map<BotProfile, string[]>();
    const add = (profile: BotProfile, entry: TrackedEntry) =>
      additions.set(profile, [...(additions.get(profile) ?? []), entry.text]);
    const questions: Question[] = [];
    const ask = (entry: TrackedEntry, candidates: BotProfile[], text: string, all = false) =>
      questions.push({ action: "add", entry, candidates, all, text });

    for (const entry of entries) {
      const label = bold(entryLabel(entry));
      const repo = linkRepo(entry);
      if (entry.kind === "pr" && repo === null) {
        ask(entry, targets, `➕ Which profile is ${label} in?`);
      } else if (entry.kind === "pr") {
        const matches = answers.filter((a) => a.snapshot?.repo.toLowerCase() === repo).map((a) => a.profile);
        if (matches.length === 1) add(matches[0]!, entry);
        else if (matches.length + unknown.length === 0) notes.push(`⚠️ ${label}: no profile polls ${escapeHtml(repo!)}`);
        else ask(entry, matches.length > 0 ? matches : unknown, `➕ Which profile is ${label} in?`);
      } else {
        const tickets = answers.flatMap((a) => {
          const ticket = a.snapshot?.tickets?.find((t) => t.key === entry.key);
          return ticket ? [{ profile: a.profile, prs: ticket.prs.length }] : [];
        });
        const found = tickets.filter((t) => t.prs > 0).map((t) => t.profile);
        const taken = tickets.map((t) => t.profile);
        if (found.length === 1) add(found[0]!, entry);
        else if (found.length > 1) ask(entry, found, `➕ ${label} has PRs in several repos. Follow it in:`, true);
        else if (taken.length === 1 && unknown.length === 0) add(taken[0]!, entry);
        else if (taken.length + unknown.length === 0) {
          notes.push(`⚠️ ${label}: no profile takes this ticket (another Jira prefix?)`);
        } else ask(entry, [...taken, ...unknown], `➕ ${label} has no PR yet. Which profile is it for?`, true);
      }
    }
    if (invalid.length > 0) notes.push(`⚠️ Not a PR or a Jira ticket: ${escapeHtml(clip(invalid.join(", "), ERROR_MAX))}`);
    return { additions: [...additions].map(([profile, refs]) => ({ profile, refs })), questions, notes };
  }

  // Removes each reference from the lists that name it; a PR number two lists name is asked about.
  private async untrack(messageId: number, refs: string[]): Promise<void> {
    const targets = this.polling("track");
    const removals = new Map<BotProfile, TrackedEntry[]>();
    const questions: Question[] = [];
    const invalid: string[] = [];
    for (const ref of refs) {
      const entry = parseRef(ref);
      if (!entry) {
        invalid.push(ref.trim());
        continue;
      }
      // A link names its repo: a list of another repo only follows a PR of the same number.
      const repo = linkRepo(entry);
      const holders = targets.filter(
        (p) => this.entries(p).some((e) => sameEntry(e, entry)) && (repo === null || [null, repo].includes(this.repoOf(p)))
      );
      if (entry.kind === "pr" && holders.length > 1) {
        const text = `➖ ${bold(entryLabel(entry))} is followed in several profiles. Stop following it in:`;
        questions.push({ action: "remove", entry, candidates: holders, all: false, text });
      } else for (const p of holders) removals.set(p, [...(removals.get(p) ?? []), entry]);
    }
    const notes = this.removeEntries([...removals].map(([profile, entries]) => ({ profile, entries })));
    if (notes.length === 0 && questions.length === 0) notes.push("Nothing to remove.");
    if (invalid.length > 0) notes.push(`⚠️ Not a PR or a Jira ticket: ${escapeHtml(clip(invalid.join(", "), ERROR_MAX))}`);
    this.choosing = { messageId, action: "remove", questions, notes, changed: [] };
    await this.askNext();
  }

  // Asks about the next reference that fits several profiles; after the last, shows the list with what changed.
  private async askNext(): Promise<void> {
    const choosing = this.choosing;
    if (!choosing) return;
    const question = choosing.questions[0];
    const notes = choosing.notes.join("\n");
    if (!question) {
      this.choosing = null;
      const nothing = choosing.action === "add" ? "Nothing to add." : "Nothing to remove.";
      await this.showTracked(choosing.messageId, { note: notes || nothing, fresh: choosing.changed });
      return;
    }
    const picks = question.candidates.map((p) => ({ text: p.profile, data: `tq:${this.deps.profiles.indexOf(p)}` }));
    const rows: ApiButton[][] = [];
    for (let i = 0; i < picks.length; i += 2) rows.push(picks.slice(i, i + 2));
    if (question.all) rows.push([{ text: "All of them", data: "tq:*" }]);
    rows.push([{ text: "Skip", data: "tq:-" }, CLOSE]);
    await this.live.update(choosing.messageId, `${question.text}${notes ? `\n\n${notes}` : ""}`, rows);
  }

  // A tap on a question: tq:<profile> picks one, tq:* all of them, tq:- skips the reference.
  private async onChoose(data: string, messageId: number, answer: (text?: string) => Promise<void>): Promise<void> {
    const choosing = this.choosing;
    const question = choosing?.messageId === messageId ? choosing.questions.shift() : undefined;
    await answer();
    if (!choosing || !question) return;
    const pick = data.slice(3);
    const chosen =
      pick === "*" && question.all
        ? question.candidates
        : question.candidates.filter((p) => String(this.deps.profiles.indexOf(p)) === pick);
    if (question.action === "add") {
      const { notes, changed } = this.addEntries(chosen.map((profile) => ({ profile, refs: [question.entry.text] })));
      choosing.notes.push(...notes);
      choosing.changed.push(...changed);
    } else {
      choosing.notes.push(...this.removeEntries(chosen.map((profile) => ({ profile, entries: [question.entry] }))));
    }
    await this.askNext();
  }

  // The tracked list on this message: from what is on screen or the last poll, or asked for now for the profiles
  // in `fresh` (after an addition) and those with nothing to show yet.
  private async showTracked(messageId: number, { note, fresh = [] }: { note?: string; fresh?: BotProfile[] }): Promise<void> {
    const followed = this.followed();
    if (followed.length === 0) {
      this.shown = null;
      await this.live.update(messageId, EMPTY_TRACKED(this.now(), note), [[ADD_TRACKED, CLOSE]]);
      return;
    }
    const kept = this.shown?.kind === "track" ? this.shown.parts : [];
    const known = (profile: BotProfile): Snapshot | null =>
      kept.find((p) => p.profile === profile)?.snapshot ?? profile.stores.track.peek()?.snapshot ?? null;
    const stale = followed.filter((p) => fresh.includes(p) || known(p) === null);
    let loaded: Loaded = { parts: [] };
    if (stale.length > 0) {
      if (fresh.length > 0) await this.live.update(messageId, "⏳ Loading…", []);
      try {
        loaded = await this.load("track", stale, kept);
      } catch (err) {
        await this.live.update(messageId, `⚠️ Could not load the tracked PRs: ${this.reason(err)}`, [[BACK_TO_TRACKED, CLOSE]]);
        return;
      }
    }
    const parts = followed.map(
      (profile) => loaded.parts.find((p) => p.profile === profile) ?? { profile, snapshot: known(profile) }
    );
    const notes = [note, loaded.note].filter((n): n is string => n !== undefined);
    this.shown = { messageId, kind: "track", parts, page: 0, ...(notes.length > 0 ? { note: notes.join("\n") } : {}) };
    await this.draw(this.shown);
  }

  private async draw(shown: Shown): Promise<void> {
    const { text, buttons } = this.page(shown);
    await this.live.update(shown.messageId, text, buttons);
  }

  private statusText(): string {
    const { profiles } = this.deps;
    const settings = this.deps.settings();
    const intervalMs = this.deps.intervalFlagMs ?? settings.intervalMs ?? DEFAULT_INTERVAL_MS;
    const { mergeStatuses } = settings;
    const several = profiles.length > 1;
    const lines = [
      several
        ? `ℹ️ ${bold("Status")}`
        : `ℹ️ ${bold("Status")} · profile <code>${escapeHtml(profiles[0]?.profile ?? "")}</code>`,
    ];
    for (const profile of profiles) {
      if (several) lines.push(profileHeading(profile.profile));
      for (const kind of profile.commands) {
        const saved = profile.stores[kind].peek();
        const icon = { mine: "📤", todo: "📥", track: "📌" }[kind];
        if (kind === "track") {
          const count = this.entries(profile).length;
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
    }
    lines.push(`⏱ every ${formatInterval(intervalMs)}`);
    if (mergeStatuses) lines.push(`🎫 "Time to merge" waits for Jira: ${escapeHtml(mergeStatuses.join(", "))}`);
    return lines.join("\n");
  }
}
