import { describe, expect, test } from "vitest";
import { TelegramError } from "../../telegram/api.js";
import { checkBot } from "../sinks.js";

const failing = (err: Error) => ({
  getMe: async () => {
    throw err;
  },
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
