import { describe, expect, test } from "bun:test";
import { escapeHtml, extractLinks, includeCopy } from "../scripts/lib/markdown";

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

describe("extractLinks", () => {
  test("reads links, images, definitions and JSX href and src strings", () => {
    const source = [
      "[a](/one/) ![i](/two.png) [r][ref]",
      "",
      "[ref]: /three/",
      "",
      '<a href="/four/">a</a> <img src={"/five.png"} /> <a href={`/six/`}>b</a>',
      "",
      '<Card title="t" href="/seven/" />',
    ].join("\n");
    expect(extractLinks(source)).toEqual(["/one/", "/two.png", "/three/", "/four/", "/five.png", "/six/", "/seven/"]);
  });

  test("skips code, other attributes and computed values", () => {
    const source = [
      "`[a](/x/)` and ``<a href=\"/x/\">``",
      "",
      "```mdx",
      "[a](/x/)",
      "```",
      "",
      '<a title="/x/" href={base} src={`/docs/${slug}/`}>a</a>',
    ].join("\n");
    expect(extractLinks(source)).toEqual([]);
  });

  test("a stray backtick or a brace in a JSX string hides nothing", () => {
    expect(extractLinks("Stray ` tick\n```\nx\n```\n[a](/q/) and `y`")).toEqual(["/q/"]);
    expect(extractLinks("Press the ` key.\n```bash\necho `date`\n```\n\n[a](/q/)")).toEqual(["/q/"]);
    expect(extractLinks("<span title={`}`} /> [a](/q/) then `example`")).toEqual(["/q/"]);
  });

  test("ignores frontmatter and reads raw HTML in a .md page", () => {
    expect(extractLinks("---\ntitle: a { b\n---\n\n[a](/q/)")).toEqual(["/q/"]);
    expect(extractLinks('<a href="/q/">a</a> <br>\n', "md")).toEqual(["/q/"]);
  });

  test("throws on invalid MDX", () => {
    expect(() => extractLinks("<a>unclosed")).toThrow(/closing tag/);
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
