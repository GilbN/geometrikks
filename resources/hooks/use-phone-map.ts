import { useMediaQuery } from "@/hooks/use-media-query"

/** A phone held sideways: a short touch screen at least 4:3 wide. The aspect
 *  ratio, not `orientation`, keeps out a portrait phone whose keyboard
 *  squashes the viewport to about square. */
export const PHONE_SIDE_QUERY = "(pointer: coarse) and (min-aspect-ratio: 4/3) and (height < 30rem)"

/** Reads the side query synchronously, for one-shot decisions outside render. */
export function isPhoneSideViewport(): boolean {
  return window.matchMedia(PHONE_SIDE_QUERY).matches
}

/** The phone map: a portrait phone (Tailwind's max-md) or a phone held sideways. */
const PHONE_MAP_QUERY = `(width < 48rem), ${PHONE_SIDE_QUERY}`

export function isPhoneMapViewport(): boolean {
  return window.matchMedia(PHONE_MAP_QUERY).matches
}

/** Whether the map shows its phone UI: the action card, detail panels and the live feed sheet. */
export function usePhoneMap(): boolean {
  return useMediaQuery(PHONE_MAP_QUERY)
}

/** Whether that phone UI stands on the right edge instead of the bottom. */
export function usePhoneMapSide(): boolean {
  return useMediaQuery(PHONE_SIDE_QUERY)
}
