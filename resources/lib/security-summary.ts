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

const MANUAL_ORIGINS = new Set(["geometrikks", "cscli"])
const COMMUNITY_ORIGINS = new Set(["CAPI", "lists"])

const originTotal = (byOrigin: readonly OriginCount[], origins: ReadonlySet<string>) =>
  byOrigin
    .filter((origin) => origins.has(origin.origin))
    .reduce((sum, origin) => sum + origin.count, 0)

/** Who made the decisions: someone by hand (GeoMetrikks or cscli), CrowdSec's
 *  own scenarios, or the community blocklists. */
export function originPhrases(byOrigin: readonly OriginCount[]): CountPhrase[] {
  return [
    { count: originTotal(byOrigin, MANUAL_ORIGINS), words: "set by hand" },
    { count: originTotal(byOrigin, new Set(["crowdsec"])), words: "detected by CrowdSec" },
    { count: originTotal(byOrigin, COMMUNITY_ORIGINS), words: "from blocklists" },
  ].filter((part) => part.count > 0)
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
