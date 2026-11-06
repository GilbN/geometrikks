/**
 * Geometry of the map on a phone held sideways: the action rail on the right
 * edge, the detail panel docked there, and what fitting, panning and toasts
 * must keep clear of. Pixels.
 */

export type Insets = { left: number; right: number; bottom: number }
export type Box = { left: number; right: number; top: number; bottom: number }

export const PHONE_RAIL_WIDTH = 76
/** The rail's and the panel's distance from the map's right edge, before the safe-area inset. */
export const PHONE_RAIL_EDGE = 12
export const PHONE_PANEL_MAX_WIDTH = 400
export const PHONE_PANEL_WIDTH_SHARE = 0.45
/** Room a toast leaves for the attribution pill at the map's bottom left. */
const TOAST_LEFT = 48
const TOAST_GAP = 12

export function sideFitPadding(base: number, insets: Insets) {
  return {
    top: base,
    right: base + PHONE_RAIL_WIDTH + Math.max(PHONE_RAIL_EDGE, insets.right),
    bottom: base + insets.bottom,
    left: base,
  }
}

export function sidePanelWidth(mapWidth: number): number {
  return Math.round(Math.min(PHONE_PANEL_MAX_WIDTH, PHONE_PANEL_WIDTH_SHARE * mapWidth))
}

/** Where a selected point may sit: left of the panel, below the top inset and above the bottom inset. */
export function sideVisibleBox(args: {
  mapWidth: number
  mapHeight: number
  panelLeft: number
  topInset: number
  bottomInset: number
  margin: number
}): Box {
  return {
    left: args.margin,
    right: args.panelLeft - args.margin,
    top: args.topInset,
    bottom: args.mapHeight - args.margin - args.bottomInset,
  }
}

/** The pan that brings `point` into `box`: none on an axis where it is inside, else onto the box's centre. */
export function panToBox(point: { x: number; y: number }, box: Box): { dx: number; dy: number } {
  const dx = point.x < box.left || point.x > box.right ? point.x - (box.left + box.right) / 2 : 0
  const dy = point.y < box.top || point.y > box.bottom ? point.y - (box.top + box.bottom) / 2 : 0
  return { dx, dy }
}

/** A toast's distance from the viewport's left and right edges, so it stays on the free map.
 *  A map that starts at the screen's edge (the phone shell) also clears the left inset. */
export function sideToastArea(args: {
  viewportWidth: number
  mapLeft: number
  mapRight: number
  insets: Insets
  panelOpen: boolean
}): { left: number; right: number } {
  const edge = Math.max(PHONE_RAIL_EDGE, args.insets.right)
  const occupied = args.panelOpen ? sidePanelWidth(args.mapRight - args.mapLeft) : PHONE_RAIL_WIDTH
  return {
    left: Math.max(args.mapLeft, args.insets.left) + TOAST_LEFT,
    right: args.viewportWidth - args.mapRight + edge + occupied + TOAST_GAP,
  }
}
