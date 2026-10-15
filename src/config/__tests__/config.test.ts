import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ConfigError, ConfigStore, decrypt, encrypt, type TelegramConfig } from "../config.js";

let root: string;
let dir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "prn-config-"));
  dir = join(root, "cfg");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const TOKEN = "123456:SECRET-token_value";
const config: TelegramConfig = { botUsername: "my_pr_bot", chatId: "42", token: TOKEN };

describe("encrypt / decrypt", () => {
  test("round-trips and uses a fresh iv every time", () => {
    const key = randomBytes(32);
    const a = encrypt(key, "hello");
    const b = encrypt(key, "hello");
    expect(decrypt(key, a)).toBe("hello");
    expect(a.iv).not.toBe(b.iv);
    expect(a.data).not.toBe(b.data);
  });

  test("refuses a wrong key or tampered data", () => {
    const key = randomBytes(32);
    const value = encrypt(key, "hello");
    expect(() => decrypt(randomBytes(32), value)).toThrow();
    const flipped = Buffer.from(value.data, "base64");
    flipped[0] = flipped[0]! ^ 1;
    expect(() => decrypt(key, { ...value, data: flipped.toString("base64") })).toThrow();
  });
});

describe("ConfigStore", () => {
  test("has nothing before the first save", () => {
    const store = new ConfigStore(dir);
    expect(store.exists()).toBe(false);
    expect(store.load()).toBeNull();
  });

  test("saves and loads the configuration", () => {
    const store = new ConfigStore(dir);
    store.save(config);
    expect(store.exists()).toBe(true);
    expect(store.load()).toEqual(config);
  });

  test("never writes the token in the clear", () => {
    const store = new ConfigStore(dir);
    store.save(config);
    expect(readFileSync(store.configPath, "utf8")).not.toContain("SECRET");
    expect(readFileSync(store.keyPath).toString("latin1")).not.toContain("SECRET");
  });

  test("keeps everything private", () => {
    const store = new ConfigStore(dir);
    store.save(config);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(store.configPath).mode & 0o777).toBe(0o600);
    expect(statSync(store.keyPath).mode & 0o777).toBe(0o600);
    expect(statSync(store.keyPath).size).toBe(32);
  });

  test("reuses its key when saved again and replaces the old values", () => {
    const store = new ConfigStore(dir);
    store.save(config);
    const key = readFileSync(store.keyPath);
    store.save({ ...config, chatId: "-100500", botUsername: "other_bot" });
    expect(readFileSync(store.keyPath).equals(key)).toBe(true);
    expect(store.load()).toEqual({ ...config, chatId: "-100500", botUsername: "other_bot" });
  });

  test("explains a missing key", () => {
    const store = new ConfigStore(dir);
    store.save(config);
    rmSync(store.keyPath);
    expect(() => store.load()).toThrow(ConfigError);
    expect(() => store.load()).toThrow(/secret\.key is missing.*init/);
  });

  test("explains a key that does not match or is damaged", () => {
    const store = new ConfigStore(dir);
    store.save(config);
    writeFileSync(store.keyPath, randomBytes(32));
    expect(() => store.load()).toThrow(/cannot decrypt/);
    writeFileSync(store.keyPath, "short");
    expect(() => store.load()).toThrow(/damaged/);
  });

  test("explains a config file that is not JSON or does not match the format", () => {
    const store = new ConfigStore(dir);
    store.save(config);
    writeFileSync(store.configPath, "{ nope");
    expect(() => store.load()).toThrow(/not valid JSON/);
    writeFileSync(store.configPath, JSON.stringify({ version: 1, telegram: { botUsername: "x", chatId: "abc" } }));
    expect(() => store.load()).toThrow(/invalid/);
  });

  test("leaves no temp files behind", () => {
    const store = new ConfigStore(dir);
    store.save(config);
    expect(existsSync(`${store.configPath}.${process.pid}.tmp`)).toBe(false);
  });
});
