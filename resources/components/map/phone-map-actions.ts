/**
 * Geometry of the phone map's action pill (MapActionPill) and the tab bar it
 * stands above, shared with the things that must stay clear of them. Pixels.
 */

import type { Insets } from "@/lib/phone-map-geometry"

/** The pill's distance from the map's right edge in landscape, before the safe-area inset. */
export const PILL_SIDE_EDGE = 12

/** A CSS length, such as one built from var() or env(), in px. */
function cssLength(value: string): number {
  const probe = document.createElement("div")
  probe.style.cssText = `position:fixed;visibility:hidden;height:${value}`
  document.body.appendChild(probe)
  const length = probe.getBoundingClientRect().height
  probe.remove()
  return length
}

/** The tab bar's top edge, measured from the viewport bottom, safe-area inset included. */
export function tabBarTop(): number {
  return cssLength("var(--tab-bar-top)")
}

/** The pill's distance from the map's right edge: in line with the bar in portrait, clear of the notch sideways. */
export function pillRightEdge(side: boolean, insets: Insets): number {
  return side ? Math.max(PILL_SIDE_EDGE, insets.right) : cssLength("var(--tab-bar-side)")
}

/** The safe-area insets in px. */
export function safeAreaInsets(): Insets {
  // env() only resolves inside CSS, so measure it on a throwaway element.
  const probe = document.createElement("div")
  probe.style.cssText =
    "position:fixed;visibility:hidden;padding:0 env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px)"
  document.body.appendChild(probe)
  const style = getComputedStyle(probe)
  const insets = {
    left: parseFloat(style.paddingLeft) || 0,
    right: parseFloat(style.paddingRight) || 0,
    bottom: parseFloat(style.paddingBottom) || 0,
  }
  probe.remove()
  return insets
}
