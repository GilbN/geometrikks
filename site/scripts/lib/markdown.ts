const CODE_SPAN_OR_ANGLE = /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)|</g;
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

const CODE_SPAN = /(?<!`)(`+)(?!`)(?:(?!\n[ \t]*\n)[\s\S])*?(?<!`)\1(?!`)/y;

/**
 * Drop fenced code blocks and inline code spans, so a check for links skips the examples. Backticks inside a
 * JSX expression, as in href={`/docs/x/`}, are template literals and stay.
 */
export function stripCode(markdown: string): string {
  const lineEnd = (start: number) => {
    const end = markdown.indexOf("\n", start);
    return end === -1 ? markdown.length : end;
  };
  let prose = "";
  let depth = 0;
  let index = 0;
  while (index < markdown.length) {
    if (depth === 0 && (index === 0 || markdown[index - 1] === "\n")) {
      const opener = FENCE.exec(markdown.slice(index, lineEnd(index)))?.[1];
      if (opener) {
        let end = lineEnd(index);
        while (end < markdown.length) {
          prose += "\n";
          const start = end + 1;
          end = lineEnd(start);
          const closer = FENCE.exec(markdown.slice(start, end))?.[1];
          if (closer?.[0] === opener[0] && closer.length >= opener.length) break;
        }
        index = end;
        continue;
      }
    }
    const char = markdown[index];
    if (char === "\\" && depth === 0) {
      prose += markdown.slice(index, index + 2);
      index += 2;
    } else if (char === "`" && depth === 0) {
      CODE_SPAN.lastIndex = index;
      const span = CODE_SPAN.exec(markdown);
      let length = span?.[0].length ?? 0;
      if (!span) {
        while (markdown[index + length] === "`") length++;
        prose += markdown.slice(index, index + length);
      }
      index += length;
    } else {
      if (char === "{") depth++;
      else if (char === "}" && depth > 0) depth--;
      prose += char;
      index++;
    }
  }
  return prose;
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
