import { useIsMobile } from "@/hooks/use-mobile"
import { useMediaQuery } from "@/hooks/use-media-query"
import { isPortraitList } from "@/lib/phone-layout"

/** A phone held sideways: a short touch screen at least 4:3 wide. The aspect
 *  ratio, not `orientation`, keeps out a portrait phone whose keyboard
 *  squashes the viewport to about square. */
export const PHONE_SIDE_QUERY = "(pointer: coarse) and (min-aspect-ratio: 4/3) and (height < 30rem)"

/** Reads the side query synchronously, for one-shot decisions outside render. */
export function isPhoneSideViewport(): boolean {
  return window.matchMedia(PHONE_SIDE_QUERY).matches
}

/** The phone layout: a portrait phone (Tailwind's max-md) or a phone held sideways. */
export const PHONE_QUERY = `(width < 48rem), ${PHONE_SIDE_QUERY}`

export function isPhoneLayout(): boolean {
  return window.matchMedia(PHONE_QUERY).matches
}

/** Whether the app shows its phone UI: the map pill, detail panels and the live feed sheet. */
export function usePhoneLayout(): boolean {
  return useMediaQuery(PHONE_QUERY)
}

/** Whether that phone UI stands on the right edge instead of the bottom. */
export function usePhoneMapSide(): boolean {
  return useMediaQuery(PHONE_SIDE_QUERY)
}

export function usePortraitList(): boolean {
  return isPortraitList(useIsMobile(), usePhoneMapSide())
}
