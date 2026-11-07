import { PILL_WIDTH } from "./phone-pill"

type ToastPlacementInput = {
  side: boolean
  onMap: boolean
  covered: boolean
  barSide: number
  leftInset: number
  rightInset: number
  /** The edge toasts sit 8px under while a surface covers the bottom. */
  topEdge: number
}

type ToastPlacement = {
  position: "bottom-center" | "top-center"
  offset: { top?: string; bottom?: string; left?: string; right?: string }
  className: string
}

/** Where the toaster sits on a phone: above the tab bar, short of the map pill
 *  in portrait, or at the top while a surface covers the bottom edge. */
export function phoneToastPlacement({ side, onMap, covered, barSide, leftInset, rightInset, topEdge }: ToastPlacementInput): ToastPlacement {
  if (covered) {
    return {
      position: "top-center",
      offset: {
        top: `${topEdge + 8}px`,
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

/** The edge covered toasts sit under: the header, or on the map the range
 *  chip, or the top safe area while the chip hides. `shellBottom` is the
 *  bottom of the header and banners, 0 when the map shows neither; the other
 *  two are measured from the map's top. */
export function toastTopEdge({
  onMap,
  chipShown,
  shellBottom,
  chipBottom,
  mapTopInset,
}: {
  onMap: boolean
  chipShown: boolean
  shellBottom: number
  chipBottom: number
  mapTopInset: number
}): number {
  if (!onMap) return shellBottom
  return shellBottom + (chipShown ? chipBottom : mapTopInset)
}
