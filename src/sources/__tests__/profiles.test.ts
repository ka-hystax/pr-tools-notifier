import { describe, expect, test } from "vitest";
import type { Exec } from "../gh.js";
import { parseProfileList, ProfileError, resolveProfile } from "../profiles.js";

function fake(stdout: string): { exec: Exec; calls: { file: string; args: string[] }[] } {
  const calls: { file: string; args: string[] }[] = [];
  return {
    calls,
    exec: async (file, args) => {
      calls.push({ file, args });
      return { stdout, stderr: "" };
    },
  };
}

describe("parseProfileList", () => {
  test("reads one name per line and drops the checkout marker", () => {
    expect(parseProfileList("work (cwd)\nhome\n")).toEqual(["work", "home"]);
  });

  test("ignores the line gh-pr-tools prints when there are no profiles", () => {
    expect(parseProfileList("(no profiles — run: gh pr-tools init)\n")).toEqual([]);
    expect(parseProfileList("")).toEqual([]);
  });
});

describe("resolveProfile", () => {
  test("keeps a profile that was named, without asking gh-pr-tools", async () => {
    const { exec, calls } = fake("other\n");
    expect(await resolveProfile({ profile: "work", exec })).toBe("work");
    expect(calls).toEqual([]);
  });

  test("takes the only profile there is", async () => {
    const { exec, calls } = fake("work\n");
    expect(await resolveProfile({ exec })).toBe("work");
    expect(calls).toEqual([{ file: "gh", args: ["pr-tools", "profile", "list"] }]);
  });

  test("asks a gh-pr-tools checkout directly when one is given", async () => {
    const { exec, calls } = fake("only\n");
    await resolveProfile({ prToolsPath: "/x/gh-pr-tools", exec });
    expect(calls).toEqual([{ file: "/x/gh-pr-tools", args: ["profile", "list"] }]);
  });

  test("lists the choices when there are several", async () => {
    const error = await resolveProfile({ exec: fake("a\nb (cwd)\n").exec }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProfileError);
    expect((error as Error).message).toBe("there are several gh-pr-tools profiles (a, b): choose one with -p NAME");
  });

  test("says what to do when there is none", async () => {
    await expect(resolveProfile({ exec: fake("(no profiles — run: gh pr-tools init)\n").exec })).rejects.toThrow(
      "there is no gh-pr-tools profile yet: run `gh pr-tools init`"
    );
  });

  test("explains a failure to ask", async () => {
    const exec: Exec = async () => {
      throw Object.assign(new Error("x"), { code: "ENOENT" });
    };
    await expect(resolveProfile({ exec })).rejects.toThrow(
      "could not list the gh-pr-tools profiles (gh was not found in PATH)"
    );
  });
});
