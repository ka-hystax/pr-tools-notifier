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

test("starts with no menu and nothing on screen", () => {
  expect(store.load()).toEqual({ menu: null, view: [] });
});

test("remembers what it was given", () => {
  store.save({ menu: 3, view: [12] });
  expect(store.load()).toEqual({ menu: 3, view: [12] });
});

test("starts over from a file it cannot read", () => {
  writeFileSync(store.path, "{ nope");
  expect(store.load()).toEqual({ menu: null, view: [] });
  writeFileSync(store.path, JSON.stringify({ menu: "yes" }));
  expect(store.load()).toEqual({ menu: null, view: [] });
});

test("a file from before the menu keeps what is on screen and gets the menu sent again", () => {
  writeFileSync(store.path, JSON.stringify({ intro: true, view: [7] }));
  expect(store.load()).toEqual({ menu: null, view: [7] });
});
