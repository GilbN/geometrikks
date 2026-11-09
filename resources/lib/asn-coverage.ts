/**
 * Shared math for the ASN origin split, used by the analytics Traffic origin
 * card and the dashboard KPI cards.
 *
 * Two denominators. The hosting share is of classified traffic, the only
 * traffic whose origin is known; coverage is against every request in the
 * range. The ASN aggregates exclude rows with no ASN data (history predating
 * enrichment, enrichment disabled, unresolvable IPs), so dividing by the
 * category sum alone reports 100% hosting on a mostly unenriched database.
 */

export interface AsnCategoryTotal {
  category: "drop" | "hosting" | "other"
  hits: number
}

export interface AsnCoverage {
  /** Requests carrying ASN data (drop + hosting + other). */
  classified: number
  /** Requests in range with no ASN data at all. */
  unenriched: number
  /** Hosting percentage of classified traffic; DROP-listed networks are not in it. */
  hostingShare: number
  /** DROP percentage of classified traffic, null while the DROP lists are not loaded. */
  dropShare: number | null
  dropHits: number
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
  const dropEntry = categories?.find((c) => c.category === "drop")
  const drop = dropEntry?.hits ?? 0
  const classified = hosting + other + drop
  // The totals and the ASN aggregates are two separate reads, so live
  // ingestion between them can leave classified slightly ahead of the range
  // total. Both figures are clamped so no caller renders "-12 unenriched"
  // or "105% of range".
  const unenriched = Math.max(0, totalRequests - classified)
  return {
    classified,
    unenriched,
    hostingShare: classified > 0 ? (hosting / classified) * 100 : 0,
    dropShare: dropEntry ? (classified > 0 ? (drop / classified) * 100 : 0) : null,
    dropHits: drop,
    coverage: totalRequests > 0 ? Math.min(100, (classified / totalRequests) * 100) : 0,
    hasData: classified > 0,
  }
}

export interface HeadlineAsnCategory {
  category: "drop" | "hosting"
  hits: number
}

/**
 * The larger of DROP and Hosting; a tie goes to DROP. Other is left out even
 * when it is the biggest, since it only means "not on either list".
 */
export function headlineAsnCategory(
  categories: readonly AsnCategoryTotal[] | undefined,
): HeadlineAsnCategory | undefined {
  let headline: HeadlineAsnCategory | undefined
  for (const category of ["drop", "hosting"] as const) {
    const hits = categories?.find((c) => c.category === category)?.hits
    if (hits !== undefined && (!headline || hits > headline.hits)) headline = { category, hits }
  }
  return headline
}
