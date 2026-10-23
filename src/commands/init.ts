import { randomBytes } from "node:crypto";
import { KEYBOARD } from "../bot/keyboard.js";
import type { ConfigStore } from "../config/config.js";
import { SettingsError, type SettingsStore } from "../config/settings.js";
import type { SendParams, Update } from "../telegram/api.js";

export interface Prompter {
  ask(question: string): Promise<string>;
  secret(question: string): Promise<string>;
  confirm(question: string): Promise<boolean>;
}

export interface InitApi {
  getMe(): Promise<{ username: string }>;
  getUpdates(offset: number | undefined, timeoutSec: number): Promise<Update[]>;
  sendMessage(params: SendParams): Promise<unknown>;
}

export interface InitDeps {
  prompter: Prompter;
  config: ConfigStore;
  // Where the optional Jira question saves its answer; without it the question is not asked.
  settings?: SettingsStore;
  createApi: (token: string) => InitApi;
  out: (line: string) => void;
  newCode?: () => string;
  now?: () => number;
  waitMs?: number;
}

const POLL_SECONDS = 20;

const REQUIREMENTS = `Needed: gh-pr-tools with a profile (\`gh pr-tools init\`). Jira is optional and comes at the end.
`;

const INSTRUCTIONS = `You need your own Telegram bot (it takes a minute):
  1. Open https://t.me/BotFather
  2. Send /newbot and answer the questions (the username must end with "bot")
  3. Copy the token BotFather sends you`;

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function waitForStart(api: InitApi, code: string, now: () => number, waitMs: number): Promise<string | null> {
  const deadline = now() + waitMs;
  let offset: number | undefined;
  while (now() < deadline) {
    for (const update of await api.getUpdates(offset, POLL_SECONDS)) {
      offset = Math.max(offset ?? 0, update.update_id + 1);
      const message = update.message;
      if (message?.chat.type === "private" && message.text?.trim() === `/start ${code}`) return String(message.chat.id);
    }
  }
  return null;
}

// Resolves to whether the configuration was saved.
export async function runInit({
  prompter,
  config,
  settings,
  createApi,
  out,
  newCode,
  now = Date.now,
  waitMs = 120_000,
}: InitDeps): Promise<boolean> {
  if (config.exists() && !(await prompter.confirm("A configuration already exists. Replace it?"))) {
    out("Nothing changed.");
    return false;
  }

  out(REQUIREMENTS + INSTRUCTIONS);
  const token = (await prompter.secret("Bot token: ")).trim();
  if (!/^\d+:[\w-]+$/.test(token)) {
    out("That does not look like a bot token (expected something like 123456:ABC-DEF…).");
    return false;
  }

  const api = createApi(token);
  let username: string;
  try {
    ({ username } = await api.getMe());
  } catch (err) {
    out(`Telegram did not accept the token: ${describe(err)}`);
    return false;
  }

  const code = (newCode ?? (() => randomBytes(4).toString("hex")))();
  out(`Found @${username}. Open this link and press Start (or send "/start ${code}" to the bot):`);
  out(`  https://t.me/${username}?start=${code}`);
  out("Waiting up to 2 minutes…");

  let chatId: string | null;
  try {
    chatId = await waitForStart(api, code, now, waitMs);
  } catch (err) {
    out(`Could not read the bot's messages: ${describe(err)}`);
    return false;
  }
  if (chatId === null) {
    out("Did not see your message in time.");
    chatId = (await prompter.ask("Paste your chat id (a number) to continue, or press Enter to cancel: ")).trim();
    if (!/^-?\d+$/.test(chatId)) {
      out("Cancelled, nothing saved.");
      return false;
    }
  }

  try {
    await api.sendMessage({
      chatId,
      text: "✅ <b>Connected.</b> PR notifications will arrive here.\nAsk me for your lists with the buttons below: /todo, /mine, /status.",
      keyboard: KEYBOARD,
    });
  } catch (err) {
    out(`Could not send a message to that chat: ${describe(err)}`);
    return false;
  }

  config.save({ botUsername: username, chatId, token });
  out("Saved.");
  if (settings) await askJira(prompter, settings, out);
  out("Next: `pr-tools-notifier send-test`, then `pr-tools-notifier run` (add `-p <profile>` if you have several).");
  return true;
}

const JIRA_INTRO = `Optional, Jira: if your team merges only after the ticket reaches a status (a "Merge" column, say),
"Time to merge" can wait for it. Without this, it comes as soon as the PR is ready.`;

async function askJira(prompter: Prompter, settings: SettingsStore, out: (line: string) => void): Promise<void> {
  try {
    const current = settings.load().mergeStatuses;
    if (current) {
      out(`Jira: "Time to merge" waits for ${current.join(", ")} (already set; \`pr-tools-notifier config\` to change it).`);
      return;
    }
    out(JIRA_INTRO);
    if (!(await prompter.confirm("Set it up now?"))) {
      out("Skipped. Later: `pr-tools-notifier config set merge-status Merge`.");
      return;
    }
    const answer = await prompter.ask("Status name (several: comma-separated): ");
    const saved = settings.set("MERGE_STATUS", answer);
    if (saved === "") {
      out("No status entered, skipped.");
      return;
    }
    out(`Saved MERGE_STATUS=${saved}.`);
    out(
      'Jira itself is read through your gh-pr-tools profile: it needs a Jira site, email and API token (see the README, "Waiting for Jira").'
    );
  } catch (err) {
    if (!(err instanceof SettingsError)) throw err;
    out(`Could not save the Jira setting: ${err.message}`);
  }
}
