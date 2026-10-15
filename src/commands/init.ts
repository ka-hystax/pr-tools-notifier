import { randomBytes } from "node:crypto";
import type { ConfigStore } from "../config/config.js";
import type { SendParams, Update } from "../telegram/api.js";

export interface Prompter {
  ask(question: string): Promise<string>;
  secret(question: string): Promise<string>;
  confirm(question: string): Promise<boolean>;
}

export interface InitApi {
  getMe(): Promise<{ username: string }>;
  getUpdates(offset: number | undefined, timeoutSec: number): Promise<Update[]>;
  sendMessage(params: SendParams): Promise<void>;
}

export interface InitDeps {
  prompter: Prompter;
  config: ConfigStore;
  createApi: (token: string) => InitApi;
  out: (line: string) => void;
  newCode?: () => string;
  now?: () => number;
  waitMs?: number;
}

const POLL_SECONDS = 20;

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

  out(INSTRUCTIONS);
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
    await api.sendMessage({ chatId, text: "✅ <b>Connected.</b> PR notifications will arrive here." });
  } catch (err) {
    out(`Could not send a message to that chat: ${describe(err)}`);
    return false;
  }

  config.save({ botUsername: username, chatId, token });
  out("Saved. Next: `pr-tools-notifier send-test`, then `pr-tools-notifier run -p <profile>`.");
  return true;
}
