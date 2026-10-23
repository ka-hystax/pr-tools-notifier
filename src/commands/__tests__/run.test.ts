import { describe, expect, test } from "vitest";
import { pollInterval } from "../run.js";

describe("pollInterval", () => {
  test("the --interval flag wins over the setting", () => {
    expect(pollInterval({ intervalMs: 120_000 }, { intervalMs: 300_000 })).toBe(120_000);
  });

  test("the setting wins over the default", () => {
    expect(pollInterval({}, { intervalMs: 300_000 })).toBe(300_000);
  });

  test("falls back to one minute", () => {
    expect(pollInterval({}, {})).toBe(60_000);
  });
});
