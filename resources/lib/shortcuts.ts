/**
 * The app's keyboard shortcuts: one list that the key handler, the cheat
 * sheet and the command palette all read, so a key is named the same way
 * everywhere it shows.
 */

export type ShortcutGroup = "anywhere" | "goto" | "tables"

export type ShortcutId =
  | "palette"
  | "focus-filter"
  | "time-range"
  | "refresh"
  | "ban"
  | "live-tail"
  | "toggle-sidebar"
  | "cheat-sheet"
  | "go-overview"
  | "go-map"
  | "go-access-logs"
  | "go-geo-logs"
  | "go-debug-logs"
  | "go-analytics"
  | "go-security"
  | "go-settings"
  | "row-next"
  | "row-previous"
  | "row-open"
  | "row-inspect"
  | "row-copy"
  | "cell-filter"
  | "page-next"
  | "page-previous"

export interface Shortcut {
  id: ShortcutId
  group: ShortcutGroup
  label: string
  /** The keys in order, as `KeyboardEvent.key` reports them. One entry is a
   *  single key; two are a sequence, such as G then A. */
  keys: readonly string[]
  /** Held with Ctrl (or Cmd on a Mac). These work when single-key shortcuts are off. */
  mod?: boolean
  /** Listed on the cheat sheet, but bound elsewhere. */
  external?: boolean
  /** Not listed on its own row; the cheat sheet shows it beside `pairedWith`. */
  pairedWith?: ShortcutId
}

export const SHORTCUTS: readonly Shortcut[] = [
  {
    id: "palette",
    group: "anywhere",
    label: "Search and commands",
    keys: ["k"],
    mod: true,
    external: true,
  },
  { id: "focus-filter", group: "anywhere", label: "Focus the page filter", keys: ["/"] },
  { id: "time-range", group: "anywhere", label: "Change the time range", keys: ["t"] },
  { id: "refresh", group: "anywhere", label: "Refresh now", keys: ["r"] },
  { id: "ban", group: "anywhere", label: "Ban an IP or range", keys: ["b"] },
  { id: "live-tail", group: "anywhere", label: "Start the live tail", keys: ["l"] },
  {
    id: "toggle-sidebar",
    group: "anywhere",
    label: "Collapse the sidebar",
    keys: ["b"],
    mod: true,
    external: true,
  },
  { id: "cheat-sheet", group: "anywhere", label: "Show this list", keys: ["?"] },
  { id: "go-overview", group: "goto", label: "Overview", keys: ["g", "o"] },
  { id: "go-map", group: "goto", label: "Map", keys: ["g", "m"] },
  { id: "go-access-logs", group: "goto", label: "Access Logs", keys: ["g", "a"] },
  { id: "go-geo-logs", group: "goto", label: "Geo Logs", keys: ["g", "g"] },
  { id: "go-debug-logs", group: "goto", label: "Debug Logs", keys: ["g", "d"] },
  { id: "go-analytics", group: "goto", label: "Analytics", keys: ["g", "n"] },
  { id: "go-security", group: "goto", label: "Security", keys: ["g", "s"] },
  { id: "go-settings", group: "goto", label: "Settings", keys: ["g", ","] },
  { id: "row-next", group: "tables", label: "Next and previous row", keys: ["j"] },
  {
    id: "row-previous",
    group: "tables",
    label: "Previous row",
    keys: ["k"],
    pairedWith: "row-next",
  },
  { id: "row-open", group: "tables", label: "Open the record", keys: ["Enter"], external: true },
  { id: "row-inspect", group: "tables", label: "Inspect the row's IP", keys: ["i"] },
  { id: "row-copy", group: "tables", label: "Copy the row's IP", keys: ["c"] },
  { id: "cell-filter", group: "tables", label: "Filter by the cell under the cursor", keys: ["f"] },
  { id: "page-next", group: "tables", label: "Next and previous page", keys: ["ArrowRight"] },
  {
    id: "page-previous",
    group: "tables",
    label: "Previous page",
    keys: ["ArrowLeft"],
    pairedWith: "page-next",
  },
]

export const GO_TO_PATHS: Partial<Record<ShortcutId, string>> = {
  "go-overview": "/",
  "go-map": "/map",
  "go-access-logs": "/access-logs",
  "go-geo-logs": "/geo-logs",
  "go-debug-logs": "/debug-logs",
  "go-analytics": "/analytics",
  "go-security": "/security",
  "go-settings": "/settings",
}

/** Keys held down that repeat: moving through rows and pages. */
const REPEATABLE: ReadonlySet<ShortcutId> = new Set([
  "row-next",
  "row-previous",
  "page-next",
  "page-previous",
])

/** How long a sequence waits for its second key. */
export const SEQUENCE_TIMEOUT_MS = 1500

const KEY_LABELS: Record<string, string> = {
  Enter: "↵",
  ArrowRight: "→",
  ArrowLeft: "←",
}

const SPOKEN_KEYS: Record<string, string> = {
  Enter: "Enter",
  ArrowRight: "Right arrow",
  ArrowLeft: "Left arrow",
  ",": "comma",
  "/": "slash",
  "?": "question mark",
}

/** How a screen reader should hear one shortcut's keys. */
export function shortcutSpokenKeys(shortcut: Shortcut, apple = applePlatform()): string[] {
  return [
    ...(shortcut.mod ? [apple ? "Command" : "Ctrl"] : []),
    ...shortcut.keys.map((key) => SPOKEN_KEYS[key] ?? keyLabel(key)),
  ]
}

