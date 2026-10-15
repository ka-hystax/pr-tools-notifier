import { readFileSync } from "node:fs";

// package.json sits two levels above both src/cli and dist/cli, and ships in the package.
export function readVersion(packageUrl: URL = new URL("../../package.json", import.meta.url)): string {
  const { version } = JSON.parse(readFileSync(packageUrl, "utf8")) as { version?: unknown };
  if (typeof version !== "string") throw new Error("package.json has no version");
  return version;
}
