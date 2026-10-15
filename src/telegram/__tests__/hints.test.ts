import { describe, expect, test } from "vitest";
import { TelegramError } from "../api.js";
import { botHint } from "../hints.js";

describe("botHint", () => {
  test.each([401, 404])("says the token is dead for %i", (status) => {
    expect(botHint(new TelegramError("x", status))).toMatch(/token no longer works.*init/);
  });

  test("says to unblock the bot for 403", () => {
    expect(botHint(new TelegramError("x", 403))).toMatch(/unblock/);
  });

  test("stays silent for transient and foreign errors", () => {
    expect(botHint(new TelegramError("x", 502))).toBeNull();
    expect(botHint(new TelegramError("x", null))).toBeNull();
    expect(botHint(new Error("x"))).toBeNull();
  });
});
