import { describe, expect, test } from "vitest";
import { TelegramApi, TelegramError } from "../api.js";

const TOKEN = "123456:SECRET-token_value";

interface Sent {
  url: string;
  body: Record<string, unknown>;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const okResult = (result: unknown = { message_id: 7 }) => json({ ok: true, result });

function harness(responses: (Response | Error)[], over: { signal?: AbortSignal } = {}) {
  const sent: Sent[] = [];
  const sleeps: number[] = [];
  let i = 0;
  const fakeFetch = (async (url: string, init?: Parameters<typeof fetch>[1]) => {
    sent.push({ url, body: JSON.parse(init?.body as string) });
    const next = responses[i++];
    if (next === undefined) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  const api = new TelegramApi({ token: TOKEN, fetch: fakeFetch, sleep: async (ms) => void sleeps.push(ms), ...over });
  return { api, sent, sleeps, calls: () => i };
}

describe("sendMessage", () => {
  test("posts HTML with link previews disabled", async () => {
    const h = harness([okResult()]);
    await h.api.sendMessage({ chatId: "42", text: "<b>hi</b>" });
    expect(h.sent[0]!.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(h.sent[0]!.body).toEqual({
      chat_id: "42",
      text: "<b>hi</b>",
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  });

  test("sends silently, as plain text and with url buttons when asked", async () => {
    const h = harness([okResult(), okResult()]);
    await h.api.sendMessage({
      chatId: 42,
      text: "x",
      silent: true,
      plain: true,
      buttons: [[{ text: "🔗 Open", url: "https://github.com/a/b/pull/1" }], [{ text: "two", url: "https://x.test" }]],
    });
    expect(h.sent[0]!.body).toMatchObject({
      disable_notification: true,
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔗 Open", url: "https://github.com/a/b/pull/1" }],
          [{ text: "two", url: "https://x.test" }],
        ],
      },
    });
    expect(h.sent[0]!.body).not.toHaveProperty("parse_mode");

    await h.api.sendMessage({ chatId: 42, text: "y", buttons: [] });
    expect(h.sent[1]!.body).not.toHaveProperty("reply_markup");
    expect(h.sent[1]!.body).not.toHaveProperty("disable_notification");
  });
});

describe("getMe and getUpdates", () => {
  test("returns the bot username", async () => {
    const h = harness([okResult({ username: "my_bot", id: 1 })]);
    expect(await h.api.getMe()).toEqual({ username: "my_bot" });
  });

  test("rejects a bot without a username", async () => {
    await expect(harness([okResult({ id: 1 })]).api.getMe()).rejects.toThrow(/no username/);
  });

  test("asks for messages and button taps only, with the offset and the long-poll timeout", async () => {
    const h = harness([okResult([{ update_id: 7 }])]);
    expect(await h.api.getUpdates(8, 20)).toEqual([{ update_id: 7 }]);
    expect(h.sent[0]!.body).toEqual({ timeout: 20, allowed_updates: ["message", "callback_query"], offset: 8 });
    const first = harness([okResult([])]);
    await first.api.getUpdates(undefined, 0);
    expect(first.sent[0]!.body).not.toHaveProperty("offset");
  });
});

describe("talking to the owner", () => {
  test("sendMessage returns the id of the message it created", async () => {
    const h = harness([okResult({ message_id: 55 })]);
    expect(await h.api.sendMessage({ chatId: 1, text: "x" })).toEqual({ messageId: 55 });
  });

  test("sends callback buttons next to url buttons", async () => {
    const h = harness([okResult()]);
    await h.api.sendMessage({
      chatId: 1,
      text: "x",
      buttons: [
        [
          { text: "🔄", data: "r:mine" },
          { text: "Open", url: "https://x.test" },
        ],
      ],
    });
    expect(h.sent[0]!.body.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: "🔄", callback_data: "r:mine" },
          { text: "Open", url: "https://x.test" },
        ],
      ],
    });
  });

  test("sends a persistent reply keyboard", async () => {
    const h = harness([okResult()]);
    await h.api.sendMessage({ chatId: 1, text: "x", keyboard: [["📥 Todo", "📤 Mine"], ["ℹ️ Status"]] });
    expect(h.sent[0]!.body.reply_markup).toEqual({
      keyboard: [[{ text: "📥 Todo" }, { text: "📤 Mine" }], [{ text: "ℹ️ Status" }]],
      resize_keyboard: true,
      is_persistent: true,
    });
  });

  test("an inline keyboard wins over a reply keyboard, since a message carries only one", async () => {
    const h = harness([okResult()]);
    await h.api.sendMessage({ chatId: 1, text: "x", buttons: [[{ text: "a", data: "b" }]], keyboard: [["c"]] });
    expect(h.sent[0]!.body.reply_markup).toHaveProperty("inline_keyboard");
  });

  test("edits, deletes, answers taps and registers commands", async () => {
    const h = harness([okResult(), okResult(), okResult(), okResult(), okResult()]);
    await h.api.editMessageText({ chatId: 1, messageId: 9, text: "new", buttons: [[{ text: "x", data: "y" }]] });
    await h.api.deleteMessage(1, 9);
    await h.api.answerCallbackQuery("q1", "Refreshing…");
    await h.api.answerCallbackQuery("q2");
    await h.api.setMyCommands([{ command: "todo", description: "d" }]);
    expect(h.sent.map((s) => s.url.split("/").at(-1))).toEqual([
      "editMessageText",
      "deleteMessage",
      "answerCallbackQuery",
      "answerCallbackQuery",
      "setMyCommands",
    ]);
    expect(h.sent[0]!.body).toMatchObject({ chat_id: 1, message_id: 9, text: "new", parse_mode: "HTML" });
    expect(h.sent[1]!.body).toEqual({ chat_id: 1, message_id: 9 });
    expect(h.sent[2]!.body).toEqual({ callback_query_id: "q1", text: "Refreshing…" });
    expect(h.sent[3]!.body).toEqual({ callback_query_id: "q2" });
    expect(h.sent[4]!.body).toEqual({ commands: [{ command: "todo", description: "d" }] });
  });
});

