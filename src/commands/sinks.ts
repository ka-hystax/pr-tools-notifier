import type { ConfigStore } from "../config/config.js";
import type { Sink } from "../runner/types.js";
import { errorMessage } from "../runner/types.js";
import { TelegramApi } from "../telegram/api.js";
import { botHint } from "../telegram/hints.js";
import { TelegramSink } from "../telegram/sink.js";

export const NOT_CONFIGURED = "pr-tools-notifier: not set up yet, run `pr-tools-notifier init` first";

export function telegramBot(config: ConfigStore, signal?: AbortSignal): { api: TelegramApi; sink: Sink } | null {
  const saved = config.load();
  if (!saved) return null;
  const api = new TelegramApi({ token: saved.token, ...(signal ? { signal } : {}) });
  return { api, sink: new TelegramSink(api, saved.chatId) };
}

export function telegramSink(config: ConfigStore, signal?: AbortSignal): Sink | null {
  return telegramBot(config, signal)?.sink ?? null;
}

export type BotCheck = { status: "ok" } | { status: "rejected" | "unreachable"; problem: string };

// "rejected" means Telegram refuses the token; a network failure or a 5xx is only "unreachable".
export async function checkBot(api: { getMe(): Promise<unknown> }): Promise<BotCheck> {
  try {
    await api.getMe();
    return { status: "ok" };
  } catch (err) {
    const hint = botHint(err);
    return hint
      ? { status: "rejected", problem: `${errorMessage(err)} (${hint})` }
      : { status: "unreachable", problem: errorMessage(err) };
  }
}
