import { formatDuration } from "@/lib/api"

/** One sentence, reused wherever a timing is missing. */
export const TIMING_HINT = "No timing field in the log format."

/** Timings arrive in seconds; formatDuration takes milliseconds. */
export function formatDurationOrNa(seconds: number | null | undefined): string {
  if (seconds == null) return "n/a"
  return formatDuration(seconds * 1000)
}

export type TimingCoverage = { state: "empty" | "none" | "partial" | "full"; percent: number }

/** How much of a range's requests carried a timing. "empty" is a range with
 * no requests at all, which says nothing about the log format. */
export function timingCoverage(timed: number, total: number): TimingCoverage {
  if (total <= 0) return { state: "empty", percent: 0 }
  if (timed <= 0) return { state: "none", percent: 0 }
  if (timed >= total) return { state: "full", percent: 100 }
  return { state: "partial", percent: Math.round((timed / total) * 100) }
}
