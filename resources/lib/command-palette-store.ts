/**
 * Whether the command palette is open, what had focus when it opened, and
 * the action a picked row runs once it has closed. The key handler and the
 * palette both read this, so neither imports the other.
 */
import { useSyncExternalStore } from "react"

let open = false
let opener: HTMLElement | null = null
let pendingAction: (() => void) | null = null
const listeners = new Set<() => void>()

function setOpen(next: boolean): void {
  if (next === open) return
  open = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** `from` names the opener when focus can't tell, as after a click in Safari. */
export function openCommandPalette(from?: HTMLElement | null): void {
  const active = from ?? document.activeElement
  // Reopened while it fades out, focus is still in the palette. Keep the first opener.
  if (!(active instanceof HTMLElement && active.closest("[data-command-palette]"))) {
    opener = active instanceof HTMLElement && active !== document.body ? active : null
  }
  // A row picked just before a quick reopen must not run on a later close.
  pendingAction = null
  setOpen(true)
}

export function closeCommandPalette(): void {
  setOpen(false)
}

/** For the dialog's onOpenChange. */
export function setCommandPaletteOpen(next: boolean): void {
  if (next) openCommandPalette()
  else closeCommandPalette()
}

/** Forgets everything, for a palette that unmounts mid-close, as on sign-out. */
export function resetCommandPalette(): void {
  opener = null
  pendingAction = null
  setOpen(false)
}

export function commandPaletteOpen(): boolean {
  return open
}

export function useCommandPaletteOpen(): boolean {
  return useSyncExternalStore(subscribe, () => open)
}

/** Closes the palette and runs `action` after it hands focus back. */
export function closeCommandPaletteThen(action: () => void): void {
  pendingAction = action
  setOpen(false)
}

/** What to do once the palette has closed: the opener to refocus and the action to run. */
export function takeCommandPaletteClose(): {
  opener: HTMLElement | null
  action: (() => void) | null
} {
  const result = { opener, action: pendingAction }
  opener = null
  pendingAction = null
  return result
}
