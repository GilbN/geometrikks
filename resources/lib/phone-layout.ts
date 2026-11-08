export function isPortraitList(mobile: boolean, side: boolean): boolean {
  return mobile && !side
}

export interface KeyboardProbe {
  focusedEditable: boolean
  scale: number
  viewportHeight: number
  innerHeight: number
}

/** Whether the on-screen keyboard is up: an editable element has focus and the
 *  visual viewport shrank without a pinch zoom. */
export function isKeyboardOpen(probe: KeyboardProbe): boolean {
  return probe.focusedEditable && Math.abs(probe.scale - 1) < 0.01 && probe.innerHeight - probe.viewportHeight > 120
}

export interface ViewportHeightProbe {
  focusedEditable: boolean
  scale: number
  tallestHeight: number
  innerHeight: number
}

/** Whether the page stayed shorter than it has been with the keyboard gone. */
export function isViewportStuck(probe: ViewportHeightProbe): boolean {
  return !probe.focusedEditable && Math.abs(probe.scale - 1) < 0.01 && probe.tallestHeight - probe.innerHeight > 4
}

/** What an overlay with a phone version renders as: the desktop dialog or
 *  menu, a bottom drawer, or a drawer on the right of a phone held sideways. */
export type DrawerLayout = "desktop" | "bottom" | "right"

export function drawerLayout(phone: boolean, side: boolean): DrawerLayout {
  if (!phone) return "desktop"
  return side ? "right" : "bottom"
}

/** An overlay is open, sliding out after a close, or gone. */
export type DrawerPhase = "open" | "closing" | "closed"

/** The layout an overlay renders in, given the one it opened in. A vaul
 *  drawer can't change direction or turn into a dialog while mounted, so an
 *  overlay whose layout changed while open is `turned` and has to close,
 *  unless it keeps the layout it opened in. A drawer sliding out finishes in
 *  the layout it opened in. */
export function settleDrawerLayout(
  current: DrawerLayout,
  openedIn: DrawerLayout,
  phase: DrawerPhase,
  keepWhileOpen: boolean,
): { layout: DrawerLayout; turned: boolean } {
  if (phase === "closed" || openedIn === current) return { layout: current, turned: false }
  if (phase === "closing" || keepWhileOpen) return { layout: openedIn, turned: false }
  return { layout: current, turned: true }
}