describe("retries and errors", () => {
  test("waits out a rate limit and tries again", async () => {
    const h = harness([json({ ok: false, description: "Too Many Requests", parameters: { retry_after: 3 } }, 429), okResult()]);
    await h.api.sendMessage({ chatId: 1, text: "x" });
    expect(h.sleeps).toEqual([3_250]);
    expect(h.calls()).toBe(2);
  });

  test("does not wait for a rate limit longer than a minute", async () => {
    const h = harness([json({ ok: false, description: "Too Many Requests", parameters: { retry_after: 600 } }, 429)]);
    await expect(h.api.sendMessage({ chatId: 1, text: "x" })).rejects.toThrow(/429 Too Many Requests/);
    expect(h.sleeps).toEqual([]);
  });

  test("retries server errors with a growing pause, then succeeds", async () => {
    const h = harness([
      json({ ok: false, description: "Bad Gateway" }, 502),
      json({ ok: false, description: "Bad Gateway" }, 502),
      okResult(),
    ]);
    await h.api.sendMessage({ chatId: 1, text: "x" });
    expect(h.sleeps).toEqual([1_000, 3_000]);
  });

  test("gives up after a few retries", async () => {
    const h = harness(Array.from({ length: 4 }, () => json({ ok: false, description: "Bad Gateway" }, 502)));
    await expect(h.api.sendMessage({ chatId: 1, text: "x" })).rejects.toMatchObject({ status: 502 });
    expect(h.calls()).toBe(4);
  });

  test("treats a non-JSON error page as a server error", async () => {
    const h = harness([new Response("<html>bad gateway</html>", { status: 502, statusText: "Bad Gateway" }), okResult()]);
    await h.api.sendMessage({ chatId: 1, text: "x" });
    expect(h.calls()).toBe(2);
  });

  test("does not retry a client error and reports its description and status", async () => {
    const h = harness([json({ ok: false, description: "Bad Request: chat not found" }, 400)]);
    const error = await h.api.sendMessage({ chatId: 1, text: "x" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TelegramError);
    expect(error).toMatchObject({ status: 400, message: "sendMessage: 400 Bad Request: chat not found" });
    expect(h.calls()).toBe(1);
  });

  test("retries network failures, then reports them without leaking the token", async () => {
    const boom = new Error(`fetch failed for https://api.telegram.org/bot${TOKEN}/sendMessage`);
    const h = harness([boom, boom, boom, boom]);
    const error = (await h.api.sendMessage({ chatId: 1, text: "x" }).catch((e: unknown) => e)) as TelegramError;
    expect(h.calls()).toBe(4);
    expect(error.message).toContain("network error");
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).toContain("<token>");
  });

  test("keeps the token out of API error descriptions too", async () => {
    const h = harness([json({ ok: false, description: `Unauthorized ${TOKEN}` }, 401)]);
    const error = (await h.api.getMe().catch((e: unknown) => e)) as TelegramError;
    expect(error.message).not.toContain(TOKEN);
  });

  test("stops at once when the run is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness([new Error("aborted by signal")], { signal: controller.signal });
    await expect(h.api.sendMessage({ chatId: 1, text: "x" })).rejects.toThrow("sendMessage: aborted");
    expect(h.calls()).toBe(1);
    expect(h.sleeps).toEqual([]);
  });
});
