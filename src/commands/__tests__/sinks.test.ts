import { describe, expect, test } from "vitest";
import { TelegramError } from "../../telegram/api.js";
import type { OutMessage } from "../../format/format.js";
import type { Sink } from "../../runner/types.js";
import { checkBot, serialSink } from "../sinks.js";

const failing = (err: Error) => ({
  getMe: async () => {
    throw err;
  },
});

describe("serialSink", () => {
  test("delivers one batch at a time, in the order asked, and a failure does not block the next", async () => {
    const log: string[] = [];
    const slow: Sink = {
      async deliver(messages) {
        log.push(`start ${messages[0]!.text}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (messages[0]!.text === "b") throw new Error("down");
        log.push(`end ${messages[0]!.text}`);
      },
      async alert(html) {
        log.push(`alert ${html}`);
      },
    };
    const sink = serialSink(slow);
    const batch = (text: string): OutMessage[] => [{ text, buttons: [], silent: false }];
    const results = await Promise.allSettled([sink.deliver(batch("a")), sink.deliver(batch("b")), sink.alert("c")]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect(log).toEqual(["start a", "end a", "start b", "alert c"]);
  });
});

describe("checkBot", () => {
  test("accepts a working bot", async () => {
    expect(await checkBot({ getMe: async () => ({ username: "x_bot" }) })).toEqual({ status: "ok" });
  });

  test.each([401, 404])("rejects a token Telegram refuses (%i) and says what to do", async (status) => {
    const result = await checkBot(failing(new TelegramError(`getMe: ${status} Unauthorized`, status)));
    expect(result).toMatchObject({ status: "rejected" });
    expect(result).toMatchObject({ problem: expect.stringContaining(`getMe: ${status} Unauthorized`) });
    expect(result).toMatchObject({ problem: expect.stringContaining("pr-tools-notifier init") });
  });

  test("calls network and server failures unreachable", async () => {
    expect(await checkBot(failing(new TelegramError("getMe: network error", null)))).toEqual({
      status: "unreachable",
      problem: "getMe: network error",
    });
    expect(await checkBot(failing(new TelegramError("getMe: 502 Bad Gateway", 502)))).toMatchObject({ status: "unreachable" });
    expect(await checkBot(failing(new Error("boom")))).toEqual({ status: "unreachable", problem: "boom" });
  });
});
