/**
 * Geometry of the phone map's action pill (MapActionPill) and the tab bar it
 * stands above, shared with the things that must stay clear of them. Pixels.
 */

import type { Insets } from "@/lib/phone-map-geometry"
import { PILL_WIDTH, PILL_WIDTH_COMPACT, pillSize, type PillSize } from "@/lib/phone-pill"

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

/** The pill's size for the room between 8px under the map's top and 12px above the tab bar. */
export function measurePillSize(map: HTMLElement): PillSize {
  return pillSize(map.clientHeight - 8 - (tabBarTop() + 12))
}

export function pillWidth(size: PillSize): number {
  return size === "compact" ? PILL_WIDTH_COMPACT : PILL_WIDTH
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
