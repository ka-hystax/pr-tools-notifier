import { computeEvents, type Baseline, type NotifyEvent } from "../diff/diff.js";
import { formatEvents, type FormatOptions, type OutMessage } from "../format/format.js";
import type { StateStore } from "../state/store.js";
import { errorMessage, type Command, type Logger, type Sink, type SnapshotSource, type TickResult } from "./types.js";

export interface TickDeps {
  commands: Command[];
  source: SnapshotSource;
  stores: Record<Command, StateStore>;
  sink: Sink;
  log: Logger;
  timeZone?: string;
}

// Baselines move only after the messages were delivered, so a failed tick repeats the same events.
export async function runTick({ commands, source, stores, sink, log, timeZone }: TickDeps): Promise<TickResult> {
  const errors: string[] = [];
  const events: NotifyEvent[] = [];
  const commits: { command: Command; store: StateStore; next: Baseline }[] = [];
  let previousAt: string | undefined;
  let now: string | undefined;

  for (const command of commands) {
    try {
      const curr = await source(command);
      const store = stores[command];
      const { baseline, reset } = store.load();
      if (reset) log.warn(`${command}: ${reset}`);
      const result = computeEvents(baseline, curr);
      log.info(
        baseline === null
          ? `${command}: first run, saved ${curr.prs.length} PRs as the baseline`
          : `${command}: ${curr.prs.length} PRs, ${result.events.length} new events`
      );
      events.push(...result.events);
      commits.push({ command, store, next: result.next });
      if (baseline && (previousAt === undefined || baseline.snapshot.generatedAt < previousAt)) {
        previousAt = baseline.snapshot.generatedAt;
      }
      if (now === undefined || curr.generatedAt > now) now = curr.generatedAt;
    } catch (err) {
      const message = `${command}: ${errorMessage(err)}`;
      errors.push(message);
      log.error(message);
    }
  }

  let messages: OutMessage[] = [];
  if (events.length > 0) {
    const options: FormatOptions = {};
    if (previousAt) options.previousAt = previousAt;
    if (now) options.now = now;
    if (timeZone) options.timeZone = timeZone;
    messages = formatEvents(events, options);
    try {
      await sink.deliver(messages);
    } catch (err) {
      const message = `delivery: ${errorMessage(err)}`;
      log.error(message);
      return { ok: false, errors: [...errors, message], events: events.length, messages: messages.length };
    }
  }

  for (const { command, store, next } of commits) {
    try {
      store.save(next);
    } catch (err) {
      const message = `${command}: could not save state: ${errorMessage(err)}`;
      errors.push(message);
      log.error(message);
    }
  }
  return { ok: errors.length === 0, errors, events: events.length, messages: messages.length };
}
