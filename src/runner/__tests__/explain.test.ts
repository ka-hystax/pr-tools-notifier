import { describe, expect, test } from "vitest";
import { explainFailure } from "../explain.js";

const summaryOf = (error: string) => explainFailure(error)?.summary;

describe("explainFailure", () => {
  test.each([
    "mine: exited with 1: error connecting to api.github.com | check your internet connection or https://githubstatus.com",
    "todo: exited with 1: check your internet connection or https://githubstatus.com | error connecting to api.github.com | check your internet connection or https://githubstatus.com",
    "todo: exited with 1: read tcp 192.0.2.10:54321->203.0.113.5:443: read: connection reset by peer",
    "mine: exited with 1: dial tcp: lookup api.github.com: no such host",
  ])("calls %j a connection problem", (error) => {
    expect(summaryOf(error)).toBe("Cannot reach GitHub.");
  });

  test("names the time a request waited", () => {
    expect(summaryOf("mine: timed out after 120s")).toBe("GitHub did not answer within 120 s.");
  });

  test("names a missing profile and escapes it", () => {
    const explained = explainFailure(
      "mine: exited with 1: gh pr-tools: unknown profile '<x>' — run: gh pr-tools profile list"
    )!;
    expect(explained.summary).toBe("The gh-pr-tools profile <b>&lt;x&gt;</b> does not exist.");
    expect(explained.hint).toContain("gh pr-tools profile list");
  });

  test.each([
    ["mine: gh was not found in PATH", "The <code>gh</code> command was not found."],
    ["todo: exited with 1: To authenticate, run: gh auth login", "GitHub did not accept the <code>gh</code> login."],
    ["mine: exited with 1: HTTP 401: Bad credentials", "GitHub did not accept the <code>gh</code> login."],
    ["mine: exited with 1: HTTP 403: API rate limit exceeded for user ID 1", "GitHub API rate limit reached."],
    ["mine: exited with 1: HTTP 502: Bad Gateway", "GitHub returned an error (HTTP 502)."],
    [
      "mine: exited with 1: gh pr-tools mine: unknown option '--json' (supported: --long, --short-links, --short-labels, --include-drafts, --include-assigned, --watch[=INTERVAL])",
      "This gh-pr-tools is too old: it does not know <code>--json</code>.",
    ],
    ["mine: output is not valid JSON", "gh-pr-tools returned data the notifier cannot read."],
    [
      "mine: gh-pr-tools does not report Jira tickets (needed for MERGE_STATUS)",
      "This gh-pr-tools is too old: it does not report Jira tickets.",
    ],
  ])("explains %j", (error, summary) => {
    expect(summaryOf(error)).toBe(summary);
  });

  test("a rate limit is not mistaken for a login problem or a server error", () => {
    expect(summaryOf("HTTP 403: API rate limit exceeded")).toBe("GitHub API rate limit reached.");
  });

  test.each([
    [
      "delivery: sendMessage: 401 Unauthorized (the bot token no longer works: run `pr-tools-notifier init`)",
      "Telegram rejected the bot token.",
    ],
    ["delivery: sendMessage: 404 Not Found", "Telegram rejected the bot token."],
    ["delivery: sendMessage: 403 Forbidden: bot was blocked by the user", "Telegram says the bot cannot message you."],
    ["delivery: sendMessage: 429 Too Many Requests", "Telegram is rate-limiting the bot."],
    ["delivery: sendMessage: network error: fetch failed", "Could not send messages to Telegram."],
  ])("explains the delivery failure %j", (error, summary) => {
    expect(summaryOf(error)).toBe(summary);
  });

  test("leaves everything else alone", () => {
    expect(explainFailure("mine: something odd")).toBeNull();
    expect(explainFailure("")).toBeNull();
  });
});
