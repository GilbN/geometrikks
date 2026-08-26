import { formatDuration } from "@/lib/api"

/** One sentence, reused wherever a timing is missing. */
export const TIMING_HINT = "No timing field in the log format."

/** Timings arrive in seconds; formatDuration takes milliseconds. */
export function formatDurationOrNa(seconds: number | null | undefined): string {
  if (seconds == null) return "n/a"
  return formatDuration(seconds * 1000)
}

export type TimingCoverage = { state: "none" | "partial" | "full"; percent: number }

/** How much of a range's requests carried a timing. */
export function timingCoverage(timed: number, total: number): TimingCoverage {
  if (timed <= 0 || total <= 0) return { state: "none", percent: 0 }
  if (timed >= total) return { state: "full", percent: 100 }
  return { state: "partial", percent: Math.round((timed / total) * 100) }
}
