/** The hub's own author, implied on most scenarios and left out of labels. */
const IMPLIED_AUTHOR = "crowdsecurity"
/** A hub-style id: one author, one name, no spaces. */
const AUTHOR_NAME_ID = /^[^\s/]+\/[^\s/]+$/
/** The reason GeoMetrikks gives a manual decision when the user leaves it blank. */
const DEFAULT_MANUAL_REASON = /^manual \S+ from GeoMetrikks$/

export interface ScenarioName {
  name: string
  /** Set when the author is not crowdsecurity. */
  author: string | null
  /** A manual decision's reason, unless it is the default one. */
  reason: string | null
}

/**
 * Splits "author/name: reason" into its parts for a compact label.
 * "crowdsecurity/http-probing" is just "http-probing", a CAPI name such as
 * "http:crawl" stays whole, and "geometrikks/manual-ban: spam" keeps both
 * the author and the reason.
 */
export function scenarioName(scenario: string): ScenarioName {
  // Only an "author/name" id carries an author, and a reason after it. Free
  // text, such as a cscli --reason that mentions a URL, is the whole label.
  const candidate = scenario.indexOf(": ")
  const id = candidate === -1 ? scenario : scenario.slice(0, candidate)
  if (!AUTHOR_NAME_ID.test(id)) return { name: scenario, author: null, reason: null }
  const reasonText = candidate === -1 ? "" : scenario.slice(candidate + 2).trim()
  const reason = reasonText && !DEFAULT_MANUAL_REASON.test(reasonText) ? reasonText : null
  const [author, name] = id.split("/")
  return { name, author: author === IMPLIED_AUTHOR ? null : author, reason }
}

/** The same parts as plain text, for places that can't render ScenarioLabel:
 *  "http-generic-403-bf (LePresidente)", "manual-ban (geometrikks): spam". */
export function scenarioText(scenario: string): string {
  const { name, author, reason } = scenarioName(scenario)
  return `${name}${author ? ` (${author})` : ""}${reason ? `: ${reason}` : ""}`
}
