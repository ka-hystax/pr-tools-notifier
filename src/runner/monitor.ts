import { escapeHtml } from "../format/format.js";
import type { TickResult } from "./types.js";

const ERROR_MAX = 300;

// One alert per outage: after enough failed ticks in a row, until a tick succeeds again.
export class FailureMonitor {
  private failures = 0;
  private since: Date | null = null;
  private lastError = "";
  private alerted = false;

  constructor(private readonly threshold = 3) {}

  record(result: TickResult, at: Date): void {
    if (result.ok) {
      this.failures = 0;
      this.since = null;
      this.lastError = "";
      this.alerted = false;
      return;
    }
    this.failures += 1;
    this.since ??= at;
    this.lastError = result.errors[0] ?? "unknown error";
  }

  pendingAlert(timeZone?: string): string | null {
    if (this.alerted || this.failures < this.threshold || this.since === null) return null;
    const time = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
      this.since
    );
    const error = this.lastError.length > ERROR_MAX ? `${this.lastError.slice(0, ERROR_MAX - 1)}…` : this.lastError;
    return (
      `⚠️ <b>Notifications are failing</b> since ${time} (${this.failures} attempts in a row)\n` +
      `<code>${escapeHtml(error)}</code>\n` +
      "Check <code>gh auth status</code> and the network."
    );
  }

  markAlerted(): void {
    this.alerted = true;
  }
}
