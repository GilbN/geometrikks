/**
 * Plain-text and CSV renderings of an abuse report, written for a hosting
 * provider's abuse desk. All times are UTC. The backend has already removed
 * the operator's names, referrers, app credentials and manual ban reasons.
 */
import type {
  AbuseContactResponse,
  AbuseReportResponse,
  ReportAlertDto,
  ReportDecisionDto,
  ReportIpDto,
  ReportLineDto,
} from "@/generated/api/types.gen"
import { SIGNAL_THRESHOLDS } from "@/components/ip-inspector/signals"
import { goDurationMs } from "@/lib/crowdsec-alerts"

/** CrowdSec scenarios named in the opening paragraph of an ASN report. */
const SUMMARY_SCENARIOS = 6
const MANUAL = "manual"

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** Prose wraps at the plain-text email width; tables and log lines do not. */
export const WRAP_WIDTH = 76

/** Greedy word wrap. Continuation lines start with `indent`; a word longer
 *  than the width keeps its own line rather than being split. */
export function wrap(text: string, indent = "", width = WRAP_WIDTH): string[] {
  const lines: string[] = []
  let line = ""
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const prefix = lines.length ? indent : ""
    if (line && prefix.length + line.length + 1 + word.length > width) {
      lines.push(prefix + line)
      line = word
    } else {
      line = line ? `${line} ${word}` : word
    }
  }
  if (line) lines.push((lines.length ? indent : "") + line)
  return lines
}

const bullet = (text: string) => wrap(`- ${text}`, "  ")

const count = (n: number) => n.toLocaleString("en-US")
const plural = (n: number, word: string, many = `${word}s`) => `${count(n)} ${n === 1 ? word : many}`
const pct = (part: number, whole: number) => `${Math.round((part / whole) * 100)}%`

/** "2026-09-26 20:20:42" in UTC; unparseable input passes through. */
export function utc(iso: string, precision: "seconds" | "minutes" = "seconds"): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toISOString().replace("T", " ").slice(0, precision === "seconds" ? 19 : 16)
}

/** "[26/Sep/2026:20:20:42 +0000]", the timestamp of the combined log format. */
function clfTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return `[${iso}]`
  const pad = (n: number) => String(n).padStart(2, "0")
  return `[${pad(d.getUTCDate())}/${MONTHS[d.getUTCMonth()]}/${d.getUTCFullYear()}:${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000]`
}

/** Control characters and Unicode line breaks as \xHH or \uHHHH, the way
 *  nginx escapes them. A client-sent newline in a path or user agent would
 *  otherwise forge report lines. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/g
export const printable = (value: string) =>
  value.replace(CONTROL_CHARS, (c) => {
    const code = c.charCodeAt(0)
    return code > 0xff ? `\\u${code.toString(16).padStart(4, "0")}` : `\\x${code.toString(16).toUpperCase().padStart(2, "0")}`
  })

// Besides control characters, only quotes are escaped. nginx already stored
// its own \x escapes, and doubling their backslashes would change what the
// client sent.
const quoted = (value: string | null) => (value ? `"${printable(value).replace(/"/g, '\\"')}"` : '"-"')

/** One line in the combined log format, with the referrer withheld. */
export function logLine(ip: string, line: ReportLineDto): string {
  const request = [line.method ?? "-", line.url ?? "-", line.httpVersion].filter(Boolean).join(" ")
  return [
    ip,
    "- -",
    clfTime(line.timestamp),
    quoted(request),
    line.statusCode ?? "-",
    line.bytesSent ?? "-",
    '"-"',
    quoted(line.userAgent),
  ].join(" ")
}

export interface DecisionGroup {
  type: string
  /** The longest time left among the type's decisions, as Go prints it. */
  duration: string
  /** Distinct scenarios in first-seen order; "manual" for manual decisions. */
  scenarios: string[]
}

/** One entry per decision type. An IP holds a decision for every scenario
 *  it tripped, and repeat offences add more, so the raw list repeats. */
export function groupDecisions(decisions: ReportDecisionDto[]): DecisionGroup[] {
  const groups = new Map<string, DecisionGroup & { ms: number }>()
  for (const d of decisions) {
    const ms = goDurationMs(d.duration) ?? 0
    const group = groups.get(d.type) ?? { type: d.type, duration: d.duration, scenarios: [], ms }
    if (ms > group.ms) Object.assign(group, { duration: d.duration, ms })
    if (!group.scenarios.includes(d.scenario)) group.scenarios.push(d.scenario)
    groups.set(d.type, group)
  }
  return [...groups.values()].map(({ type, duration, scenarios }) => ({ type, duration, scenarios }))
}

