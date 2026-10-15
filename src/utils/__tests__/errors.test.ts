import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { errorCode } from "../errors.js";

describe("errorCode", () => {
  test("reads the code of a real system error", () => {
    let caught: unknown;
    try {
      readFileSync("/definitely/not/here");
    } catch (err) {
      caught = err;
    }
    expect(errorCode(caught)).toBe("ENOENT");
  });

  test("is undefined for errors without a string code and for non-errors", () => {
    expect(errorCode(new Error("plain"))).toBeUndefined();
    expect(errorCode(Object.assign(new Error("exit"), { code: 1 }))).toBeUndefined();
    expect(errorCode({ code: "ENOENT" })).toBeUndefined();
    expect(errorCode("ENOENT")).toBeUndefined();
    expect(errorCode(null)).toBeUndefined();
  });
});
