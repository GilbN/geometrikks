const CODE_SPAN_OR_ANGLE = /(`+)[\s\S]*?(?<!`)\1(?!`)|</g;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

function escapeParagraph(text: string): string {
  return text.replace(CODE_SPAN_OR_ANGLE, (match, ticks?: string) => (ticks ? match : "\\<"));
}

/** Backslash-escape `<` outside code: raw HTML in an included .md file fails the MDX compile ("unknown node raw"). */
export function escapeHtml(markdown: string): string {
  const out: string[] = [];
  let paragraph: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    if (paragraph.length > 0) out.push(escapeParagraph(paragraph.join("\n")));
    paragraph = [];
  };
  for (const line of markdown.split("\n")) {
    const opener = FENCE.exec(line)?.[1];
    if (fence !== null) {
      out.push(line);
      if (opener?.[0] === fence[0] && opener.length >= fence.length) fence = null;
    } else if (opener) {
      flush();
      out.push(line);
      fence = opener;
    } else if (line.trim() === "") {
      flush();
      out.push(line);
    } else {
      paragraph.push(line);
    }
  }
  flush();
  return out.join("\n");
}

/**
 * Prepare a repo-root Markdown file for `<include>`: drop the H1 (the page title renders it), unlink
 * reference-link headings such as Keep a Changelog's `## [0.24.0]` (Fumadocs wraps every heading in an
 * anchor, and a nested `<a>` breaks hydration), and escape raw HTML.
 */
export function includeCopy(markdown: string): string {
  const withoutTitle = markdown.replace(/^# .*\n+/, "");
  return escapeHtml(withoutTitle.replace(/^(#{2,6} +)\[([^\]]+)\](?![(\[])/gm, "$1$2"));
}
