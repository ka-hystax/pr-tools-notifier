import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { readVersion } from "../version.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "prn-version-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readVersion", () => {
  test("reads the version of this package", () => {
    expect(readVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("reads the version field of the given package.json", () => {
    const path = join(dir, "package.json");
    writeFileSync(path, JSON.stringify({ name: "x", version: "1.2.3" }));
    expect(readVersion(pathToFileURL(path))).toBe("1.2.3");
  });

  test("rejects a package.json without a version", () => {
    const path = join(dir, "package.json");
    writeFileSync(path, JSON.stringify({ name: "x" }));
    expect(() => readVersion(pathToFileURL(path))).toThrow(/no version/);
  });
});
