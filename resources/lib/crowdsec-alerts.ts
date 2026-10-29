/** Shaping helpers for the CrowdSec alert history and detail sheet. */
import type { AlertContextView, AlertEventView, AlertView, ScenarioCount } from "@/generated/api/types.gen"
import { scenarioName } from "@/lib/scenario-name"

/** Alerts per page of the alert history; "Load older" fetches another page this size. */
export const ALERT_PAGE_SIZE = 50

/** Pages the alert history loads at most. Every row mounts its own ban
 *  controls, and a few thousand rows exhaust the browser tab. */
export const ALERT_MAX_PAGES = 20

export type AlertKindFilter = "all" | "crowdsec" | "waf" | "bot"

// The kinds an engine produces on its own. Blocklist pulls are left out of
// the history already, and Console orders are rare enough to live under All.
export const ALERT_KIND_OPTIONS: readonly { key: AlertKindFilter; label: string; description: string | null }[] = [
  { key: "all", label: "All kinds", description: null },
  {
    key: "crowdsec",
    label: "Log scenarios",
    description: "A scenario overflowed on your logs. Most bans come from here.",
  },
  { key: "waf", label: "WAF", description: "An AppSec rule matched a request. Many never ban." },
  { key: "bot", label: "Bot detection", description: "Bot challenge rejections and the bans they lead to." },
]

export const KIND_FILTER_NEEDS_NOTE = "Filtering by kind needs CrowdSec 1.7 or newer."

export const BOT_SCENARIO_NOTE = "Bot detection already picks its own scenarios."

const EMPTY_MESSAGES: Record<AlertKindFilter, string> = {
  all: "No alerts in this window.",
  crowdsec: "No alerts of this kind in this window.",
  waf: "No WAF alerts in this window. WAF alerts need AppSec enabled on a bouncer.",
  bot: "No bot challenge alerts in this window. The bot challenge needs CrowdSec 1.8 and a bouncer that supports it.",
}

/** The backend rejects the bot group combined with a scenario filter. */
export function scenarioFilterAllowed(kind: AlertKindFilter): boolean {
  return kind !== "bot"
}

/** Scenarios the alert history filters by at once; the backend rejects more. */
export const MAX_ALERT_SCENARIOS = 5

/** The scenario picker's options: the counted scenarios, then any picked
 *  one the count missed. */
export function scenarioOptions(counts: readonly ScenarioCount[] | undefined, selected: readonly string[]): string[] {
  const counted = (counts ?? []).map((scenarioCount) => scenarioCount.scenario)
  const countedNames = new Set(counted)
  return [...counted, ...selected.filter((scenario) => !countedNames.has(scenario))]
}

function scenarioShortName(scenario: string): string {
  return scenarioName(scenario).name
}

/** "http-probing · 41", or the bare name while the count is unknown. */
export function scenarioOptionLabel(scenario: string, count: number | undefined): string {
  const name = scenarioShortName(scenario)
  return count === undefined ? name : `${name} · ${count}`
}

export type AlertFilterGroup = "kind" | "scenario" | "ip"

/** One entry per filter group in use, in the order the filter chips show them. */
export function activeAlertFilters({
  kind,
  scenarios,
  ip,
}: {
  kind: AlertKindFilter
  scenarios: readonly string[]
  ip: string | undefined
}): { group: AlertFilterGroup; label: string }[] {
  const active: { group: AlertFilterGroup; label: string }[] = []
  if (kind !== "all") {
    active.push({ group: "kind", label: ALERT_KIND_OPTIONS.find((option) => option.key === kind)?.label ?? kind })
  }
  if (scenarios.length === 1) {
    active.push({ group: "scenario", label: `Scenario: ${scenarioShortName(scenarios[0])}` })
  } else if (scenarios.length > 1) {
    active.push({ group: "scenario", label: `${scenarios.length} scenarios` })
  }
  if (ip) active.push({ group: "ip", label: ip })
  return active
}

/** The new pick, or the current one when the new pick passes the cap. */
export function pickScenarios(current: string[], next: string[]): string[] {
  return next.length > MAX_ALERT_SCENARIOS ? current : next
}

/** Filters after "Show only this scenario": the bot group takes no scenario. */
export function onlyScenario(
  kind: AlertKindFilter,
  scenario: string,
): { kind: AlertKindFilter; scenarios: string[] } {
  return { kind: scenarioFilterAllowed(kind) ? kind : "all", scenarios: [scenario] }
}

