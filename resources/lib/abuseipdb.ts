import type { ReportedIpDto, ReportIpDto } from "@/generated/api/types.gen"
import { scenarioName } from "@/lib/scenario-name"

export const ABUSEIPDB_CATEGORIES: { id: number; name: string }[] = [
  "DNS Compromise",
  "DNS Poisoning",
  "Fraud Orders",
  "DDoS Attack",
  "FTP Brute-Force",
  "Ping of Death",
  "Phishing",
  "Fraud VoIP",
  "Open Proxy",
  "Web Spam",
  "Email Spam",
  "Blog Spam",
  "VPN IP",
  "Port Scan",
  "Hacking",
  "SQL Injection",
  "Spoofing",
  "Brute-Force",
  "Bad Web Bot",
  "Exploited Host",
  "Web App Attack",
  "SSH",
  "IoT Targeted",
].map((name, index) => ({ id: index + 1, name }))

export const FEATURED_CATEGORY_IDS = [21, 19, 15, 16, 18, 14, 9, 10]
export const FALLBACK_CATEGORY_IDS = [19, 21]
export const MAX_COMMENT_LENGTH = 1024
export const REPORT_INTERVAL_MS = 15 * 60_000

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
/** What the backend sends for every alert or decision a person made. */
const MANUAL_SCENARIO = "manual"
const COUNTED_DECISION_ORIGINS = new Set(["crowdsec", "appsec"])

const SCENARIO_CATEGORY_RULES: { needles: string[]; ids: number[] }[] = [
  { needles: ["sqli"], ids: [16, 21] },
  {
    needles: [
      "xss",
      "http-probing",
      "http-sensitive-files",
      "http-cve",
      "http-backdoors",
      "path-traversal",
      "wordpress-scan",
      "appsec",
      "vpatch",
    ],
    ids: [21],
  },
  { needles: ["http-bad-user-agent", "http-crawl"], ids: [19] },
  { needles: ["ssh"], ids: [22, 18] },
  { needles: ["bf", "bruteforce"], ids: [18] },
  { needles: ["port-scan", "portscan"], ids: [14] },
  { needles: ["open-proxy"], ids: [9] },
]

export function abuseipdbCheckUrl(ip: string): string {
  return `https://www.abuseipdb.com/check/${ip}`
}

export function commentLength(text: string): number {
  return [...text].length
}

export function localScenarios(ip: ReportIpDto): string[] {
  const scenarios = [
    ...ip.alerts.map((alert) => alert.scenario),
    ...ip.decisions.filter((decision) => COUNTED_DECISION_ORIGINS.has(decision.origin)).map((decision) => decision.scenario),
  ]
  return [...new Set(scenarios.filter((scenario) => scenario && scenario !== MANUAL_SCENARIO))]
}

export function categoriesForScenarios(scenarios: string[]): { ids: number[]; fromCrowdsec: boolean } {
  const matched = new Set<number>()
  for (const scenario of scenarios) {
    // A manual scenario is free text from a person, so its words say nothing about the attack.
    if (scenario.startsWith("manual")) continue
    const lowered = scenario.toLowerCase()
    for (const rule of SCENARIO_CATEGORY_RULES) {
      if (rule.needles.some((needle) => lowered.includes(needle))) rule.ids.forEach((id) => matched.add(id))
    }
  }
  if (matched.size === 0) return { ids: [...FALLBACK_CATEGORY_IDS], fromCrowdsec: false }
  return { ids: [...matched].sort((first, second) => first - second), fromCrowdsec: true }
}

export function defaultAttackTime(ip: ReportIpDto): string | null {
  if (ip.firstSeen) return ip.firstSeen
  const alertStarts = ip.alerts.flatMap((alert) => (alert.startAt ? [alert.startAt] : []))
  if (alertStarts.length === 0) return null
  return alertStarts.reduce((earliest, start) => (Date.parse(start) < Date.parse(earliest) ? start : earliest))
}

function utcDateTime(iso: string): string {
  return new Date(iso).toISOString().slice(0, 16).replace("T", " ")
}

function requestCountPart(ip: ReportIpDto): string | null {
  if (ip.totalRequests <= 0) return null
  const counts = `${ip.totalRequests} HTTP requests`
  const answered = `${ip.status4xx} answered 4xx.`
  if (!ip.firstSeen) return `${counts}, ${answered}`
  const first = utcDateTime(ip.firstSeen)
  const last = utcDateTime(ip.lastSeen ?? ip.firstSeen)
  const lastLabel = first.slice(0, 10) === last.slice(0, 10) ? last.slice(11) : last
  return `${counts} ${first} to ${lastLabel} UTC, ${answered}`
}

export function buildReportComment(ip: ReportIpDto, scenarios: string[]): string {
  const countPart = requestCountPart(ip)
  const scenarioNames = scenarios.map((scenario) => scenarioName(scenario).name)
  const probedPaths = ip.paths.filter((path) => path.errorHits > 0).map((path) => path.url)
  const userAgent = ip.userAgents[0]?.userAgent
  const userAgentPart = userAgent ? `User agent: ${userAgent}.` : null

  const assemble = (kept: { scenarios: string[]; paths: string[]; withUserAgent: boolean }) =>
    [
      countPart,
      kept.paths.length ? `Probed ${kept.paths.join(", ")}.` : null,
      kept.withUserAgent ? userAgentPart : null,
      kept.scenarios.length ? `CrowdSec: ${kept.scenarios.join(", ")}.` : null,
    ]
      .filter((part) => part !== null)
      .join(" ")
  const fits = (kept: Parameters<typeof assemble>[0]) => commentLength(assemble(kept)) <= MAX_COMMENT_LENGTH

  const kept = { scenarios: [] as string[], paths: [] as string[], withUserAgent: false }
  for (const name of scenarioNames) {
    if (!fits({ ...kept, scenarios: [...kept.scenarios, name] })) break
    kept.scenarios.push(name)
  }
  for (const path of probedPaths) {
    if (!fits({ ...kept, paths: [...kept.paths, path] })) break
    kept.paths.push(path)
  }
  kept.withUserAgent = userAgentPart !== null && fits({ ...kept, withUserAgent: true })
  return assemble(kept)
}

function ageLabel(ageMs: number, reportedAt: string): string {
  if (ageMs < HOUR_MS) return `${Math.floor(ageMs / MINUTE_MS)} min ago`
  if (ageMs < DAY_MS) return `${Math.floor(ageMs / HOUR_MS)} h ago`
  if (ageMs < 7 * DAY_MS) return `${Math.floor(ageMs / DAY_MS)} d ago`
  return `on ${new Date(reportedAt).toISOString().slice(0, 10)}`
}

export function reportedItemState(
  entry: ReportedIpDto | undefined,
  now: number,
): { detail: string | null; disabled: boolean } {
  if (!entry) return { detail: null, disabled: false }
  const ageMs = Math.max(0, now - Date.parse(entry.reportedAt))
  if (ageMs < REPORT_INTERVAL_MS) {
    const minutesLeft = Math.ceil((REPORT_INTERVAL_MS - ageMs) / MINUTE_MS)
    return { detail: `again in ${minutesLeft} min`, disabled: true }
  }
  const verb = entry.status === "unconfirmed" ? "may have been sent" : "reported"
  return { detail: `${verb} ${ageLabel(ageMs, entry.reportedAt)}`, disabled: false }
}
