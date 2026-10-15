import { describe, expect, test } from "vitest";
import { configDir, stateDir } from "../paths.js";

describe("paths", () => {
  test("defaults to ~/.config/pr-tools-notifier", () => {
    expect(configDir({}, "/home/me")).toBe("/home/me/.config/pr-tools-notifier");
    expect(stateDir({}, "/home/me")).toBe("/home/me/.config/pr-tools-notifier/state");
  });

  test("follows XDG_CONFIG_HOME when set", () => {
    expect(configDir({ XDG_CONFIG_HOME: "/xdg" }, "/home/me")).toBe("/xdg/pr-tools-notifier");
  });
});
