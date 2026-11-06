/** The portrait phone layout: narrow, and not a phone held sideways. */
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
