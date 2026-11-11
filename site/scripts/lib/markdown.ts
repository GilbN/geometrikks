import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";

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

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(?=\r?\n|$)/;
const HTML_LINK_ATTRIBUTE = /\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

export type MarkdownFormat = "mdx" | "md";

/** Parse a docs page as MDX, or as plain Markdown for a .md page as fumadocs-mdx does. Throws on invalid MDX. */
export function parseMarkdown(source: string, format: MarkdownFormat = "mdx") {
  const body = source.replace(FRONTMATTER, (block) => block.replace(/[^\n]/g, ""));
  const processor = unified().use(remarkParse).use(remarkGfm);
  return (format === "mdx" ? processor.use(remarkMdx) : processor).parse(body);
}

/**
 * URLs a page links to: Markdown links, images and reference definitions, and string `href`/`src` values on
 * JSX elements (raw HTML in a .md page). Code blocks and code spans hold no links. Throws on invalid MDX.
 */
export function extractLinks(source: string, format: MarkdownFormat = "mdx"): string[] {
  const links: string[] = [];
  visit(parseMarkdown(source, format), (node) => {
    switch (node.type) {
      case "link":
      case "image":
      case "definition":
        links.push(node.url);
        break;
      case "mdxJsxFlowElement":
      case "mdxJsxTextElement":
        for (const attribute of node.attributes) {
          if (attribute.type !== "mdxJsxAttribute" || !["href", "src"].includes(attribute.name)) continue;
          if (typeof attribute.value === "string") {
            links.push(attribute.value);
            continue;
          }
          const statement = attribute.value?.data?.estree?.body[0];
          if (statement?.type !== "ExpressionStatement") continue;
          const { expression } = statement;
          if (expression.type === "Literal" && typeof expression.value === "string") links.push(expression.value);
          else if (expression.type === "TemplateLiteral" && expression.expressions.length === 0) {
            links.push(expression.quasis[0].value.cooked ?? expression.quasis[0].value.raw);
          }
        }
        break;
      case "html":
        for (const match of node.value.matchAll(HTML_LINK_ATTRIBUTE)) links.push(match[1] ?? match[2]);
        break;
    }
  });
  return links;
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
