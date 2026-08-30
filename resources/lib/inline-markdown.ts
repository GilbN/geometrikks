/**
 * The inline markdown CHANGELOG.md entries use: `code`, **bold** and
 * [text](url). Anything else, including an unclosed span, stays text.
 */
export type InlineToken =
  | { type: "text"; value: string }
  | { type: "code"; value: string }
  | { type: "bold"; value: string }
  | { type: "link"; value: string; href: string }

const SPAN_RE = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g

export function tokenizeInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = []
  let last = 0
  for (const match of text.matchAll(SPAN_RE)) {
    const index = match.index ?? 0
    if (index > last) tokens.push({ type: "text", value: text.slice(last, index) })
    const [, code, bold, linkText, href] = match
    if (code !== undefined) tokens.push({ type: "code", value: code })
    else if (bold !== undefined) tokens.push({ type: "bold", value: bold })
    else if (linkText !== undefined && href !== undefined) tokens.push({ type: "link", value: linkText, href })
    last = index + match[0].length
  }
  if (last < text.length) tokens.push({ type: "text", value: text.slice(last) })
  return tokens
}
