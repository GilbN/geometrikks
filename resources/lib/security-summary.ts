import type { DecisionSplit, OriginCount } from "@/generated/api/types.gen"
import { formatNumber } from "@/lib/format-number"

/** Origins of decisions someone set by hand, from GeoMetrikks or cscli. */
const MANUAL_ORIGINS = new Set(["geometrikks", "cscli"])

export interface SplitPart {
  key: keyof DecisionSplit
  count: number
  label: string
  /** Background colour of the part's bar segment and legend dot. */
  className: string
}

const PARTS: readonly {
  key: keyof DecisionSplit
  one: string
  many: string
  className: string
}[] = [
  { key: "bans", one: "ban", many: "bans", className: "bg-red-500" },
  { key: "ranges", one: "range", many: "ranges", className: "bg-orange-500" },
  { key: "captchas", one: "captcha", many: "captchas", className: "bg-amber-500" },
  { key: "other", one: "other", many: "other", className: "bg-muted-foreground/60" },
]

/** The parts of the split that hold a decision, in bar order. */
export function splitParts(split: DecisionSplit): SplitPart[] {
  return PARTS.filter((part) => split[part.key] > 0).map((part) => ({
    key: part.key,
    count: split[part.key],
    label: `${formatNumber(split[part.key])} ${split[part.key] === 1 ? part.one : part.many}`,
    className: part.className,
  }))
}

/** "3 expire within 4 hours", or null when there is no decision to expire. */
export function expiryText(total: number, expiringSoon: number, hours: number): string | null {
  if (total === 0) return null
  const within = `within ${hours} ${hours === 1 ? "hour" : "hours"}`
  if (expiringSoon === 0) return `none expire ${within}`
  return `${formatNumber(expiringSoon)} ${expiringSoon === 1 ? "expires" : "expire"} ${within}`
}

export function setByHandCount(byOrigin: readonly OriginCount[]): number {
  return byOrigin
    .filter((origin) => MANUAL_ORIGINS.has(origin.origin))
    .reduce((sum, origin) => sum + origin.count, 0)
}

/** The day of the month in a `YYYY-MM-DD` date. */
export function dayOfMonth(date: string): number {
  return Number(date.slice(8, 10))
}

/** The week's total, with a plus when the server stopped counting. */
export function alertTotalText(total: number, capped: boolean): string {
  return `${formatNumber(total)}${capped ? "+" : ""}`
}

const COMPACT = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 })

/** A day's count above its bar, short enough for seven bars on a phone. Empty for zero. */
export function barLabel(count: number): string {
  if (!count) return ""
  return count < 1000 ? formatNumber(count) : COMPACT.format(count)
}
