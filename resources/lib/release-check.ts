import type { ReleaseCheckResponse } from "@/generated/api/types.gen"
import { hasUnseenRelease } from "@/lib/release-seen"

export type ReleaseCheckLine =
  | { kind: "available"; text: string; url: string }
  | { kind: "up-to-date"; text: string }

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

export const RELEASE_CHECK_PENDING_POLL_MS = 2 * MINUTE_MS
export const RELEASE_CHECK_POLL_MS = HOUR_MS

/**
 * How often to ask the server for the release check. The first check runs a
 * minute after startup, so poll every 2 minutes until it lands. After that the
 * server re-checks every 12 hours and an hourly poll is plenty. False means
 * the check is off and polling stops.
 */
export function releaseCheckPollMs(status: ReleaseCheckResponse["status"] | undefined): number | false {
  if (status === "off") return false
  if (status === "pending") return RELEASE_CHECK_PENDING_POLL_MS
  return RELEASE_CHECK_POLL_MS
}

const relativeTime = new Intl.RelativeTimeFormat("en", { numeric: "always" })

export function checkedAgo(checkedAt: string, nowMs: number): string {
  const elapsedMs = Math.max(0, nowMs - Date.parse(checkedAt))
  if (elapsedMs >= DAY_MS) return relativeTime.format(-Math.floor(elapsedMs / DAY_MS), "day")
  if (elapsedMs >= HOUR_MS) return relativeTime.format(-Math.floor(elapsedMs / HOUR_MS), "hour")
  return relativeTime.format(-Math.max(1, Math.floor(elapsedMs / MINUTE_MS)), "minute")
}

export function releaseCheckLine(
  releaseCheck: ReleaseCheckResponse | undefined,
  nowMs: number,
): ReleaseCheckLine | null {
  if (!releaseCheck || releaseCheck.status !== "checked") return null
  if (releaseCheck.latest) {
    return {
      kind: "available",
      text: `${releaseCheck.latest.displayVersion} is available`,
      url: releaseCheck.latest.url,
    }
  }
  if (!releaseCheck.checkedAt) return null
  return { kind: "up-to-date", text: `Up to date, checked ${checkedAgo(releaseCheck.checkedAt, nowMs)}` }
}

export function showsReleaseDot({
  reloadPending,
  latestVersion,
  seenVersion,
}: {
  reloadPending: boolean
  latestVersion: string | null
  seenVersion: string | null
}): boolean {
  return !reloadPending && hasUnseenRelease(seenVersion, latestVersion)
}

/** The releases a jump to the newest one would skip, or null when there are none. */
export function skippedReleasesText(newerReleaseCount: number, countIsExact: boolean): string | null {
  const skipped = newerReleaseCount - 1
  if (skipped < 1) return countIsExact ? null : "There may be more releases in between"
  if (!countIsExact) return `${skipped} or more releases in between`
  return `${skipped} more release${skipped === 1 ? "" : "s"} in between`
}
