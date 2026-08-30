import { tokenizeInline } from "@/lib/inline-markdown"

/** Renders one changelog entry's inline spans: code, bold and links. */
export function InlineMarkdown({ text }: { text: string }) {
  return (
    <>
      {tokenizeInline(text).map((token, index) => {
        switch (token.type) {
          case "code":
            return (
              <code key={index} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground">
                {token.value}
              </code>
            )
          case "bold":
            return (
              <strong key={index} className="font-semibold text-foreground">
                {token.value}
              </strong>
            )
          case "link":
            return (
              <a
                key={index}
                href={token.href}
                target="_blank"
                rel="noreferrer"
                className="text-primary underline-offset-4 hover:underline"
              >
                {token.value}
              </a>
            )
          default:
            return token.value
        }
      })}
    </>
  )
}
