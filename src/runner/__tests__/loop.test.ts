import { describe, expect, test } from "vitest";
import { runLoop, sleep, type LoopDeps } from "../loop.js";
import { FailureMonitor } from "../monitor.js";
import type { Logger, Sink, TickResult } from "../types.js";

const ok: TickResult = { ok: true, errors: [], events: 0, messages: 0 };
const bad: TickResult = { ok: false, errors: ["mine: boom"], events: 0, messages: 0 };
const log: Logger = { info() {}, warn() {}, error() {} };

// Plays the given results in order; the tick after the last one aborts the loop and is not counted.
function harness(results: (TickResult | Error)[], over: Partial<LoopDeps> = {}) {
  const controller = new AbortController();
  const alerts: string[] = [];
  const sleeps: number[] = [];
  let ticks = 0;
  let alertFailures = 0;
  const sink: Sink = {
    async deliver() {},
    async alert(html) {
      if (alertFailures > 0) {
        alertFailures -= 1;
        throw new Error("telegram down");
      }
      alerts.push(html);
    },
  };
  const deps: LoopDeps = {
    tick: async () => {
      const next = results[ticks++];
      if (next === undefined) {
        controller.abort();
        return ok;
      }
      if (next instanceof Error) throw next;
      return next;
    },
    sink,
    monitor: new FailureMonitor(3),
    log,
    intervalMs: 300_000,
    once: false,
    signal: controller.signal,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    timeZone: "UTC",
    ...over,
  };
  return { deps, alerts, sleeps, controller, ticks: () => ticks, failAlerts: (n: number) => (alertFailures = n) };
}

describe("runLoop", () => {
  const unknown: TickResult = {
    ok: false,
    errors: ["mine: exited with 1: gh pr-tools: unknown profile 'x'", "todo: exited with 1: gh pr-tools: unknown profile 'x'"],
    events: 0,
    messages: 0,
  };

  test("stops at once when the profile does not exist on the first tick", async () => {
    const h = harness([unknown, ok]);
    expect(await runLoop(h.deps)).toBe(false);
    expect(h.ticks()).toBe(1);
    expect(h.sleeps).toEqual([]);
  });

  test("stops at once when gh-pr-tools is too old for --json on the first tick", async () => {
    const old: TickResult = {
      ok: false,
      errors: [
        "mine: exited with 1: gh pr-tools mine: unknown option '--json' (supported: --long)",
        "todo: exited with 1: gh pr-tools todo: unknown option '--json'",
      ],
      events: 0,
      messages: 0,
    };
    const lines: string[] = [];
    const h = harness([old, ok], { log: { ...log, error: (m) => void lines.push(m) } });
    expect(await runLoop(h.deps)).toBe(false);
    expect(h.ticks()).toBe(1);
    expect(lines).toEqual(["stopping: this gh-pr-tools is too old, update it with `gh extension upgrade pr-tools`"]);
  });

  test("keeps going when the first-tick errors name different setup problems", async () => {
    const mixed: TickResult = {
      ...unknown,
      errors: [unknown.errors[0]!, "todo: exited with 1: gh pr-tools todo: unknown option '--json'"],
    };
    const h = harness([mixed]);
    await runLoop(h.deps);
    expect(h.ticks()).toBe(2);
  });

  test("keeps going when the profile disappears after a good tick", async () => {
    const h = harness([ok, unknown, unknown]);
    await runLoop(h.deps);
    expect(h.ticks()).toBe(4);
  });

  test("keeps going when only some first-tick errors name the profile", async () => {
    const mixed: TickResult = { ...unknown, errors: [unknown.errors[0]!, "todo: timed out after 120s"] };
    const h = harness([mixed]);
    await runLoop(h.deps);
    expect(h.ticks()).toBe(2);
  });

  test("runs one tick and returns its outcome with --once", async () => {
    const h = harness([bad], { once: true });
    expect(await runLoop(h.deps)).toBe(false);
    expect(h.ticks()).toBe(1);
    expect(h.sleeps).toEqual([]);
  });

  test("ticks, then sleeps for the interval, until aborted", async () => {
    const h = harness([ok, ok, ok]);
    expect(await runLoop(h.deps)).toBe(true);
    expect(h.ticks()).toBe(4);
    expect(h.sleeps).toEqual([300_000, 300_000, 300_000]);
  });

  test("reports the outcome of the last completed tick", async () => {
    expect(await runLoop(harness([ok, bad]).deps)).toBe(false);
  });

  test("does not count a tick that was cut short by the abort signal", async () => {
    const h = harness([]);
    let n = 0;
    h.deps.tick = async () => {
      n += 1;
      if (n === 3) h.controller.abort();
      return bad;
    };
    await runLoop(h.deps);
    expect(n).toBe(3);
    expect(h.alerts).toEqual([]);
  });

  test("sends one alert after three failed ticks in a row, and a later outage gets its own", async () => {
    const h = harness([bad, bad, bad, bad, ok, bad, bad, bad]);
    await runLoop(h.deps);
    expect(h.alerts).toHaveLength(2);
    expect(h.alerts[0]).toContain("3 attempts in a row");
  });

  test("retries an alert that could not be sent", async () => {
    const h = harness([bad, bad, bad, bad]);
    h.failAlerts(1);
    await runLoop(h.deps);
    expect(h.alerts).toHaveLength(1);
  });

  test("survives a tick that throws and counts it as a failure", async () => {
    const h = harness([new Error("bug"), new Error("bug"), new Error("bug"), ok]);
    expect(await runLoop(h.deps)).toBe(true);
    expect(h.ticks()).toBe(5);
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]).toContain("bug");
  });
});

describe("sleep", () => {
  test("resolves early when aborted", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = sleep(60_000, controller.signal);
    controller.abort();
    await pending;
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("waits for the delay otherwise", async () => {
    const started = Date.now();
    await sleep(20, new AbortController().signal);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });
});
