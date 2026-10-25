export const MIN_INTERVAL_MS = 60_000;
export const MAX_INTERVAL_MS = 12 * 3_600_000;
export const DEFAULT_INTERVAL_MS = MIN_INTERVAL_MS;

const UNITS: Record<string, number> = { "": 1_000, s: 1_000, m: 60_000, h: 3_600_000 };

export type IntervalResult = { ms: number } | { error: "format" | "min" | "max" };

// "90s", "5m", "1h" or plain seconds, from a minute to twelve hours.
export function readInterval(text: string): IntervalResult {
  const match = /^(\d+)([smh]?)$/.exec(text.trim());
  if (!match) return { error: "format" };
  const ms = Number(match[1]) * UNITS[match[2]!]!;
  if (ms < MIN_INTERVAL_MS) return { error: "min" };
  if (ms > MAX_INTERVAL_MS) return { error: "max" };
  return { ms };
}

// The choices the bot offers; any other value can still be typed into settings.env.
export const INTERVAL_PRESETS = ["1m", "5m", "15m", "30m", "1h", "4h", "12h"];

// 300000 → "5m", 5400000 → "90m", 90000 → "90s": the largest whole unit.
export function formatInterval(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
}
