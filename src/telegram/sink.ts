import type { Button, OutMessage } from "../format/format.js";
import { htmlToText } from "../format/text.js";
import type { Sink } from "../runner/types.js";
import { TelegramError, type SendParams } from "./api.js";

export interface Sender {
  sendMessage(params: SendParams): Promise<void>;
}

export interface SinkOptions {
  pauseMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const PARSE_ERROR = /can't parse entities|can't find end of the entity/i;

// Telegram asks bots to stay under about one message per second to a chat.
export class TelegramSink implements Sink {
  private readonly pauseMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly api: Sender,
    private readonly chatId: string | number,
    options: SinkOptions = {}
  ) {
    this.pauseMs = options.pauseMs ?? 1_000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async deliver(messages: OutMessage[]): Promise<void> {
    for (const [i, message] of messages.entries()) {
      if (i > 0) await this.sleep(this.pauseMs);
      await this.send(message.text, message.buttons, message.silent);
    }
  }

  async alert(html: string): Promise<void> {
    await this.send(html, [], false);
  }

  // A message Telegram refuses to parse would otherwise be retried forever, so it goes out as plain text instead.
  private async send(text: string, buttons: Button[][], silent: boolean): Promise<void> {
    try {
      await this.api.sendMessage({ chatId: this.chatId, text, buttons, silent });
    } catch (err) {
      if (!(err instanceof TelegramError) || err.status !== 400 || !PARSE_ERROR.test(err.message)) throw err;
      await this.api.sendMessage({ chatId: this.chatId, text: htmlToText(text), buttons, silent, plain: true });
    }
  }
}