export interface ScenarioSummary {
  scenario: string
  detections: number
  events: number
  first: string
  last: string
}

/** Detections per scenario, busiest first; alerts arrive oldest first. */
export function summarizeAlerts(alerts: ReportAlertDto[]): ScenarioSummary[] {
  const byScenario = new Map<string, ScenarioSummary>()
  for (const alert of alerts) {
    const at = alert.startAt ?? alert.createdAt
    const summary = byScenario.get(alert.scenario)
    if (summary) {
      summary.detections += 1
      summary.events += alert.eventsCount
      // Compared as parsed times, because LAPI times carry nanoseconds and
      // "10:00:00.5Z" sorts before "10:00:00Z" as a string.
      if (Date.parse(at) < Date.parse(summary.first)) summary.first = at
      if (Date.parse(at) > Date.parse(summary.last)) summary.last = at
    } else {
      byScenario.set(alert.scenario, { scenario: alert.scenario, detections: 1, events: alert.eventsCount, first: at, last: at })
    }
  }
  return [...byScenario.values()].sort((a, b) => b.detections - a.detections || a.scenario.localeCompare(b.scenario))
}

/** "3h12m" from Go's "3h12m5.123s"; long bans keep only hours and minutes. */
function shortDuration(value: string): string {
  const ms = goDurationMs(value)
  if (ms === null) return value
  const minutes = Math.max(1, Math.round(ms / 60_000))
  const hours = Math.floor(minutes / 60)
  return hours ? `${hours}h${String(minutes % 60).padStart(2, "0")}m` : `${minutes}m`
}

/** The IP's CrowdSec scenarios, manual decisions left out. */
function detectedScenarios(ip: ReportIpDto): Set<string> {
  const names = new Set<string>()
  for (const a of ip.alerts) if (a.scenario !== MANUAL) names.add(a.scenario)
  for (const d of ip.decisions) if (d.scenario !== MANUAL) names.add(d.scenario)
  return names
}

/** Sentences describing the traffic, gated by the inspector's chip thresholds. */
export function behaviorFindings(ip: ReportIpDto, granularity: "hourly" | "daily"): string[] {
  const t = SIGNAL_THRESHOLDS
  const total = ip.totalRequests
  const out: string[] = []
  if (total >= t.errorShareMinRequests && ip.status4xx / total >= t.errorShareMin) {
    out.push(`${pct(ip.status4xx, total)} of the requests got a 4xx response, so they asked for paths that do not exist or that the server refuses.`)
  }
  if (ip.distinctPaths >= t.distinctPathsMin) {
    out.push(`It requested ${count(ip.distinctPaths)} distinct paths, a pattern of automated scanning.`)
  }
  if (ip.peak && total >= t.burstMinRequests && ip.peak.hits / total >= t.burstShare) {
    const span = granularity === "hourly" ? "hour" : "day"
    const start = granularity === "hourly" ? utc(ip.peak.timestamp, "minutes") : utc(ip.peak.timestamp).slice(0, 10)
    out.push(`${count(ip.peak.hits)} of the requests (${pct(ip.peak.hits, total)}) arrived in the ${span} starting ${start} UTC.`)
  }
  if (ip.malformedRequests > 0) {
    out.push(`${plural(ip.malformedRequests, "request")} ${ip.malformedRequests === 1 ? "was" : "were"} not valid HTTP.`)
  }
  return out
}

function scenarioLine(summary: ScenarioSummary): string {
  const name = summary.scenario === MANUAL ? "manual decision" : summary.scenario
  const when = summary.detections === 1
    ? `at ${utc(summary.first)}`
    : `${utc(summary.first, "minutes")} to ${utc(summary.last, "minutes")}`
  return `- ${name}: ${plural(summary.detections, "detection")}, ${plural(summary.events, "event")}, ${when}`
}

function networkLabel(ip: ReportIpDto): string | null {
  const parts = []
  if (ip.asn != null) parts.push(`AS${ip.asn}${ip.asnOrganization ? ` ${ip.asnOrganization}` : ""}`)
  if (ip.countryCode) parts.push(ip.countryCode)
  return parts.length ? parts.join(", ") : null
}

