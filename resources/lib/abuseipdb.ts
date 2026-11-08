import type { ReportedIpDto, ReportIpDto } from "@/generated/api/types.gen"
import { ipv6Value, parseIpv4Number, parseIpv6Groups } from "@/lib/drop-lists"
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

type ParsedIp = { version: 4; value: number } | { version: 6; groups: number[] }

/** An IPv4-mapped IPv6 address parses as its IPv4 address, as the backend reads it. */
function parseIp(ip: string): ParsedIp | null {
  const text = ip.trim()
  if (!text.includes(":")) {
    const value = parseIpv4Number(text)
    return value === null ? null : { version: 4, value }
  }
  const groups = parseIpv6Groups(text)
  if (groups === null) return null
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return { version: 4, value: groups[6] * 0x10000 + groups[7] }
  }
  return { version: 6, groups }
}

function formatIpv6(groups: readonly number[]): string {
  let bestStart = -1
  let bestLength = 1
  for (let start = 0; start < groups.length; ) {
    if (groups[start] !== 0) {
      start++
      continue
    }
    let end = start
    while (end < groups.length && groups[end] === 0) end++
    if (end - start > bestLength) {
      bestStart = start
      bestLength = end - start
    }
    start = end
  }
  const hex = groups.map((group) => group.toString(16))
  if (bestStart === -1) return hex.join(":")
  return `${hex.slice(0, bestStart).join(":")}::${hex.slice(bestStart + bestLength).join(":")}`
}

/** The address as Python's `ipaddress` prints it, which is how the backend keys reported IPs. Null when it isn't an address. */
export function canonicalIp(ip: string): string | null {
  const parsed = parseIp(ip)
  if (parsed === null) return null
  if (parsed.version === 6) return formatIpv6(parsed.groups)
  const value = parsed.value
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".")
}

function ipv4Range(cidr: string): [number, number] {
  const [address, prefix] = cidr.split("/")
  const size = 2 ** (32 - Number(prefix))
  const start = parseIpv4Number(address)!
  return [start, start + size - 1]
}

function ipv6Range(cidr: string): [bigint, bigint] {
  const [address, prefix] = cidr.split("/")
  const hostBits = BigInt(128 - Number(prefix))
  const start = ipv6Value(parseIpv6Groups(address)!)
  return [start, start | ((1n << hostBits) - 1n)]
}

// Python's private networks and their exceptions, plus CGNAT, which is_global
// also refuses. Multicast is refused here, though the backend's is_global takes it.
const NON_PUBLIC_V4 = [
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24",
  "192.0.0.170/31", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24",
  "224.0.0.0/4", "240.0.0.0/4", "255.255.255.255/32",
].map(ipv4Range)
const PUBLIC_V4_EXCEPTIONS = ["192.0.0.9/32", "192.0.0.10/32"].map(ipv4Range)
const NON_PUBLIC_V6 = [
  "::1/128", "::/128", "64:ff9b:1::/48", "100::/64", "2001::/23", "2001:db8::/32", "2002::/16", "3fff::/20", "fc00::/7",
  "fe80::/10", "ff00::/8",
].map(ipv6Range)
const PUBLIC_V6_EXCEPTIONS = [
  "2001:1::1/128", "2001:1::2/128", "2001:3::/32", "2001:4:112::/48", "2001:20::/28", "2001:30::/28",
].map(ipv6Range)

function inRanges<Address extends number | bigint>(ranges: [Address, Address][], value: Address): boolean {
  return ranges.some(([start, end]) => start <= value && value <= end)
}

/** Whether the backend's public-address check, Python's `is_global`, would take `ip`. Multicast is refused too. */
export function isPublicIp(ip: string): boolean {
  const parsed = parseIp(ip)
  if (parsed === null) return false
  if (parsed.version === 4) {
    return !inRanges(NON_PUBLIC_V4, parsed.value) || inRanges(PUBLIC_V4_EXCEPTIONS, parsed.value)
  }
  const value = ipv6Value(parsed.groups)
  return !inRanges(NON_PUBLIC_V6, value) || inRanges(PUBLIC_V6_EXCEPTIONS, value)
}

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
  const scenarioNames = [...new Set(scenarios.map((scenario) => scenarioName(scenario).name))]
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

/** "6 min ago", "2 h ago", "3 d ago", or "on 2026-10-28" past a week. */
export function agoText(at: string, now: number): string {
  return ageLabel(Math.max(0, now - Date.parse(at)), at)
}

/** How long until the item's countdown moves on, or null when nothing on it is counting down. */
export function reportedItemRefreshIn(entry: ReportedIpDto | undefined, now: number): number | null {
  if (!entry) return null
  const remainingMs = REPORT_INTERVAL_MS - Math.max(0, now - Date.parse(entry.reportedAt))
  if (remainingMs <= 0) return null
  return remainingMs % MINUTE_MS || MINUTE_MS
}

export function reportItemState(
  ip: string,
  entry: ReportedIpDto | undefined,
  now: number,
): { detail: string | null; disabled: boolean } {
  if (!isPublicIp(ip)) return { detail: "not a public address", disabled: true }
  return reportedItemState(entry, now)
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
