/**
 * Screen-reader text after a value people copy, such as " (Banned)" after an
 * IP. A text node becomes part of a mouse selection, and Chrome's context
 * menu passes it to search and extensions as "1.2.3.4(Banned)". CSS generated
 * content is in the accessible name but never in a selection.
 */
export function SrOnlySuffix({ text }: { text: string }) {
  return <span className="sr-only after:content-[attr(data-sr-text)]" data-sr-text={text} />
}