function ipSection(ip: ReportIpDto, report: AbuseReportResponse): string[] {
  const out = [`== ${ip.ipAddress} ==`]
  const network = networkLabel(ip)
  if (network) out.push(`Network: ${network}`)
  if (ip.totalRequests === 0) {
    out.push("No requests from this address in the reporting period.")
  } else {
    out.push(
      `Activity: ${plural(ip.totalRequests, "request")} from ${utc(ip.firstSeen ?? "")} to ${utc(ip.lastSeen ?? "")} UTC`,
      `Responses: 2xx ${count(ip.status2xx)}, 3xx ${count(ip.status3xx)}, 4xx ${count(ip.status4xx)}, 5xx ${count(ip.status5xx)}`,
    )
    const findings = behaviorFindings(ip, report.granularity)
    if (findings.length) out.push("Behavior:", ...findings.flatMap(bullet))
  }

  if (ip.alerts.length) {
    const scope = ip.alertsTruncated ? `, newest ${ip.alerts.length} only` : ""
    out.push(`CrowdSec detections (UTC${scope}):`, ...summarizeAlerts(ip.alerts).map(scenarioLine))
  } else if (ip.alertsTruncated) {
    out.push("CrowdSec detections: too many to fetch for this period.")
  }
  const decisions = groupDecisions(ip.decisions)
  if (decisions.length) {
    out.push(
      "Active CrowdSec decisions:",
      ...decisions.map((d) => {
        const reasons = d.scenarios.filter((name) => name !== MANUAL)
        const manual = reasons.length < d.scenarios.length ? "manual" : null
        const why = [reasons.join(", "), manual].filter(Boolean).join(", ")
        return bullet(`${d.type} for ${shortDuration(d.duration)} more: ${why}`)
      }).flat(),
    )
  }

  if (ip.paths.length) {
    const width = Math.max(...ip.paths.map((p) => count(p.hits).length))
    out.push("Most requested paths:", ...ip.paths.map((p) => `  ${count(p.hits).padStart(width)}  ${printable(p.url)}`))
  }
  if (ip.userAgents.length) {
    const width = Math.max(...ip.userAgents.map((u) => count(u.hits).length))
    out.push("User agents:", ...ip.userAgents.map((u) => `  ${count(u.hits).padStart(width)}  ${printable(u.userAgent)}`))
  }
  if (ip.lines.length) {
    const of = ip.lines.length < ip.totalRequests ? `newest ${count(ip.lines.length)} of ${count(ip.totalRequests)}` : `all ${count(ip.lines.length)}`
    out.push(`Log excerpt (${of} lines, UTC, target host and referrer withheld):`, ...ip.lines.map((l) => logLine(ip.ipAddress, l)))
  }
  return out
}

function targetLabel(report: AbuseReportResponse): string {
  const { target } = report
  if (target.kind === "asn") return `AS${target.asn}${target.asnOrganization ? ` (${target.asnOrganization})` : ""}`
  return target.ipAddress ?? ""
}

function summaryTable(ips: ReportIpDto[]): string[] {
  const rows = ips.map((ip) => {
    const scenarios = [...detectedScenarios(ip)]
    const crowdsec = scenarios.length > 2 ? `${scenarios.slice(0, 2).join(", ")}, +${scenarios.length - 2}` : scenarios.join(", ")
    return [
      ip.ipAddress,
      count(ip.totalRequests),
      ip.totalRequests ? pct(ip.status4xx, ip.totalRequests) : "-",
      ip.firstSeen ? utc(ip.firstSeen, "minutes") : "-",
      ip.lastSeen ? utc(ip.lastSeen, "minutes") : "-",
      crowdsec || "-",
    ]
  })
  const header = ["IP address", "Requests", "4xx", "First seen (UTC)", "Last seen (UTC)", "CrowdSec"]
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)))
  const numeric = new Set([1, 2])
  const render = (cells: string[]) =>
    cells.map((cell, i) => (i === cells.length - 1 ? cell : numeric.has(i) ? cell.padStart(widths[i]) : cell.padEnd(widths[i]))).join("  ").trimEnd()
  return [render(header), ...rows.map(render)]
}

