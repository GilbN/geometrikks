import { describe, expect, test } from "bun:test";
import { escapeHtml, includeCopy, stripCode } from "../scripts/lib/markdown";

describe("escapeHtml", () => {
  test("escapes a tag outside code and keeps code spans", () => {
    expect(escapeHtml("Re-key the <Source> and `<br>` and `` `<a>` ``")).toBe(
      "Re-key the \\<Source> and `<br>` and `` `<a>` ``",
    );
  });

  test("a code span may wrap onto the next line of a paragraph", () => {
    expect(escapeHtml('reports `{"mode": "session",\n  "username": "<x>"}` <b>')).toBe(
      'reports `{"mode": "session",\n  "username": "<x>"}` \\<b>',
    );
  });

  test("a code span never crosses a blank line", () => {
    expect(escapeHtml("a ` <b>\n\nc ` <i>")).toBe("a ` \\<b>\n\nc ` \\<i>");
  });

  test("a code span cannot open in the middle of a backtick run", () => {
    expect(escapeHtml("a ``` <b> `` <i>")).toBe("a ``` \\<b> `` \\<i>");
  });

  test("fenced code is left alone", () => {
    expect(escapeHtml("```html\n<div>\n\n</div>\n```\n<p>")).toBe("```html\n<div>\n\n</div>\n```\n\\<p>");
  });
});

describe("stripCode", () => {
  test("drops inline code spans and fenced blocks, keeping the line count", () => {
    expect(stripCode("a `x` b ``y ` z`` c")).toBe("a  b  c");
    expect(stripCode("before\n```mdx\n[a](/x/)\n```\nafter")).toBe("before\n\n\n\nafter");
    expect(stripCode("~~~\n```\nx\n```\n~~~\nafter")).toBe("\n\n\n\n\nafter");
  });

  test("keeps template literals inside a JSX expression", () => {
    expect(stripCode("<a href={`/docs/next/quickstart/`}>a</a>")).toBe("<a href={`/docs/next/quickstart/`}>a</a>");
    expect(stripCode("{`one ${`two`}`} and `code`")).toBe("{`one ${`two`}`} and ");
    expect(stripCode("<Card\n  href={`/docs/${slug}/`}\n/>")).toBe("<Card\n  href={`/docs/${slug}/`}\n/>");
  });

  test("a brace inside a code span does not open a JSX expression", () => {
    expect(stripCode("`{` then `code`")).toBe(" then ");
  });

  test("a code span cannot open in the middle of a backtick run", () => {
    expect(stripCode("See ``` [a](/x/) `` here.")).toBe("See ``` [a](/x/) `` here.");
  });

  test("an escaped backtick does not open a code span", () => {
    expect(stripCode("\\` [a](/x/) `")).toBe("\\` [a](/x/) `");
  });
});

describe("includeCopy", () => {
  test("drops the H1 and unlinks reference-link headings", () => {
    const changelog = "# Changelog\n\nIntro.\n\n## [Unreleased]\n\n## [0.24.0] - 2026-11-09\n\n[Unreleased]: https://x/compare\n";
    expect(includeCopy(changelog)).toBe("Intro.\n\n## Unreleased\n\n## 0.24.0 - 2026-11-09\n\n[Unreleased]: https://x/compare\n");
  });

  test("keeps inline-link headings and bracketed text in paragraphs", () => {
    expect(includeCopy("## [a](https://x)\n\n[b] <i>")).toBe("## [a](https://x)\n\n[b] \\<i>");
  });
});
