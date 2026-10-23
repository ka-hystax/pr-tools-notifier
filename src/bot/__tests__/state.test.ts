import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { BotStateStore } from "../state.js";

let dir: string;
let store: BotStateStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "prn-botstate-"));
  store = new BotStateStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("starts as a bot that has not introduced itself and shows nothing", () => {
  expect(store.load()).toEqual({ intro: false, view: [] });
});

test("remembers what it was given", () => {
  store.save({ intro: true, view: [12] });
  expect(store.load()).toEqual({ intro: true, view: [12] });
});

test("starts over from a file it cannot read", () => {
  writeFileSync(store.path, "{ nope");
  expect(store.load()).toEqual({ intro: false, view: [] });
  writeFileSync(store.path, JSON.stringify({ intro: "yes" }));
  expect(store.load()).toEqual({ intro: false, view: [] });
});
