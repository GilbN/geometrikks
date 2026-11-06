import { PILL_WIDTH } from "./phone-pill"

type ToastPlacementInput = {
  side: boolean
  onMap: boolean
  covered: boolean
  barSide: number
  leftInset: number
  rightInset: number
  headerBottom: number
}

type ToastPlacement = {
  position: "bottom-center" | "top-center"
  offset: { top?: string; bottom?: string; left?: string; right?: string }
  className: string
}

/** Where the toaster sits on a phone: above the tab bar, short of the map pill
 *  in portrait, or under the header while a surface covers the bottom edge. */
export function phoneToastPlacement({ side, onMap, covered, barSide, leftInset, rightInset, headerBottom }: ToastPlacementInput): ToastPlacement {
  if (covered) {
    return {
      position: "top-center",
      offset: {
        top: `${headerBottom + 8}px`,
        left: `${Math.max(barSide, leftInset)}px`,
        right: `${Math.max(barSide, rightInset)}px`,
      },
      className: "toaster-span",
    }
  }
  if (side) {
    return { position: "bottom-center", offset: { bottom: "var(--tab-bar-clear)" }, className: "toaster-centred" }
  }
  const right = onMap ? PILL_WIDTH + Math.max(barSide, rightInset) + 8 : barSide
  return {
    position: "bottom-center",
    offset: { bottom: "var(--tab-bar-clear)", left: `${barSide}px`, right: `${right}px` },
    className: "toaster-span",
  }
}
