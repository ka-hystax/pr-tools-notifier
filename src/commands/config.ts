import { DEFAULT_INTERVAL_MS } from "../config/interval.js";
import {
  describeSetting,
  SETTING_KEYS,
  settingKey,
  SettingsError,
  splitStatuses,
  type SettingKey,
  type SettingsStore,
} from "../config/settings.js";

export type ConfigAction = { type: "show" } | { type: "set"; key: string; value: string } | { type: "unset"; key: string };

const NAMES = SETTING_KEYS.map((k) => k.toLowerCase().replace(/_/g, "-")).join(", ");

function shownValue(key: SettingKey, value: string | undefined): string {
  if (!value) return key === "POLL_INTERVAL" ? `${DEFAULT_INTERVAL_MS / 60_000}m (default)` : "not set";
  return key === "MERGE_STATUS" ? splitStatuses(value).join(", ") : value;
}

function show(store: SettingsStore, out: (line: string) => void): boolean {
  const values = store.values();
  out(`Settings file: ${store.path}${store.exists() ? "" : " (not created yet)"}`);
  const shown = SETTING_KEYS.map((key) => shownValue(key, values[key]));
  const width = Math.max(...shown.map((v) => v.length));
  SETTING_KEYS.forEach((key, i) => out(`  ${key.padEnd(13)} ${shown[i]!.padEnd(width)}  ${describeSetting(key)}`));
  return true;
}

// Resolves to whether the action went through; failures are explained on `out`.
export function runConfig(store: SettingsStore, action: ConfigAction, out: (line: string) => void): boolean {
  try {
    if (action.type === "show") return show(store, out);

    const key: SettingKey | null = settingKey(action.key);
    if (!key) {
      out(`Unknown setting '${action.key}' (known: ${NAMES}).`);
      return false;
    }
    if (action.type === "unset") {
      out(store.unset(key) ? `${key} removed. Restart \`pr-tools-notifier run\` to apply it.` : `${key} was not set.`);
      return true;
    }
    const stored = store.set(key, action.value);
    out(
      stored === ""
        ? `${key} removed.`
        : `${key}=${stored} saved in ${store.path}. Restart \`pr-tools-notifier run\` to apply it.`
    );
    return true;
  } catch (err) {
    if (!(err instanceof SettingsError)) throw err;
    out(err.message);
    return false;
  }
}
