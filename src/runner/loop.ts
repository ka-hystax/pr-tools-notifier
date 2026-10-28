import type { FailureMonitor } from "./monitor.js";
import { errorMessage, type Logger, type Sink, type TickResult } from "./types.js";

export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

export const sleep: Sleep = (ms, signal) =>
  new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });

// Setup mistakes rather than outages: when every error of the very first tick is one of these, the run ends.
const SETUP_ERRORS: [RegExp, string][] = [
  [/unknown profile/i, "stopping: that gh-pr-tools profile does not exist (see `gh pr-tools profile list`)"],
  [/unknown option '--json'/i, "stopping: this gh-pr-tools is too old, update it with `gh extension upgrade pr-tools`"],
  [
    /does not report Jira tickets/i,
    "stopping: this gh-pr-tools is too old for the Jira merge status, update it with `gh extension upgrade pr-tools`",
  ],
];

// Long pauses are slept in steps of at most this, so a changed interval applies within a step.
export const PAUSE_STEP_MS = 60_000;

export interface LoopDeps {
  tick: () => Promise<TickResult>;
  sink: Sink;
  monitor: FailureMonitor;
  log: Logger;
  // A function when the interval can change while running (settings are re-read).
  intervalMs: number | (() => number);
  once: boolean;
  signal: AbortSignal;
  now?: () => Date;
  sleep?: Sleep;
  timeZone?: string;
  // Polls track alone, so a track error is a setup mistake like any other.
  trackOnly?: boolean;
}

// Resolves to whether the last tick succeeded; a tick cut short by the abort signal is not counted.
export async function runLoop(deps: LoopDeps): Promise<boolean> {
  const { tick, sink, monitor, log, once, signal, timeZone, trackOnly = false } = deps;
  const interval = typeof deps.intervalMs === "function" ? deps.intervalMs : () => deps.intervalMs as number;
  const now = deps.now ?? (() => new Date());
  const wait = deps.sleep ?? sleep;
  let ok = true;
  let first = true;

  while (!signal.aborted) {
    let result: TickResult;
    try {
      result = await tick();
    } catch (err) {
      log.error(err instanceof Error && err.stack ? err.stack : errorMessage(err));
      result = { ok: false, errors: [errorMessage(err)], events: 0, messages: 0 };
    }
    if (signal.aborted) break;

    // Following other people's PRs is extra: a gh-pr-tools too old for it must not stop mine and todo.
    const errors = trackOnly ? result.errors : result.errors.filter((e) => !e.startsWith("track: "));
    const setup =
      first && errors.length > 0 ? SETUP_ERRORS.find(([pattern]) => errors.every((e) => pattern.test(e))) : undefined;
    if (setup) {
      log.error(setup[1]);
      return false;
    }
    first = false;

    ok = result.ok;
    monitor.record(result, now());
    const alert = monitor.pendingAlert(timeZone);
    if (alert) {
      try {
        await sink.alert(alert);
        monitor.markAlerted();
        log.warn("sent a failure alert");
      } catch (err) {
        log.error(`could not send the failure alert: ${errorMessage(err)}`);
      }
    }

    if (once) break;
    for (let slept = 0; !signal.aborted && slept < interval(); ) {
      const step = Math.min(interval() - slept, PAUSE_STEP_MS);
      await wait(step, signal);
      slept += step;
    }
  }
  return ok;
}
