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

export interface LoopDeps {
  tick: () => Promise<TickResult>;
  sink: Sink;
  monitor: FailureMonitor;
  log: Logger;
  intervalMs: number;
  once: boolean;
  signal: AbortSignal;
  now?: () => Date;
  sleep?: Sleep;
  timeZone?: string;
}

// Resolves to whether the last tick succeeded; a tick cut short by the abort signal is not counted.
export async function runLoop(deps: LoopDeps): Promise<boolean> {
  const { tick, sink, monitor, log, intervalMs, once, signal, timeZone } = deps;
  const now = deps.now ?? (() => new Date());
  const wait = deps.sleep ?? sleep;
  let ok = true;

  while (!signal.aborted) {
    let result: TickResult;
    try {
      result = await tick();
    } catch (err) {
      log.error(err instanceof Error && err.stack ? err.stack : errorMessage(err));
      result = { ok: false, errors: [errorMessage(err)], events: 0, messages: 0 };
    }
    if (signal.aborted) break;

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
    await wait(intervalMs, signal);
  }
  return ok;
}
