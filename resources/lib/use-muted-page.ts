import { useCallback } from "react"
import { useMutedIpsList } from "./queries"
import { mutedScope, useMutedIpsHidden, useMutedVersion, type MutedScope } from "./muted-ips"
import { useTimeRange } from "./time-range-context"

/**
 * A flip of the switch is the one thing that sends a paged page back to
 * page 1; a version change only clamps the page, so it never goes through here.
 */
export function makeToggleMuted(
  hidden: boolean,
  setHidden: (on: boolean) => void,
  patchSearch?: (patch: { page: undefined }) => void,
) {
  return () => {
    setHidden(!hidden)
    patchSearch?.({ page: undefined })
  }
}

/**
 * A changed hidden set can leave the current page past the last one. This
 * only ever moves down to the last page; it never resets to page 1.
 */
export function pageToClamp(args: {
  loaded: boolean
  placeholder: boolean
  page: number
  pageCount: number
}): number | null {
  const { loaded, placeholder, page, pageCount } = args
  return loaded && !placeholder && page > pageCount ? pageCount : null
}

/** The page-level muted scope: mounts the list observer and the switch for one route. */
export function useMutedPage(
  hasIpInclude: boolean,
  patchSearch?: (patch: { page: undefined }) => void,
): { muted: MutedScope; toggleMuted: () => void } {
  const { refetchInterval } = useTimeRange()
  useMutedIpsList(refetchInterval)
  const { version, count } = useMutedVersion()
  const [hidden, setHidden] = useMutedIpsHidden()
  const muted = mutedScope({ switchOn: hidden, version, count, hasIpInclude })
  const toggleMuted = useCallback(
    () => makeToggleMuted(hidden, setHidden, patchSearch)(),
    [hidden, setHidden, patchSearch],
  )
  return { muted, toggleMuted }
}
