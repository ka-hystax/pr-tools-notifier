import { describe, expect, test } from "vitest";
import { htmlToText } from "../text.js";

describe("htmlToText", () => {
  test("strips tags, quotes blockquotes and unescapes entities", () => {
    const html =
      '<a href="https://x.test"><b>#101</b></a> a &amp; b\n💬 <b>alice</b> opened\n<blockquote>if (a &lt; b)</blockquote>\n<code>x&gt;y</code>';
    expect(htmlToText(html)).toBe("#101 a & b\n💬 alice opened\n│ if (a < b)\nx>y");
  });

  test("does not double-unescape", () => {
    expect(htmlToText("&amp;lt;")).toBe("&lt;");
  });
});
