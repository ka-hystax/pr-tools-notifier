import { describe, expect, test } from "vitest";
import { isRateLimit, rateLimitText, RateLimitNotice, recommendInterval, type RateLimit } from "../rateLimit.js";
import type { Logger, Sink } from "../types.js";

const RESET = new Date("2026-10-13T15:01:00Z");
const limit: RateLimit = { resource: "graphql", limit: 5000, resetAt: RESET };
// So many minutes after the window started (an hour before the reset).
const into = (minutes: number) => new Date(RESET.getTime() - 3_600_000 + minutes * 60_000);
const m = (minutes: number) => minutes * 60_000;

describe("recommendInterval", () => {
  test.each([
    [1, 30, 2],
    [1, 45, 2],
    [1, 20, 3],
    [5, 50, 6],
    [1, 59, 2],
  ])("every %im, out after %i min: every %im", (interval, after, expected) => {
    expect(recommendInterval(m(interval), limit, into(after))).toBe(m(expected));
  });

  test("never more than twelve hours", () => {
    expect(recommendInterval(m(600), limit, into(5))).toBe(12 * 3_600_000);
  });
});

describe("rateLimitText", () => {
  test("says when it ran out, when polling resumes and what to set", () => {
    const text = rateLimitText(limit, into(31), m(1), { timeZone: "UTC" });
    expect(text).toContain("⚠️ <b>GitHub rate limit reached</b>, 31 min into the hour");
    expect(text).toContain("5000 GraphQL points an hour");
    expect(text).toContain("Polling resumes at 15:01.");
    expect(text).toContain("polling every <b>2m</b> instead of 1m");
    expect(text).toContain(
      "send it in /settings → ⏱ Interval, or run <code>pr-tools-notifier config set poll-interval 2m</code>"
    );
  });

  test("with --interval, says to restart with a longer one", () => {
    expect(rateLimitText(limit, into(30), m(1), { intervalFlag: true })).toContain("<code>--interval 2m</code>");
  });
});

describe("RateLimitNotice", () => {
  function harness(read: () => Promise<RateLimit | null>) {
    const alerts: string[] = [];
    const logs: string[] = [];
    let reads = 0;
    let failSend = false;
    const sink: Sink = {
      async deliver() {},
      async alert(html) {
        if (failSend) throw new Error("telegram down");
        alerts.push(html);
      },
    };
    const log: Logger = { info: () => {}, warn: (l) => logs.push(l), error: (l) => logs.push(l) };
    const notice = new RateLimitNotice({
      read: () => {
        reads += 1;
        return read();
      },
      sink,
      log,
      intervalMs: () => m(1),
      now: () => into(30),
    });
    return { notice, alerts, logs, reads: () => reads, failSend: (v: boolean) => (failSend = v) };
  }
  const limited = ["mine: exited with 1: GraphQL: API rate limit exceeded for user ID 1."];

  test("sends one notice per window, however many profiles run into it at once", async () => {
    const h = harness(async () => limit);
    expect(await Promise.all([h.notice.check(limited), h.notice.check(limited)])).toEqual([true, true]);
    expect(await h.notice.check(limited)).toBe(true);
    expect(h.alerts).toHaveLength(1);
    expect(h.logs).toContain("GitHub rate limit reached; suggested polling every 2m");
  });

  test("a new window gets its own notice", async () => {
    let resetAt = RESET;
    const h = harness(async () => ({ ...limit, resetAt }));
    await h.notice.check(limited);
    resetAt = new Date(RESET.getTime() + 3_600_000);
    await h.notice.check(limited);
    expect(h.alerts).toHaveLength(2);
  });

  test("leaves other errors, and a limit it cannot find, to the general alert", async () => {
    const h = harness(async () => null);
    expect(await h.notice.check(["mine: timed out after 120s"])).toBe(false);
    expect(h.reads()).toBe(0);
    expect(await h.notice.check(["todo: You have exceeded a secondary rate limit"])).toBe(false);
    expect(h.alerts).toEqual([]);
  });

  test("tries again when the notice could not be sent", async () => {
    const h = harness(async () => limit);
    h.failSend(true);
    expect(await h.notice.check(limited)).toBe(false);
    h.failSend(false);
    expect(await h.notice.check(limited)).toBe(true);
    expect(h.alerts).toHaveLength(1);
  });

  test("recognises gh's rate limit errors", () => {
    expect(isRateLimit("HTTP 403: API rate limit exceeded for user ID 1")).toBe(true);
    expect(isRateLimit("exited with 1: boom")).toBe(false);
  });
});
