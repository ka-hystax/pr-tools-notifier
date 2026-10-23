import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../utils/fs.js";
import { readInterval } from "./interval.js";

export class SettingsError extends Error {}

export interface Settings {
  mergeStatuses?: string[];
  intervalMs?: number;
}

export const SETTING_KEYS = ["MERGE_STATUS", "POLL_INTERVAL"] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.*?)\s*$/;
const HEADER = "# pr-tools-notifier settings: KEY=value, one per line\n";

// "merge-status", "Merge_Status" and "MERGE_STATUS" are the same key.
export function settingKey(text: string): SettingKey | null {
  const key = text.trim().toUpperCase().replace(/-/g, "_");
  return (SETTING_KEYS as readonly string[]).includes(key) ? (key as SettingKey) : null;
}

function lineKey(line: string): SettingKey | null {
  const match = LINE.exec(line);
  return match && !line.trim().startsWith("#") ? settingKey(match[1]!) : null;
}

function unquote(value: string): string {
  const quote = value[0];
  return value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote) ? value.slice(1, -1) : value;
}

export function splitStatuses(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "")
    ),
  ];
}

// The normalized text to store for a value, or the reason it is not acceptable.
function check(key: SettingKey, value: string): { value: string } | { problem: string } {
  if (value.trim() === "") return { value: "" };
  if (key === "MERGE_STATUS") return { value: splitStatuses(value).join(",") };
  const result = readInterval(value);
  if ("ms" in result) return { value: value.trim() };
  return {
    problem: { format: "use e.g. 90s, 5m or 1h", min: "must be at least 1m", max: "must be at most 12h" }[result.error],
  };
}

export function describeSetting(key: SettingKey): string {
  return key === "MERGE_STATUS"
    ? 'Jira statuses that mean "time to merge", comma-separated'
    : "time between polls: 90s, 5m, 1h (from 1m to 12h)";
}

// One KEY=value per line, # comments. Typos are errors rather than silently ignored settings.
export class SettingsStore {
  readonly path: string;

  constructor(readonly dir: string) {
    this.path = join(dir, "settings.env");
  }

  exists(): boolean {
    return existsSync(this.path);
  }

  private lines(): string[] {
    return this.exists() ? readFileSync(this.path, "utf8").split("\n") : [];
  }

  // Empty values count as unset.
  values(): Partial<Record<SettingKey, string>> {
    const values: Partial<Record<SettingKey, string>> = {};
    this.lines().forEach((raw, i) => {
      if (raw.trim() === "" || raw.trim().startsWith("#")) return;
      const where = `${this.path}:${i + 1}`;
      const match = LINE.exec(raw);
      if (!match) throw new SettingsError(`${where}: expected KEY=value`);
      const key = settingKey(match[1]!);
      if (!key) {
        throw new SettingsError(`${where}: unknown setting '${match[1]}' (known: ${SETTING_KEYS.join(", ")})`);
      }
      const checked = check(key, unquote(match[2]!));
      if ("problem" in checked) throw new SettingsError(`${where}: ${key} ${checked.problem}`);
      if (checked.value !== "") values[key] = checked.value;
    });
    return values;
  }

  load(): Settings {
    const { MERGE_STATUS, POLL_INTERVAL } = this.values();
    const settings: Settings = {};
    if (MERGE_STATUS) settings.mergeStatuses = splitStatuses(MERGE_STATUS);
    if (POLL_INTERVAL) {
      const result = readInterval(POLL_INTERVAL);
      if ("ms" in result) settings.intervalMs = result.ms;
    }
    return settings;
  }

  // Changes the one line and leaves comments and everything else as they are.
  set(key: SettingKey, value: string): string {
    const checked = check(key, value);
    if ("problem" in checked) throw new SettingsError(`${key} ${checked.problem}`);
    if (checked.value === "") {
      this.unset(key);
      return "";
    }
    const lines = this.lines();
    const index = lines.findIndex((l) => lineKey(l) === key);
    const line = `${key}=${checked.value}`;
    if (index >= 0) lines[index] = line;
    else if (lines.length === 0) lines.push(HEADER.trimEnd(), line);
    else lines.splice(lines.at(-1) === "" ? lines.length - 1 : lines.length, 0, line);
    this.write(lines);
    return checked.value;
  }

  unset(key: SettingKey): boolean {
    const lines = this.lines();
    const kept = lines.filter((l) => lineKey(l) !== key);
    if (kept.length === lines.length) return false;
    this.write(kept);
    return true;
  }

  private write(lines: string[]): void {
    const text = lines.join("\n");
    writeFileAtomic(this.path, text.endsWith("\n") ? text : `${text}\n`);
  }
}