/** What the alert history says when the selected kind has no alerts. */
export function alertsEmptyMessage(kind: AlertKindFilter): string {
  return EMPTY_MESSAGES[kind]
}

/** Footer text under the alert history, and which of its buttons show. */
export function alertHistoryFooter({
  rowCount,
  pageCount,
  hasNextPage,
  isPlaceholderData,
  kind,
}: {
  rowCount: number
  pageCount: number
  hasNextPage: boolean
  isPlaceholderData: boolean
  kind: AlertKindFilter
}): { text: string; showLoadOlder: boolean; showBackToNewest: boolean } {
  const showing = `Showing ${rowCount.toLocaleString()} ${rowCount === 1 ? "alert" : "alerts"}`
  // While the previous filter's rows stand in, hasNextPage reads the new
  // filter's query, which has no pages yet.
  if (isPlaceholderData) return { text: showing, showLoadOlder: false, showBackToNewest: false }
  const notes: string[] = []
  if (!hasNextPage) notes.push("No older alerts in this window.")
  else if (pageCount >= ALERT_MAX_PAGES) {
    notes.push(scenarioFilterAllowed(kind) ? "Filter by IP or scenario to go further back." : "Filter by IP to go further back.")
  }
  const pagedBack = pageCount > 1
  if (pagedBack) notes.push("Updates pause while older alerts are loaded.")
  return {
    text: notes.length > 0 ? `${showing}. ${notes.join(" ")}` : showing,
    showLoadOlder: hasNextPage && pageCount < ALERT_MAX_PAGES,
    showBackToNewest: pagedBack,
  }
}

/** Event meta keys the events table shows as their own columns. */
export const HTTP_EVENT_KEYS = ["http_verb", "http_path", "http_status", "http_user_agent", "target_fqdn"] as const

/** Meta keys a bot-detection challenge event row shows on its own. */
export const CHALLENGE_EVENT_KEYS = [
  "log_type",
  "method",
  "target_host",
  "target_uri",
  "challenge_event",
  "challenge_fail_reason",
  "http_user_agent",
] as const

// Every event repeats these, and the sheet shows them once already.
const REDUNDANT_EVENT_KEYS = new Set(["timestamp", "source_ip"])

const CONTEXT_LABELS: Record<string, string> = {
  target_uri: "Targeted paths",
  user_agent: "User agents",
  method: "Methods",
  status: "Status codes",
  cve: "CVE",
  bot_detected: "Bot detected",
  challenge_event: "Challenge",
  fail_reason: "Reason",
  fingerprint_id: "Fingerprint",
  operating_system: "Operating system",
  request_score: "Score",
  score_reasons: "Score reasons",
}

// Alert origins the engine stamps on `kind`. The default, crowdsec, gets no
// label: every log-scenario alert would carry the same badge.
const KIND_LABELS: Record<string, string | null> = {
  crowdsec: null,
  waf: "WAF",
  "bot-detection": "Bot rejected",
  capi: "Blocklist",
  papi: "Console",
  cscli: "cscli",
}

export function kindLabel(kind: string | null): string | null {
  if (kind === null) return null
  return kind in KIND_LABELS ? KIND_LABELS[kind] : kind
}

// Tints for the kinds an engine raises itself, kept apart from the decision
// badges: red is a ban, amber a captcha. Everything else stays the plain
// secondary badge.
const KIND_BADGE_CLASSES: Record<string, string> = {
  waf: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  "bot-detection": "bg-violet-500/15 text-violet-600 dark:text-violet-400",
}

export function kindBadgeClass(kind: string): string {
  return KIND_BADGE_CLASSES[kind] ?? ""
}

/** Every hub scenario of the AppSec bot challenge that bans starts with this. */
export const BOT_BAN_SCENARIO_PREFIX = "crowdsecurity/appsec-bot-challenge-"

// The bans carry kind crowdsec like any log scenario, so only the scenario
// tells them apart.
const BOT_BAN_BADGE = {
  label: "Bot ban",
  className: "bg-violet-500/30 text-violet-700 dark:bg-violet-500/35 dark:text-violet-200",
}

