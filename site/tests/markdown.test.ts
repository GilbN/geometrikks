import { describe, expect, test } from "bun:test";
import { escapeHtml, includeCopy } from "../scripts/lib/markdown";

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

  test("fenced code is left alone", () => {
    expect(escapeHtml("```html\n<div>\n\n</div>\n```\n<p>")).toBe("```html\n<div>\n\n</div>\n```\n\\<p>");
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
