import { useMediaQuery } from "@/hooks/use-media-query"

/** Tailwind's max-md query, so components that branch on useIsMobile agree
 *  with max-md: classes, also when the browser's font size isn't 16px. */
const MOBILE_QUERY = "(width < 48rem)"

/** Reads the breakpoint synchronously, for one-shot decisions outside render. */
export function isMobileViewport(): boolean {
  return window.matchMedia(MOBILE_QUERY).matches
}

export function useIsMobile() {
  return useMediaQuery(MOBILE_QUERY)
}
