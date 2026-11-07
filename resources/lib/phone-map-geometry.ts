/**
 * Geometry of the map on a phone: the detail panel docked on the right when
 * the phone is held sideways, and what fitting and panning must keep clear
 * of. Pixels.
 */

export type Insets = { left: number; right: number; bottom: number }
export type Box = { left: number; right: number; top: number; bottom: number }

/** The panel's distance from the map's right edge, before the safe-area inset. */
export const PHONE_RAIL_EDGE = 12
export const PHONE_PANEL_MAX_WIDTH = 400
export const PHONE_PANEL_WIDTH_SHARE = 0.45

/** Fit padding that keeps fitted points clear of the range chip at the top
 *  (`topClearance`, the top safe area included), the map pill on the right,
 *  12px above the tab bar, and of the left cutout on a phone held sideways. */
export function phoneFitPadding(
  base: number,
  {
    side,
    insets,
    topClearance,
    barTop,
    pillWidth,
    pillEdge,
  }: { side: boolean; insets: Insets; topClearance: number; barTop: number; pillWidth: number; pillEdge: number },
) {
  return {
    top: base + topClearance,
    right: base + pillWidth + pillEdge,
    bottom: base + barTop + 12,
    left: base + (side ? insets.left : 0),
  }
}

export function sidePanelWidth(mapWidth: number): number {
  return Math.round(Math.min(PHONE_PANEL_MAX_WIDTH, PHONE_PANEL_WIDTH_SHARE * mapWidth))
}

/** Where a selected point may sit: left of the panel, right of the left inset, below the top inset and above the bottom inset. */
export function sideVisibleBox(args: {
  mapWidth: number
  mapHeight: number
  panelLeft: number
  topInset: number
  leftInset: number
  bottomInset: number
  margin: number
}): Box {
  return {
    left: args.leftInset + args.margin,
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