/** How the cheat sheet and the palette print a key. */
export function keyLabel(key: string): string {
  return KEY_LABELS[key] ?? (key.length === 1 ? key.toUpperCase() : key)
}

/** The labels for one shortcut's keys, Ctrl first for a held one. */
export function shortcutKeyLabels(shortcut: Shortcut, apple = applePlatform()): string[] {
  return [...(shortcut.mod ? [modifierLabel(apple)] : []), ...shortcut.keys.map(keyLabel)]
}

/** The held key the Ctrl shortcuts use, which is Cmd on a Mac. */
export function modifierLabel(apple = applePlatform()): string {
  return apple ? "⌘" : "Ctrl"
}

/** `aria-keyshortcuts` for a Ctrl shortcut on this platform. */
export function ariaKeyShortcut(key: string, apple = applePlatform()): string {
  return `${apple ? "Meta" : "Control"}+${key.toUpperCase()}`
}

export interface KeyInput {
  key: string
  code?: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  repeat: boolean
}

export type MatchResult =
  | { kind: "match"; shortcut: Shortcut }
  | { kind: "pending"; prefix: string }
  /** The first key of a sequence repeats while held, and the sequence keeps waiting. */
  | { kind: "waiting" }
  | { kind: "none" }

const singleKey = SHORTCUTS.filter(
  (shortcut) => !shortcut.mod && !shortcut.external && shortcut.keys.length === 1,
)
const sequences = SHORTCUTS.filter((shortcut) => !shortcut.mod && shortcut.keys.length === 2)
const prefixes = new Set(sequences.map((shortcut) => shortcut.keys[0]))

export const MODIFIER_KEYS: ReadonlySet<string> = new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "CapsLock",
  "AltGraph",
])

/**
 * Letters arrive in upper case with Caps Lock on. On a non-Latin layout the
 * physical J key reports another letter, so letters fall back to the key's
 * position. Everything else stays as typed.
 */
function normalize(key: string, code: string | undefined): string {
  if (key.length !== 1 || !/\p{L}/u.test(key)) return key
  // Accented Latin letters are their own keys, not stand-ins for A to Z.
  if (/\p{Script=Latin}/u.test(key)) return key.toLowerCase()
  const position = code?.match(/^Key([A-Z])$/)
  return position ? position[1].toLowerCase() : key
}

/** The key a shortcut sees for this press, on any keyboard layout. */
export function shortcutKey(event: { key: string; code?: string }): string {
  return normalize(event.key, event.code)
}

/**
 * Which shortcut a key press finishes, given the first key of a sequence when
 * one is waiting. Shift is allowed, since "?" needs it on most layouts; any
 * other modifier means the press belongs to the browser or the system.
 */
export function matchKey(event: KeyInput, pendingPrefix: string | null): MatchResult {
  // A modifier pressed on its own keeps a sequence waiting.
  if (MODIFIER_KEYS.has(event.key))
    return pendingPrefix === null ? { kind: "none" } : { kind: "waiting" }
  if (event.ctrlKey || event.metaKey || event.altKey) return { kind: "none" }
  const key = normalize(event.key, event.code)
  if (pendingPrefix !== null) {
    if (event.repeat && key === pendingPrefix) return { kind: "waiting" }
    const shortcut = sequences.find(
      (candidate) => candidate.keys[0] === pendingPrefix && candidate.keys[1] === key,
    )
    return shortcut && !event.repeat ? { kind: "match", shortcut } : { kind: "none" }
  }
  if (prefixes.has(key)) return event.repeat ? { kind: "none" } : { kind: "pending", prefix: key }
  const shortcut = singleKey.find((candidate) => candidate.keys[0] === key)
  if (!shortcut) return { kind: "none" }
  if (event.repeat && !REPEATABLE.has(shortcut.id)) return { kind: "none" }
  return { kind: "match", shortcut }
}

/** Whether this is a Mac or iPad, where Cmd takes the place of Ctrl. */
export function applePlatform(): boolean {
  if (typeof navigator === "undefined") return false
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ||
    navigator.platform
  return /mac|iphone|ipad|ipod/i.test(platform)
}

/**
 * Ctrl+K, or Cmd+K on a Mac, with no other modifier. On a Mac, Ctrl+K stays
 * the system's "delete to end of line" in text fields.
 */
export function isPaletteKey(
  event: KeyInput & { shiftKey?: boolean },
  apple: boolean = applePlatform(),
): boolean {
  const modifier = apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  return modifier && !event.altKey && !event.shiftKey && normalize(event.key, event.code) === "k"
}

/** Whether keys typed here belong to the element, not to the shortcuts. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true
  if (target instanceof HTMLInputElement) {
    return !["checkbox", "radio", "button", "submit", "reset", "range", "color"].includes(
      target.type,
    )
  }
  if (target instanceof HTMLElement && target.isContentEditable) return true
  return target.closest('[role="textbox"],[role="combobox"],[role="searchbox"]') !== null
}

/**
 * Whether a modal layer is open. Radix and vaul lock the page's scroll while
 * a modal dialog, sheet, drawer or menu is open, and focus can still land on
 * the body behind it, for example when a button inside it turns disabled.
 */
export function modalLayerOpen(): boolean {
  return document.body.hasAttribute("data-scroll-locked")
}

/** Focus inside a dialog, sheet, menu or list keeps its keys to itself. */
export function isInOverlay(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return (
    target.closest(
      '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[data-radix-popper-content-wrapper],[data-vaul-drawer]',
    ) !== null
  )
}
