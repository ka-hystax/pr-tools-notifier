import { formatInterval, MAX_INTERVAL_MS } from "../config/interval.js";
import { errorMessage, type Logger, type Sink } from "./types.js";

const WINDOW_MS = 3_600_000;

// An hourly GitHub limit that ran out, and when its window starts over.
export interface RateLimit {
  resource: "graphql" | "core";
  limit: number;
  resetAt: Date;
}

export function isRateLimit(error: string): boolean {
  return /rate limit/i.test(error);
}

// The interval that would have lasted the hour at the pace that used it up: twice the current one if it ran out halfway.
export function recommendInterval(intervalMs: number, limit: RateLimit, hitAt: Date): number {
  const elapsed = Math.max(hitAt.getTime() - (limit.resetAt.getTime() - WINDOW_MS), 60_000);
  const minutes = Math.ceil((intervalMs * WINDOW_MS) / elapsed / 60_000);
  return Math.min(Math.max(minutes * 60_000, intervalMs + 60_000), MAX_INTERVAL_MS);
}

function clock(date: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
}

export function rateLimitText(
  limit: RateLimit,
  hitAt: Date,
  intervalMs: number,
  { intervalFlag = false, timeZone }: { intervalFlag?: boolean; timeZone?: string } = {}
): string {
  const next = formatInterval(recommendInterval(intervalMs, limit, hitAt));
  const minutes = Math.max(1, Math.round((hitAt.getTime() - (limit.resetAt.getTime() - WINDOW_MS)) / 60_000));
  const unit = limit.resource === "graphql" ? "GraphQL points" : "requests";
  const how = intervalFlag
    ? `restart <code>run</code> with <code>--interval ${next}</code>, which overrides POLL_INTERVAL`
    : `send it in /settings → ⏱ Interval, or run <code>pr-tools-notifier config set poll-interval ${next}</code>`;
  return [
    `⚠️ <b>GitHub rate limit reached</b>, ${minutes} min into the hour`,
    `Your <code>gh</code> login gets ${limit.limit} ${unit} an hour, shared by every profile, gh-pr-tools tables and anything else using it. Polling resumes at ${clock(limit.resetAt, timeZone)}.`,
    `At this pace, polling every <b>${next}</b> instead of ${formatInterval(intervalMs)} would last the hour: ${how}.`,
  ].join("\n");
}

export interface RateLimitNoticeDeps {
  read: () => Promise<RateLimit | null>;
  sink: Sink;
  log: Logger;
  intervalMs: () => number;
  // `run --interval` wins over the setting, so the advice is a restart.
  intervalFlag?: boolean;
  now?: () => Date;
  timeZone?: string;
}

// One message per exhausted window, however many profiles run into it.
export class RateLimitNotice {
  private notified: number | null = null;
  private pending: Promise<boolean> | null = null;

  constructor(private readonly deps: RateLimitNoticeDeps) {}

  // Whether a notice covers these errors, sent now or earlier in the same window.
  check(errors: string[]): Promise<boolean> {
    if (!errors.some(isRateLimit)) return Promise.resolve(false);
    this.pending ??= this.send().finally(() => (this.pending = null));
    return this.pending;
  }

  private async send(): Promise<boolean> {
    const { read, sink, log, intervalMs, intervalFlag, timeZone } = this.deps;
    let limit: RateLimit | null;
    try {
      limit = await read();
    } catch (err) {
      log.warn(`could not read the GitHub rate limit: ${errorMessage(err)}`);
      return false;
    }
    if (!limit) return false;
    if (this.notified === limit.resetAt.getTime()) return true;
    const now = this.deps.now?.() ?? new Date();
    try {
      await sink.alert(
        rateLimitText(limit, now, intervalMs(), { intervalFlag: intervalFlag ?? false, ...(timeZone ? { timeZone } : {}) })
      );
    } catch (err) {
      log.error(`could not send the rate limit notice: ${errorMessage(err)}`);
      return false;
    }
    this.notified = limit.resetAt.getTime();
    log.warn(
      `GitHub rate limit reached; suggested polling every ${formatInterval(recommendInterval(intervalMs(), limit, now))}`
    );
    return true;
  }
}
