import type { Logger } from "../runner/types.js";

export function createLogger(): Logger {
  const line = (level: string, message: string) => {
    const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
    process.stderr.write(`${time} ${level}${message}\n`);
  };
  return { info: (m) => line("", m), warn: (m) => line("warn: ", m), error: (m) => line("error: ", m) };
}
