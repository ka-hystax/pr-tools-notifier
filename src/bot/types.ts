import type { BotCommand, EditParams, SendParams, Update } from "../telegram/api.js";

// What the bot needs from Telegram; TelegramApi provides all of it.
export interface BotApi {
  getUpdates(offset: number | undefined, timeoutSec: number): Promise<Update[]>;
  sendMessage(params: SendParams): Promise<{ messageId: number }>;
  editMessageText(params: EditParams): Promise<void>;
  deleteMessage(chatId: string | number, messageId: number): Promise<void>;
  answerCallbackQuery(id: string, text?: string): Promise<void>;
  setMyCommands(commands: BotCommand[]): Promise<void>;
}