/** The badge an alert row shows, or null for a plain log-scenario alert. */
export function alertBadge(kind: string | null, scenario: string): { label: string; className: string } | null {
  if (scenario.startsWith(BOT_BAN_SCENARIO_PREFIX)) return BOT_BAN_BADGE
  const label = kindLabel(kind)
  if (label === null) return null
  return { label, className: kindBadgeClass(kind ?? "") }
}

export function hasHttpEvents(events: AlertEventView[]): boolean {
  return events.some((event) => "http_path" in event.meta)
}

/** The AppSec challenge writes its own event shape, keyed on this log type. */
export function isChallengeEvent(meta: Record<string, string>): boolean {
  return meta.log_type === "appsec-challenge"
}

/** Meta entries left over once the row's own columns have taken theirs. */
export function eventExtras(meta: Record<string, string>, shownKeys: readonly string[]): [string, string][] {
  const shown = new Set<string>(shownKeys)
  return Object.entries(meta)
    .filter(([key]) => !shown.has(key) && !REDUNDANT_EVENT_KEYS.has(key))
    .sort(([a], [b]) => a.localeCompare(b))
}

export type ScoreReason = { signal: string; points: number | null }

/** "cdp=100,utc_timezone=15" -> the signals that fired and their points. */
export function parseScoreReasons(value: string): ScoreReason[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [signal, points] = entry.split("=")
      const parsed = Number(points)
      return { signal, points: points !== undefined && Number.isFinite(parsed) ? parsed : null }
    })
}

// What each scoring signal in the hub's appsec-bot-challenge-scoring config
// means for the person reading the alert. The signal names are the ones the
// fingerprint scanner emits.
const SIGNAL_NOTES: Record<string, string> = {
  cdp: "A debugger was attached to the page. An open DevTools window triggers this too.",
  webdriver: "The browser reports that WebDriver automation is driving it.",
  webdriver_writable: "The WebDriver flag has been tampered with to hide automation.",
  webdriver_iframe: "WebDriver automation showed up inside an iframe.",
  webdriver_worker: "WebDriver automation showed up inside a web worker.",
  selenium: "Selenium left its markers in the page.",
  playwright: "Playwright left its markers in the page.",
  bot_user_agent: "The user agent names a known bot or automation tool.",
  headless_screen_resolution: "The screen size is the default of a headless browser.",
  missing_chrome_object: "A Chrome user agent without Chrome's own APIs, as in headless Chrome.",
  impossible_memory: "The reported device memory is a value no real device has.",
  inconsistent_etsl: "The page and its workers disagree about the browser engine.",
  mismatch_webgl_worker: "The page and its workers report different graphics hardware.",
  mismatch_platform_iframe: "The page and an iframe report different platforms.",
  mismatch_platform_worker: "The page and a worker report different platforms.",
  platform_mismatch: "The user agent and the browser disagree about the operating system.",
  gpu_mismatch: "The graphics hardware does not match the reported platform, as in a VM or remote desktop.",
  high_cpu_count: "More CPU cores than a desktop usually has, as in a server or container.",
  utc_timezone: "The browser runs in UTC, which is rare on a personal device.",
  ua_mobile: "A mobile user agent on a device that does not look mobile.",
  accept_language: "The Accept-Language header does not match the browser's languages.",
  swiftshader_renderer: "Software-rendered graphics, common in virtual machines.",
  timezone_country: "The time zone does not match the country the IP is in.",
}

export function signalNote(signal: string): string | null {
  return SIGNAL_NOTES[signal] ?? null
}

export type ChallengeContext = {
  event: string | null
  failReason: string | null
  score: number | null
  reasons: ScoreReason[]
  fingerprintId: string | null
  operatingSystem: string | null
  userAgent: string | null
  targetUri: string | null
}

// Keys only the bot-detection context file writes. user_agent and
// target_uri are shared with the base HTTP context, so they never decide
// whether a challenge happened; they only join the section once one did.
const CHALLENGE_ONLY_KEYS = new Set([
  "bot_detected",
  "challenge_event",
  "fail_reason",
  "fingerprint_id",
  "operating_system",
  "request_score",
  "score_reasons",
])
const CHALLENGE_CONTEXT_KEYS = new Set([...CHALLENGE_ONLY_KEYS, "user_agent", "target_uri"])

/** Lifts the bot-detection context out for the Challenge section; anything
 *  else stays in `rest` for the generic context list. */
