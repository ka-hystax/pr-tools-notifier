import { TelegramError } from "./api.js";

// What to do about a Telegram failure the user can fix; null for transient ones.
export function botHint(err: unknown): string | null {
  if (!(err instanceof TelegramError)) return null;
  if (err.status === 401 || err.status === 404) return "the bot token no longer works: run `pr-tools-notifier init`";
  if (err.status === 403) return "the bot cannot message you: unblock it and press Start in the chat";
  return null;
}
