/**
 * Shared math for the ASN origin split, used by the analytics Traffic origin
 * card and the dashboard KPI cards.
 *
 * Two denominators, deliberately. The hosting share is of CLASSIFIED
 * traffic, the only traffic whose origin is known; coverage is against every
 * request in the range. The ASN aggregates exclude rows with no ASN data
 * (history predating enrichment, enrichment disabled, unresolvable IPs), so
 * dividing by the category sum alone reports "100% hosting" on a database
 * that is mostly unenriched.
 */

export interface AsnCategoryTotal {
  category: "hosting" | "other"
  hits: number
}

export interface AsnCoverage {
  /** Requests carrying ASN data (hosting + other). */
  classified: number
  /** Requests in range with no ASN data at all. */
  unenriched: number
  /** Hosting percentage OF CLASSIFIED traffic. */
  hostingShare: number
  /** Percentage of the range's requests that carry ASN data. */
  coverage: number
  /** False when nothing in the range is classified: callers show an empty state. */
  hasData: boolean
}

export function asnCoverage(
  categories: readonly AsnCategoryTotal[] | undefined,
  totalRequests: number,
): AsnCoverage {
  const hosting = categories?.find((c) => c.category === "hosting")?.hits ?? 0
  const other = categories?.find((c) => c.category === "other")?.hits ?? 0
  const classified = hosting + other
  // The totals and the ASN aggregates are two separate reads, so live
  // ingestion between them can leave classified marginally ahead of the
  // range total. Both derived figures are clamped to their physical range so
  // no caller can render "-12 unenriched" or "105% of range".
  const unenriched = Math.max(0, totalRequests - classified)
  return {
    classified,
    unenriched,
    hostingShare: classified > 0 ? (hosting / classified) * 100 : 0,
    coverage: totalRequests > 0 ? Math.min(100, (classified / totalRequests) * 100) : 0,
    hasData: classified > 0,
  }
}
