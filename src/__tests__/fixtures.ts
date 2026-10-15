import { readFileSync } from "node:fs";

export type FixtureName = "mine" | "todo";

export function readFixtureText(name: FixtureName): string {
  return readFileSync(new URL(`./fixtures/snapshots/${name}.json`, import.meta.url), "utf8");
}

// Tests edit the parsed document in place, so it is deliberately untyped.
export function readFixture(name: FixtureName): any {
  return JSON.parse(readFixtureText(name));
}
