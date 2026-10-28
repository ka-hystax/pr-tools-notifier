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

  test("names the profile, for a run that polls several", () => {
    const monitor = new FailureMonitor(1, "other");
    monitor.record(bad(), at("10:00"));
    expect(monitor.pendingAlert("UTC")).toMatch(/^⚠️ <b>Notifications are failing<\/b> for <b>other<\/b> since 10:00/);
  });

  test("explains a failure it recognises instead of printing the raw error", () => {
    const monitor = new FailureMonitor(1);
    monitor.record(
      bad("todo: exited with 1: read tcp 192.0.2.10:54321->203.0.113.5:443: read: connection reset by peer"),
      at("10:00")
    );
    const alert = monitor.pendingAlert("UTC")!;
    expect(alert).toContain("Cannot reach GitHub.");
    expect(alert).toContain("githubstatus.com");
    expect(alert).not.toContain("192.0.2.10");
    expect(alert).not.toContain("gh auth status");
  });

  test("shows the raw error with the generic hint for anything else", () => {
    const monitor = new FailureMonitor(1);
    monitor.record(bad("mine: something odd"), at("10:00"));
    const alert = monitor.pendingAlert("UTC")!;
    expect(alert).toContain("<code>mine: something odd</code>");
    expect(alert).toContain("gh auth status");
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
