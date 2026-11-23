import type { DecisionSplit, OriginCount } from "@/generated/api/types.gen"
import { formatNumber } from "@/lib/format-number"
import { scenarioName } from "@/lib/scenario-name"

/** A count and the words that follow it, such as 12 and "bans". */
export interface CountPhrase {
  count: number
  words: string
}

const phrase = (count: number, one: string, many: string): CountPhrase => ({
  count,
  words: count === 1 ? one : many,
})

/** The parts of the split that hold a decision: bans, ranges, captchas, other. */
export function splitPhrases(split: DecisionSplit): CountPhrase[] {
  return [
    phrase(split.bans, "ban", "bans"),
    phrase(split.ranges, "range", "ranges"),
    phrase(split.captchas, "captcha", "captchas"),
    phrase(split.other, "other", "other"),
  ].filter((part) => part.count > 0)
}

/** How many decisions expire soon. A count of 0 reads as "None expire". */
export function expiryPhrase(expiringSoon: number, hours: number): CountPhrase {
  const within = `within ${hours} ${hours === 1 ? "hour" : "hours"}`
  return phrase(expiringSoon, `expires ${within}`, `expire ${within}`)
}

// The same split as DETECTION_ORIGINS in the reports API: these origins come
// from a detection or a blocklist, and every other one is a person's decision.
const DETECTED_ORIGINS = new Set(["crowdsec", "appsec"])
const BLOCKLIST_ORIGINS = new Set(["CAPI", "lists"])

/** Who made the decisions: CrowdSec's own detection, the community
 *  blocklists, or a person (GeoMetrikks, cscli, the Console or an import). */
export function originPhrases(byOrigin: readonly OriginCount[]): CountPhrase[] {
  let detected = 0
  let blocklists = 0
  let byHand = 0
  for (const origin of byOrigin) {
    if (DETECTED_ORIGINS.has(origin.origin)) detected += origin.count
    else if (BLOCKLIST_ORIGINS.has(origin.origin)) blocklists += origin.count
    else byHand += origin.count
  }
  return [
    { count: byHand, words: "set by hand" },
    { count: detected, words: "detected by CrowdSec" },
    { count: blocklists, words: "from blocklists" },
  ].filter((part) => part.count > 0)
}

/** Today's date in the browser's timezone, as `YYYY-MM-DD`. */
export function localDateKey(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: "short" })
const WEEKDAY_INITIAL = new Intl.DateTimeFormat(undefined, { weekday: "narrow" })

/** The weekday of a `YYYY-MM-DD` date, as a short name and as an initial. */
export function weekday(date: string): { short: string; initial: string } {
  const [year, month, day] = date.split("-").map(Number)
  const at = new Date(year, month - 1, day, 12)
  return { short: WEEKDAY.format(at), initial: WEEKDAY_INITIAL.format(at) }
}

/** The week's total, with a plus when the server stopped counting. */
export function alertTotalText(total: number, capped: boolean): string {
  return `${formatNumber(total)}${capped ? "+" : ""}`
}

const COMPACT = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 })

/** A day's count above its column, short enough for seven columns on a phone. */
export function barLabel(count: number): string {
  return count < 1000 ? formatNumber(count) : COMPACT.format(count)
}

export interface ScenarioRow {
  /** The decision type of a manual decision, such as `ban`, else null. */
  manualType: string | null
  label: string
}

/** One Top scenarios row. A manual decision shows its reason, and any
 *  other scenario shows its name. */
export function scenarioRow(scenario: string): ScenarioRow {
  const { name, author, reason } = scenarioName(scenario)
  if (author === "geometrikks" && name.startsWith("manual-"))
    return { manualType: name.slice("manual-".length), label: reason ?? "Set by hand" }
  return { manualType: null, label: name }
}
