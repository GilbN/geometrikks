import type { KeyboardEvent, MouseEvent } from "react"

/**
 * Props that make a table row open a detail view: click, Enter or Space
 * on the row itself. Events from controls inside the row (ban menus, links)
 * never reach the row because those stop propagation; the key guard makes
 * sure a key pressed while a nested control has focus does not count either.
 * The row ignores clicks from a menu, drawer or dialog that a row control
 * opened. React bubbles them here through its tree, from outside the row's DOM.
 */
export function rowActivation<T extends HTMLElement>(open: () => void) {
  return {
    tabIndex: 0,
    role: "button" as const,
    className: "cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring",
    onClick: (event: MouseEvent<T>) => {
      if (!event.currentTarget.contains(event.target as Node)) return
      // A drag that selected text in the row is a copy, not a click.
      const selection = window.getSelection()
      if (selection && !selection.isCollapsed && event.currentTarget.contains(selection.anchorNode)) return
      open()
    },
    onKeyDown: (event: KeyboardEvent<T>) => {
      if (event.target !== event.currentTarget) return
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault()
        open()
      }
    },
  }
}

/** Wrap nested interactive content so it does not activate the row. Clicks
 *  from portaled content keep bubbling. On touch, Radix and vaul only notice
 *  a tap outside a menu or drawer when the click reaches the document, so
 *  stopping it would leave them open. The row ignores those clicks itself. */
export const stopRowActivation = {
  onClick: (event: MouseEvent) => {
    if (event.currentTarget.contains(event.target as Node)) event.stopPropagation()
  },
  onKeyDown: (event: KeyboardEvent) => event.stopPropagation(),
}
