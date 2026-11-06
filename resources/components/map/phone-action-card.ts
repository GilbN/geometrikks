/**
 * Geometry of the phone map's floating action card (MapControls), shared with
 * the things that must stay clear of it: map fitting, popups, the frame-rate
 * badge and toasts. Pixels, measured from the map's bottom edge, before the
 * safe-area inset.
 */

import type { Insets } from "@/lib/phone-map-geometry"

export const PHONE_ACTION_CARD_BOTTOM = 30
export const PHONE_ACTION_CARD_HEIGHT = 62
/** Where the card's top edge sits. */
export const PHONE_ACTION_CARD_TOP = PHONE_ACTION_CARD_BOTTOM + PHONE_ACTION_CARD_HEIGHT

/** CSS length for something that floats `gap` px above the card. */
export function abovePhoneActionCard(gap: number): string {
  return `calc(${PHONE_ACTION_CARD_TOP + gap}px + env(safe-area-inset-bottom, 0px))`
}

/** The card's top edge in px, safe-area inset included, for MapLibre padding. */
export function phoneActionCardTop(): number {
  return PHONE_ACTION_CARD_TOP + safeAreaInsets().bottom
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
