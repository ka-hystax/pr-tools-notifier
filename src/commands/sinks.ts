import type { ConfigStore } from "../config/config.js";
import type { Sink } from "../runner/types.js";
import { TelegramApi } from "../telegram/api.js";
import { TelegramSink } from "../telegram/sink.js";

export const NOT_CONFIGURED = "pr-tools-notifier: not set up yet, run `pr-tools-notifier init` first";

export function telegramSink(config: ConfigStore, signal?: AbortSignal): Sink | null {
  const saved = config.load();
  if (!saved) return null;
  const api = new TelegramApi({ token: saved.token, ...(signal ? { signal } : {}) });
  return new TelegramSink(api, saved.chatId);
}