/** The opening paragraph: who, how much, when, and what CrowdSec saw. */
function opening(report: AbuseReportResponse): string[] {
  const period = `between ${utc(report.startDate, "minutes")} and ${utc(report.endDate, "minutes")} UTC`
  const ips = report.ips
  const lines: string[] = []

  if (report.target.kind === "asn") {
    lines.push(
      `${plural(report.ipCount, "IP address", "IP addresses")} in ${targetLabel(report)} sent ${plural(report.totalRequests, "HTTP request")} to a web server I operate ${period}.`,
    )
  } else {
    const ip = ips[0]
    const network = ip ? networkLabel(ip) : null
    const sent = report.totalRequests ? plural(report.totalRequests, "HTTP request") : "no HTTP requests"
    lines.push(
      `The IP address ${targetLabel(report)}${network ? ` (${network})` : ""} sent ${sent} to a web server I operate ${period}.`,
    )
  }
  const total = report.totalRequests
  if (total >= SIGNAL_THRESHOLDS.errorShareMinRequests && report.status4xx / total >= SIGNAL_THRESHOLDS.errorShareMin) {
    lines.push(`${pct(report.status4xx, total)} of those requests got a 4xx response, which points to automated scanning rather than normal visits.`)
  }

  const byScenario = new Map<string, number>()
  let flagged = 0
  for (const ip of ips) {
    const names = detectedScenarios(ip)
    if (names.size) flagged += 1
    for (const name of names) byScenario.set(name, (byScenario.get(name) ?? 0) + 1)
  }
  if (flagged) {
    const top = [...byScenario.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, SUMMARY_SCENARIOS)
    const names = top.map(([name, n]) => (report.target.kind === "asn" ? `${name} (${n})` : name)).join(", ")
    const who = report.target.kind !== "asn"
      ? "it"
      : flagged === ips.length
        ? ips.length === 1 ? "the address listed below" : `all ${count(ips.length)} addresses listed below`
        : `${flagged} of the ${plural(ips.length, "address", "addresses")} listed below`
    const more = byScenario.size > top.length ? `, and ${byScenario.size - top.length} more` : ""
    lines.push(`CrowdSec flagged ${who} for ${names}${more}.`)
  }
  if (report.totalRequests || flagged) lines.push("Please investigate and stop this activity.")
  return wrap(lines.join(" "))
}

/** The report as plain text for an email body or an abuse form. */
export function formatAbuseReportText(report: AbuseReportResponse, contact?: AbuseContactResponse | null): string {
  const out: string[] = []
  const days = `${utc(report.startDate).slice(0, 10)} to ${utc(report.endDate).slice(0, 10)}`
  const scope = report.target.kind === "asn" ? `, ${plural(report.ipCount, "IP", "IPs")}` : ""
  out.push(`Subject: Abuse report for ${targetLabel(report)}${scope}, ${days}`)
  if (contact?.abuseEmails.length) out.push(`To: ${contact.abuseEmails.join(", ")}`)
  out.push("", "Hello,", "", ...opening(report), "")

  if (report.target.kind === "asn" && report.ips.length) {
    const partial = report.ipCount > report.ips.length
    out.push(
      partial
        ? `The ${plural(report.ips.length, "busiest address", "busiest addresses")} of the ${count(report.ipCount)}:`
        : "The addresses:",
      "",
      ...summaryTable(report.ips),
      "",
    )
  }
  if (contact && (contact.name || contact.cidrs.length)) {
    const holder = [contact.name, contact.handle && contact.handle !== contact.name ? contact.handle : null].filter(Boolean).join(" / ")
    const range = contact.cidrs.length ? contact.cidrs.join(", ") : [contact.startAddress, contact.endAddress].filter(Boolean).join(" - ")
    out.push(`Registry record (${contact.registry}): ${[holder, range].filter(Boolean).join(", ")}`, "")
  }
  out.push(...wrap("All times are UTC. The target host is withheld; I can confirm it on request."), "")

  for (const ip of report.ips) out.push(...ipSection(ip, report), "")
  return `${out.join("\n").trimEnd()}\n`
}

/** Spreadsheets run cells that start with these as formulas. */
const FORMULA_START = /^[=+\-@\t\r]/

function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ""
  let text = String(value)
  if (typeof value === "string" && FORMULA_START.test(text)) text = `'${text}`
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export const CSV_COLUMNS = [
  "timestamp_utc",
  "source_ip",
  "asn",
  "as_organization",
  "country",
  "method",
  "path",
  "http_version",
  "status",
  "bytes",
  "user_agent",
] as const

/** Every log line in the report, one row each, for providers that ask for CSV. */
export function formatAbuseReportCsv(report: AbuseReportResponse): string {
  const rows = [CSV_COLUMNS.join(",")]
  for (const ip of report.ips) {
    for (const line of ip.lines) {
      rows.push(
        [
          new Date(line.timestamp).toISOString(),
          ip.ipAddress,
          ip.asn,
          ip.asnOrganization,
          ip.countryCode,
          line.method,
          line.url,
          line.httpVersion,
          line.statusCode,
          line.bytesSent,
          line.userAgent,
        ]
          .map(csvCell)
          .join(","),
      )
    }
  }
  return `${rows.join("\r\n")}\r\n`
}

/** A file name such as "abuse-report-AS396982-2026-09-26.txt". */
export function reportFileName(report: AbuseReportResponse, extension: "txt" | "csv"): string {
  const target = report.target.kind === "asn" ? `AS${report.target.asn}` : (report.target.ipAddress ?? "ip").replace(/:/g, "-")
  return `abuse-report-${target}-${utc(report.endDate).slice(0, 10)}.${extension}`
}