export function challengeContext(context: AlertContextView[]): {
  challenge: ChallengeContext | null
  rest: AlertContextView[]
} {
  if (!context.some((entry) => CHALLENGE_ONLY_KEYS.has(entry.key))) return { challenge: null, rest: context }
  const rest = context.filter((entry) => !CHALLENGE_CONTEXT_KEYS.has(entry.key))
  const first = (key: string): string | null =>
    context.find((entry) => entry.key === key)?.values[0] ?? null
  const score = first("request_score")
  const parsedScore = score === null ? NaN : Number(score)
  return {
    challenge: {
      event: first("challenge_event"),
      failReason: first("fail_reason"),
      score: Number.isFinite(parsedScore) ? parsedScore : null,
      reasons: parseScoreReasons(first("score_reasons") ?? ""),
      fingerprintId: first("fingerprint_id"),
      operatingSystem: first("operating_system"),
      userAgent: first("user_agent"),
      targetUri: first("target_uri"),
    },
    rest,
  }
}

/** "FS1_0000…h63b845": the id is stable per device, so its ends are enough
 *  to tell two apart on screen. The full id sits behind the copy button. */
export function shortFingerprint(id: string): string {
  return id.length > 20 ? `${id.slice(0, 8)}…${id.slice(-7)}` : id
}

export function alertDescription(alert: Pick<AlertView, "id" | "createdAt" | "eventsCount">): string {
  const events = `${alert.eventsCount} ${alert.eventsCount === 1 ? "event" : "events"}`
  return `Alert #${alert.id} · ${new Date(alert.createdAt).toLocaleString()} · ${events}`
}

/** What the alert itself did, apart from the IP's state right now. */
export function alertOutcome(
  alert: Pick<AlertView, "decisionTypes" | "decisionCount" | "activeDecisionCount">,
): { text: string; muted: boolean } {
  const muted = alert.activeDecisionCount === 0
  const [decisionType] = alert.decisionTypes
  if (alert.decisionCount === 0 || decisionType === undefined) return { text: "Alert only", muted: true }
  if (alert.decisionCount === 1) {
    const label = decisionType.charAt(0).toUpperCase() + decisionType.slice(1)
    return { text: `${label}, ${muted ? "expired" : "active"}`, muted }
  }
  return { text: `${alert.decisionCount} decisions, ${alert.activeDecisionCount} active`, muted }
}

/** Back-to-back alerts from one source, newest first. */
export type AlertRun = { key: string; alerts: AlertView[] }

/** Collapses adjacent alerts with the same source and kind into one run, so
 *  a flood of WAF hits from one IP reads as one row. Scenarios may differ. */
export function groupConsecutiveAlerts(alerts: AlertView[]): AlertRun[] {
  const runAlerts: AlertView[][] = []
  for (const alert of alerts) {
    const currentRun = runAlerts.at(-1)
    const newest = currentRun?.[0]
    if (currentRun && newest && newest.value === alert.value && newest.kind === alert.kind) {
      currentRun.push(alert)
    } else {
      runAlerts.push([alert])
    }
  }
  return runAlerts.map((alertsInRun) => ({
    key: alertKey(alertsInRun[alertsInRun.length - 1]),
    alerts: alertsInRun,
  }))
}

function alertKey(alert: AlertView): string {
  return alert.id !== null ? String(alert.id) : `${alert.createdAt}:${alert.value}`
}

/** Expansion follows the alerts a run holds, not the run itself. A refresh
 *  can add an alert on top or drop the oldest, and either changes the run. */
export function isRunOpen(alertRun: AlertRun, expandedAlertKeys: ReadonlySet<string>): boolean {
  return alertRun.alerts.some((alert) => expandedAlertKeys.has(alertKey(alert)))
}

export function toggleRun(expandedAlertKeys: ReadonlySet<string>, alertRun: AlertRun): Set<string> {
  const next = new Set(expandedAlertKeys)
  const open = isRunOpen(alertRun, expandedAlertKeys)
  for (const alert of alertRun.alerts) {
    if (open) next.delete(alertKey(alert))
    else next.add(alertKey(alert))
  }
  return next
}

/** "4 scenarios" for a run that mixes scenarios, or null when they all match. */
export function runScenarioLabel(alertRun: AlertRun): string | null {
  const scenarios = new Set(alertRun.alerts.map((alert) => alert.scenario))
  return scenarios.size > 1 ? `${scenarios.size} scenarios` : null
}

