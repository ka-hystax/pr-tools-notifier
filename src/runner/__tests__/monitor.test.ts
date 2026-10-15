import { describe, expect, test } from "vitest";
import { FailureMonitor } from "../monitor.js";
import type { TickResult } from "../types.js";

const ok: TickResult = { ok: true, errors: [], events: 0, messages: 0 };
const bad = (error = "mine: boom"): TickResult => ({ ok: false, errors: [error], events: 0, messages: 0 });
const at = (time: string) => new Date(`2026-10-13T${time}:00Z`);

describe("FailureMonitor", () => {
  test("stays quiet below the threshold", () => {
    const monitor = new FailureMonitor(3);
    monitor.record(bad(), at("10:00"));
    monitor.record(bad(), at("10:05"));
    expect(monitor.pendingAlert("UTC")).toBeNull();
  });

  test("alerts once the threshold is reached, with the first failure time and the last error", () => {
    const monitor = new FailureMonitor(3);
    monitor.record(bad("mine: first"), at("10:00"));
    monitor.record(bad("mine: second"), at("10:05"));
    monitor.record(bad("todo: <third> & last"), at("10:10"));
    const alert = monitor.pendingAlert("UTC")!;
    expect(alert).toContain("since 10:00");
    expect(alert).toContain("3 attempts in a row");
    expect(alert).toContain("<code>todo: &lt;third&gt; &amp; last</code>");
    expect(alert).toContain("gh auth status");
  });

  test.each([
    ["mine: exited with 1: gh pr-tools: unknown profile 'work' — run: gh pr-tools profile list", "gh pr-tools profile list"],
    ["mine: gh was not found in PATH", "add it to PATH"],
    ["todo: exited with 1: To authenticate, run: gh auth login", "gh auth status"],
    ["mine: exited with 1: HTTP 401: Bad credentials", "gh auth status"],
    ["delivery: sendMessage: 401 Unauthorized (the bot token no longer works: run `pr-tools-notifier init`)", "network"],
    ["mine: timed out after 120s", "network"],
  ])("picks the hint for %j", (error, hint) => {
    const monitor = new FailureMonitor(1);
    monitor.record(bad(error), at("10:00"));
    expect(monitor.pendingAlert("UTC")).toContain(hint);
  });

  test("alerts only once per outage, and again after a recovery", () => {
    const monitor = new FailureMonitor(2);
    monitor.record(bad(), at("10:00"));
    monitor.record(bad(), at("10:05"));
    expect(monitor.pendingAlert("UTC")).not.toBeNull();
    monitor.markAlerted();
    monitor.record(bad(), at("10:10"));
    expect(monitor.pendingAlert("UTC")).toBeNull();

    monitor.record(ok, at("10:15"));
    monitor.record(bad(), at("10:20"));
    expect(monitor.pendingAlert("UTC")).toBeNull();
    monitor.record(bad(), at("10:25"));
    expect(monitor.pendingAlert("UTC")).toContain("since 10:20");
  });

  test("keeps offering the alert until it has been marked as sent", () => {
    const monitor = new FailureMonitor(1);
    monitor.record(bad(), at("10:00"));
    expect(monitor.pendingAlert("UTC")).not.toBeNull();
    expect(monitor.pendingAlert("UTC")).not.toBeNull();
  });

  test("clips a very long error", () => {
    const monitor = new FailureMonitor(1);
    monitor.record(bad("x".repeat(1000)), at("10:00"));
    expect(monitor.pendingAlert("UTC")!.length).toBeLessThan(500);
  });

  test("a successful tick clears the count", () => {
    const monitor = new FailureMonitor(2);
    monitor.record(bad(), at("10:00"));
    monitor.record(ok, at("10:05"));
    monitor.record(bad(), at("10:10"));
    expect(monitor.pendingAlert("UTC")).toBeNull();
  });
});
