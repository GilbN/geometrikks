import * as React from "react"
import { useMediaQuery } from "@/hooks/use-media-query"

const MOBILE_BREAKPOINT = 768

/** A phone turned sideways is wider than the breakpoint but far too short for
 *  floating panels. Tablets are 744px or taller in landscape, so this cap
 *  catches phones only; the coarse pointer keeps a short desktop window on
 *  the desktop layout. The phone-landscape CSS variant in main.css uses the
 *  same query. */
const PHONE_LANDSCAPE_QUERY = "(max-height: 500px) and (pointer: coarse)"

/** Reads the breakpoint synchronously. For one-shot decisions that can't
 *  wait for useIsMobile, which reports false until its effect has run. */
export function isMobileViewport(): boolean {
  return window.innerWidth < MOBILE_BREAKPOINT
}

/** Like isMobileViewport, but also true for a phone in landscape. */
export function isPhoneViewport(): boolean {
  return isMobileViewport() || window.matchMedia(PHONE_LANDSCAPE_QUERY).matches
}

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const onChange = () => {
      setIsMobile(isMobileViewport())
    }
    mql.addEventListener("change", onChange)
    setIsMobile(isMobileViewport())
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return !!isMobile
}

/** useIsMobile plus phones in landscape. For surfaces like the map, where
 *  desktop overlays need height as well as width. */
export function useIsPhone() {
  const [isPhone, setIsPhone] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => {
    const mql = window.matchMedia(
      `(max-width: ${MOBILE_BREAKPOINT - 1}px), ${PHONE_LANDSCAPE_QUERY}`,
    )
    const onChange = () => {
      setIsPhone(isPhoneViewport())
    }
    mql.addEventListener("change", onChange)
    setIsPhone(isPhoneViewport())
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return !!isPhone
}

/** Where a phone's sheets slide in from. A bottom sheet on a phone in
 *  landscape is a short, wide strip, so there they come in from the side at
 *  full height. */
export function usePhoneSheetDirection(): "bottom" | "right" {
  return useMediaQuery("(orientation: landscape)") ? "right" : "bottom"
}