export function contextLabel(key: string): string {
  return CONTEXT_LABELS[key] ?? key
}

const GO_UNIT_MS: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1000, ms: 1, "µs": 0.001, us: 0.001, ns: 0.000001 }

/** A Go duration string in milliseconds, or null when it is not one. */
export function goDurationMs(value: string): number | null {
  const parts = [...value.matchAll(/(\d+(?:\.\d+)?)(h|ms|µs|us|ns|m|s)/g)]
  if (parts.length === 0 || parts.map((part) => part[0]).join("") !== value) return null
  return parts.reduce((total, [, amount, unit]) => total + Number(amount) * GO_UNIT_MS[unit], 0)
}

/** "9.693947574s" -> "9.7 s". Go prints durations to the nanosecond. */
export function formatGoDuration(value: string): string | null {
  const ms = goDurationMs(value)
  if (ms === null) return null
  if (ms === 0) return "0 s"
  if (ms < 1) return "under 1 ms"
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${Number((ms / 1000).toFixed(1))} s`
  const seconds = Math.round(ms / 1000)
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  const minutes = Math.round(seconds / 60)
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** A decision longer than this reads as permanent; CrowdSec has no "forever". */
const FOREVER_MS = 5 * 365 * 24 * 3_600_000

/** A decision's remaining time, "6d 21h", "3h 49m", "47m", or "Forever". */
export function formatTimeLeft(value: string): string {
  const ms = goDurationMs(value)
  if (ms === null) return value
  if (ms >= FOREVER_MS) return "Forever"
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return "under 1m"
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return minutes % 60 > 0 ? `${hours}h ${minutes % 60}m` : `${hours}h`
  return `${minutes}m`
}

/** formatTimeLeft for a line of its own: "3h 49m left", or just "Forever". */
export function timeLeftText(value: string): string {
  const timeLeft = formatTimeLeft(value)
  return timeLeft === "Forever" ? timeLeft : `${timeLeft} left`
}

const OVERFLOW_MESSAGE = /^Ip (\S+) performed '.*' \((\d+) events over (\S+)\) at /
const CHALLENGE_MESSAGE = /^WAF bot-detection: \S+ (\w+) by \S+(?: \((.*)\))?$/
const SCORE_DETAIL = /^request score (\d+)$/

/** Rewrites CrowdSec's overflow message without the nanoseconds and the Go
 *  timestamp, which the sheet shows elsewhere, and the bot-detection
 *  message without the IP and scenario the sheet already names. Other
 *  messages pass through. */
export function alertSummary(message: string): string {
  const challenge = CHALLENGE_MESSAGE.exec(message)
  if (challenge) {
    const [, event, detail] = challenge
    const score = detail ? SCORE_DETAIL.exec(detail) : null
    if (score) return `Browser challenge ${event} with a score of ${score[1]}.`
    return detail ? `Browser challenge ${event}: ${detail}.` : `Browser challenge ${event}.`
  }
  const match = OVERFLOW_MESSAGE.exec(message)
  if (!match) return message.replace(/^Ip /, "IP ")
  const [, ip, count, duration] = match
  const events = Number(count)
  const over = events > 1 ? formatGoDuration(duration) : null
  return `IP ${ip} triggered this scenario with ${events} ${events === 1 ? "event" : "events"}${over ? ` over ${over}` : ""}.`
}

const BLOCKLIST_ORIGINS = new Set(["CAPI", "lists"])

/** Community blocklist or a subscribed list, pulled in bulk rather than raised by an alert. */
export function isBlocklistOrigin(origin: string): boolean {
  return BLOCKLIST_ORIGINS.has(origin)
}

/** Whether the decision has an alert of its own to open. Blocklist
 *  decisions share one alert per pull, and the lookup goes by IP. */
export function decisionHasAlert(scope: string, decision: { id: number | null; origin: string }): boolean {
  return scope === "Ip" && decision.id !== null && !isBlocklistOrigin(decision.origin)
}

/** "Telenor (AS2119)", or whichever half the LAPI has. */
export function asLabel(name: string | null, number: string | null): string | null {
  const as = number ? `AS${number}` : null
  if (name && as) return `${name} (${as})`
  return name ?? as
}
