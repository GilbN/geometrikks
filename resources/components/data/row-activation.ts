import type { KeyboardEvent, MouseEvent } from "react"

/**
 * Props that make a table row open a detail view: click, Enter or Space
 * on the row itself. Events from controls inside the row (ban menus, links)
 * never reach the row because those stop propagation; the key guard makes
 * sure a key pressed while a nested control has focus does not count either.
 */
export function rowActivation<T extends HTMLElement>(open: () => void) {
  return {
    tabIndex: 0,
    role: "button" as const,
    className: "cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring",
    onClick: (_event: MouseEvent<T>) => open(),
    onKeyDown: (event: KeyboardEvent<T>) => {
      if (event.target !== event.currentTarget) return
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault()
        open()
      }
    },
  }
}

/** Wrap nested interactive content so it does not activate the row. */
export const stopRowActivation = {
  onClick: (event: MouseEvent) => event.stopPropagation(),
  onKeyDown: (event: KeyboardEvent) => event.stopPropagation(),
}
