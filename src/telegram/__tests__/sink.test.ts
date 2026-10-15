import { describe, expect, test } from "vitest";
import type { OutMessage } from "../../format/format.js";
import { TelegramError, type SendParams } from "../api.js";
import { TelegramSink } from "../sink.js";

const message = (text: string, over: Partial<OutMessage> = {}): OutMessage => ({
  text,
  buttons: [[{ text: "🔗 Open", url: "https://x.test/1" }]],
  silent: false,
  ...over,
});

function harness(failures: (Error | null)[] = []) {
  const sent: SendParams[] = [];
  const sleeps: number[] = [];
  let i = 0;
  const api = {
    async sendMessage(params: SendParams) {
      const failure = failures[i++];
      sent.push(params);
      if (failure) throw failure;
    },
  };
  const sink = new TelegramSink(api, "42", { pauseMs: 1_000, sleep: async (ms) => void sleeps.push(ms) });
  return { sink, sent, sleeps };
}

describe("TelegramSink", () => {
  test("sends each message with its buttons and silence, to the configured chat", async () => {
    const h = harness();
    await h.sink.deliver([message("a"), message("b", { silent: true, buttons: [] })]);
    expect(h.sent).toEqual([
      { chatId: "42", text: "a", buttons: [[{ text: "🔗 Open", url: "https://x.test/1" }]], silent: false },
      { chatId: "42", text: "b", buttons: [], silent: true },
    ]);
  });

  test("pauses between the messages of a series but not before the first", async () => {
    const h = harness();
    await h.sink.deliver([message("a"), message("b"), message("c")]);
    expect(h.sleeps).toEqual([1_000, 1_000]);
    await harness().sink.deliver([message("only")]);
  });

  test("sends alerts loudly and without buttons", async () => {
    const h = harness();
    await h.sink.alert("⚠️ <b>failing</b>");
    expect(h.sent).toEqual([{ chatId: "42", text: "⚠️ <b>failing</b>", buttons: [], silent: false }]);
  });

  test("resends a message Telegram cannot parse as plain text, so it cannot block the queue forever", async () => {
    const parseError = new TelegramError("sendMessage: 400 Bad Request: can't parse entities: Unsupported start tag", 400);
    const h = harness([parseError]);
    await h.sink.deliver([message("<b>#1</b> a &amp; b\n<blockquote>quoted</blockquote>", { silent: true })]);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]).toEqual({
      chatId: "42",
      text: "#1 a & b\n│ quoted",
      buttons: [[{ text: "🔗 Open", url: "https://x.test/1" }]],
      silent: true,
      plain: true,
    });
  });

  test("does not hide other errors", async () => {
    const other = new TelegramError("sendMessage: 400 Bad Request: chat not found", 400);
    await expect(harness([other]).sink.deliver([message("a")])).rejects.toBe(other);
    const network = new Error("socket hang up");
    await expect(harness([network]).sink.deliver([message("a")])).rejects.toBe(network);
    const server = new TelegramError("sendMessage: 502 Bad Gateway", 502);
    await expect(harness([server]).sink.deliver([message("a")])).rejects.toBe(server);
  });

  test("stops the series at the first message that fails", async () => {
    const failure = new TelegramError("sendMessage: 403 Forbidden: bot was blocked by the user", 403);
    const h = harness([null, failure]);
    await expect(h.sink.deliver([message("a"), message("b"), message("c")])).rejects.toBe(failure);
    expect(h.sent.map((s) => s.text)).toEqual(["a", "b"]);
  });
});
