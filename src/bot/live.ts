import type { ApiButton, SendParams } from "../telegram/api.js";
import { TelegramError } from "../telegram/api.js";
import type { Logger } from "../runner/types.js";
import { errorMessage } from "../runner/types.js";
import type { BotApi } from "./types.js";
import type { BotStateStore } from "./state.js";

const NOT_MODIFIED = /message is not modified/i;

// The one answer the bot keeps on screen. A new answer replaces it (and the command that asked for it),
// so the chat holds notifications and the latest view, never a trail of outdated lists.
export class LiveView {
  private messageId: number | null = null;

  constructor(
    private readonly api: BotApi,
    private readonly chatId: string,
    private readonly state: BotStateStore,
    private readonly log: Logger
  ) {}

  get current(): number | null {
    return this.messageId;
  }

  // Sends the new answer first, so the screen never goes blank, then takes the old ones down.
  async show(
    text: string,
    buttons: ApiButton[][],
    options: { replaces?: number; keyboard?: string[][] } = {}
  ): Promise<number> {
    const params: SendParams = { chatId: this.chatId, text, buttons };
    if (options.keyboard) params.keyboard = options.keyboard;
    const { messageId } = await this.api.sendMessage(params);
    const previous = this.messageId;
    this.messageId = messageId;
    this.remember();
    if (previous !== null) await this.remove(previous);
    if (options.replaces !== undefined) await this.remove(options.replaces);
    return messageId;
  }

  // Edits the answer in place. False when the text was already exactly this.
  async update(messageId: number, text: string, buttons: ApiButton[][]): Promise<boolean> {
    try {
      await this.api.editMessageText({ chatId: this.chatId, messageId, text, buttons });
      return true;
    } catch (err) {
      if (err instanceof TelegramError && err.status === 400 && NOT_MODIFIED.test(err.message)) return false;
      throw err;
    }
  }

  async close(): Promise<void> {
    const id = this.messageId;
    this.messageId = null;
    this.remember();
    if (id !== null) await this.remove(id);
  }

  // After a restart: whatever was on screen then is out of date.
  async clearLeftovers(): Promise<void> {
    const { view } = this.state.load();
    for (const id of view) await this.remove(id);
    this.messageId = null;
    this.remember();
  }

  // Taking a message down is a courtesy: one that is gone already or too old to delete is not a problem.
  async remove(messageId: number): Promise<void> {
    try {
      await this.api.deleteMessage(this.chatId, messageId);
    } catch (err) {
      this.log.info(`could not delete message ${messageId}: ${errorMessage(err)}`);
    }
  }

  private remember(): void {
    try {
      this.state.save({ ...this.state.load(), view: this.messageId === null ? [] : [this.messageId] });
    } catch (err) {
      this.log.warn(`could not save the bot state: ${errorMessage(err)}`);
    }
  }
}
