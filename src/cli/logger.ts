import type { Logger } from "../runner/types.js";

export function createLogger(): Logger {
  const line = (level: string, message: string) => {
    const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
    process.stderr.write(`${time} ${level}${message}\n`);
  };
  return { info: (m) => line("", m), warn: (m) => line("warn: ", m), error: (m) => line("error: ", m) };
}

// Each line names its profile, for a run that polls several.
export function prefixed(log: Logger, prefix: string): Logger {
  return {
    info: (m) => log.info(`${prefix}: ${m}`),
    warn: (m) => log.warn(`${prefix}: ${m}`),
    error: (m) => log.error(`${prefix}: ${m}`),
  };
}
