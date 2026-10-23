import type { Button } from "../format/format.js";

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly status: number | null
  ) {
    super(message);
  }
}

export interface Update {
  update_id: number;
  message?: { message_id: number; date: number; text?: string; chat: { id: number; type: string } };
  callback_query?: { id: string; data?: string; message?: { message_id: number; chat: { id: number; type: string } } };
}

// A button inside a message: a link, or a tap the bot hears about as callback data (up to 64 bytes).
export type ApiButton = Button | { text: string; data: string };

export interface SendParams {
  chatId: string | number;
  text: string;
  silent?: boolean;
  buttons?: ApiButton[][];
  // A keyboard that replaces the phone's own and stays until replaced.
  keyboard?: string[][];
  plain?: boolean;
}

export interface EditParams {
  chatId: string | number;
  messageId: number;
  text: string;
  buttons?: ApiButton[][];
}

export interface BotCommand {
  command: string;
  description: string;
}

function inlineKeyboard(buttons: ApiButton[][]) {
  return {
    inline_keyboard: buttons.map((row) =>
      row.map((b) => ("url" in b ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data }))
    ),
  };
}

export interface ApiOptions {
  token: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  baseUrl?: string;
  timeoutMs?: number;
}

interface ApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  parameters?: { retry_after?: number };
}

const MAX_RETRIES = 3;
const BACKOFF_MS = [1_000, 3_000, 5_000];
const MAX_RETRY_AFTER_S = 60;

// Minimal Bot API client: every call retries rate limits and transient failures a few times.
export class TelegramApi {
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: ApiOptions) {
    this.fetchFn = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.baseUrl = options.baseUrl ?? "https://api.telegram.org";
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async getMe(): Promise<{ username: string }> {
    const me = await this.call<{ username?: string }>("getMe", {});
    if (!me.username) throw new TelegramError("getMe: the bot has no username", null);
    return { username: me.username };
  }

  async getUpdates(offset: number | undefined, timeoutSec: number): Promise<Update[]> {
    const body: Record<string, unknown> = { timeout: timeoutSec, allowed_updates: ["message", "callback_query"] };
    if (offset !== undefined) body.offset = offset;
    return this.call<Update[]>("getUpdates", body, timeoutSec * 1000);
  }

  async sendMessage({ chatId, text, silent, buttons, keyboard, plain }: SendParams): Promise<{ messageId: number }> {
    const body: Record<string, unknown> = { chat_id: chatId, text, link_preview_options: { is_disabled: true } };
    if (!plain) body.parse_mode = "HTML";
    if (silent) body.disable_notification = true;
    if (buttons && buttons.length > 0) {
      body.reply_markup = inlineKeyboard(buttons);
    } else if (keyboard && keyboard.length > 0) {
      body.reply_markup = {
        keyboard: keyboard.map((row) => row.map((text) => ({ text }))),
        resize_keyboard: true,
        is_persistent: true,
      };
    }
    const message = await this.call<{ message_id: number }>("sendMessage", body);
    return { messageId: message.message_id };
  }

  async editMessageText({ chatId, messageId, text, buttons }: EditParams): Promise<void> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    };
    if (buttons && buttons.length > 0) body.reply_markup = inlineKeyboard(buttons);
    await this.call("editMessageText", body);
  }

  async deleteMessage(chatId: string | number, messageId: number): Promise<void> {
    await this.call("deleteMessage", { chat_id: chatId, message_id: messageId });
  }

  async answerCallbackQuery(id: string, text?: string): Promise<void> {
    await this.call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) });
  }

  async setMyCommands(commands: BotCommand[]): Promise<void> {
    await this.call("setMyCommands", { commands });
  }

  private redact(text: string): string {
    return text.split(this.options.token).join("<token>");
  }

  private async call<T>(method: string, body: object, longPollMs = 0): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const timeout = AbortSignal.timeout(this.timeoutMs + longPollMs);
      const signal = this.options.signal ? AbortSignal.any([this.options.signal, timeout]) : timeout;

      let response: Response;
      try {
        response = await this.fetchFn(`${this.baseUrl}/bot${this.options.token}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal,
        });
      } catch (err) {
        if (this.options.signal?.aborted) throw new TelegramError(`${method}: aborted`, null);
        if (attempt < MAX_RETRIES) {
          await this.sleep(BACKOFF_MS[attempt]!);
          continue;
        }
        const reason = err instanceof Error ? err.message : String(err);
        throw new TelegramError(this.redact(`${method}: network error: ${reason}`), null);
      }

      const json = (await response.json().catch(() => null)) as ApiResponse<T> | null;
      if (json?.ok) return json.result as T;

      const description = json?.description ?? response.statusText;
      const retryAfter = json?.parameters?.retry_after;
      if (response.status === 429 && retryAfter !== undefined && retryAfter <= MAX_RETRY_AFTER_S && attempt < MAX_RETRIES) {
        await this.sleep(retryAfter * 1_000 + 250);
        continue;
      }
      if (response.status >= 500 && attempt < MAX_RETRIES) {
        await this.sleep(BACKOFF_MS[attempt]!);
        continue;
      }
      throw new TelegramError(this.redact(`${method}: ${response.status} ${description}`), response.status);
    }
  }
}
