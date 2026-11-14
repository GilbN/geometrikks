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

interface EstreeNode {
  type: string;
  [key: string]: unknown;
}

const isEstreeNode = (value: unknown): value is EstreeNode =>
  typeof value === "object" && value !== null && typeof (value as EstreeNode).type === "string";

/** A string literal, or a template literal with no `${}`. Anything computed returns undefined. */
function staticString(expression: unknown): string | undefined {
  if (!isEstreeNode(expression)) return undefined;
  if (expression.type === "Literal") return typeof expression.value === "string" ? expression.value : undefined;
  if (expression.type !== "TemplateLiteral") return undefined;
  const { expressions, quasis } = expression as unknown as {
    expressions: unknown[];
    quasis: { value: { cooked?: string | null; raw: string } }[];
  };
  if (expressions.length > 0) return undefined;
  return quasis[0].value.cooked ?? quasis[0].value.raw;
}

/** Collect `href`/`src` from every JSX attribute in a program an MDX expression or `export` holds. */
function collectEstreeLinks(node: unknown, links: string[]): void {
  if (Array.isArray(node)) {
    for (const child of node) collectEstreeLinks(child, links);
    return;
  }
  if (!isEstreeNode(node)) return;
  if (node.type === "JSXAttribute") {
    const { name, value } = node as unknown as { name: EstreeNode; value: EstreeNode | null };
    if (name.type === "JSXIdentifier" && ["href", "src"].includes(name.name as string) && value) {
      const link = staticString(value.type === "JSXExpressionContainer" ? value.expression : value);
      if (link !== undefined) links.push(link);
    }
  }
  for (const [key, child] of Object.entries(node)) {
    if (key !== "loc" && key !== "range" && typeof child === "object") collectEstreeLinks(child, links);
  }
}

/**
 * URLs a page links to: Markdown links, images and reference definitions, and string `href`/`src` values on
 * JSX elements, including elements inside `{...}` expressions and `export` blocks (and raw HTML in a .md
 * page). Code blocks and code spans hold no links. Computed values (identifiers, `${}` templates, spreads)
 * are not read. Throws on invalid MDX.
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
      case "mdxFlowExpression":
      case "mdxTextExpression":
      case "mdxjsEsm":
        collectEstreeLinks(node.data?.estree, links);
        break;
      case "mdxJsxFlowElement":
      case "mdxJsxTextElement":
        for (const attribute of node.attributes) {
          if (attribute.type !== "mdxJsxAttribute") continue;
          const isLink = ["href", "src"].includes(attribute.name);
          if (typeof attribute.value === "string") {
            if (isLink) links.push(attribute.value);
          } else if (attribute.value) {
            const program = attribute.value.data?.estree;
            const statement = program?.body[0];
            if (isLink && statement?.type === "ExpressionStatement") {
              const link = staticString(statement.expression);
              if (link !== undefined) links.push(link);
            }
            collectEstreeLinks(program, links);
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
