import { describe, expect, it } from "vitest"
import type { AlertView } from "@/generated/api/types.gen"
import {
  ALERT_KIND_OPTIONS,
  ALERT_MAX_PAGES,
  ALERT_PAGE_SIZE,
  CHALLENGE_EVENT_KEYS,
  HTTP_EVENT_KEYS,
  alertBadge,
  alertDescription,
  alertOutcome,
  alertsEmptyMessage,
  alertHistoryFooter,
  alertSummary,
  asLabel,
  challengeContext,
  contextLabel,
  decisionHasAlert,
  eventExtras,
  formatGoDuration,
  groupConsecutiveAlerts,
  isRunOpen,
  hasHttpEvents,
  isChallengeEvent,
  kindBadgeClass,
  kindLabel,
  parseScoreReasons,
  runScenarioLabel,
  scenarioFilterAllowed,
  toggleRun,
  shortFingerprint,
  signalNote,
} from "./crowdsec-alerts"

const HTTP_META = {
  ASNNumber: "48090",
  http_path: "/wp-json/",
  http_status: "404",
  http_verb: "GET",
  http_user_agent: "curl/8",
  target_fqdn: "example.org",
  timestamp: "2026-09-20T05:43:18Z",
  source_ip: "45.148.10.59",
  traefik_router_name: "web@docker",
}

describe("hasHttpEvents", () => {
  it("is true when any event carries an http_path", () => {
    expect(hasHttpEvents([{ timestamp: "", meta: { log_type: "ssh" } }, { timestamp: "", meta: HTTP_META }])).toBe(true)
  })

  it("is false for non-HTTP scenarios such as ssh-bf", () => {
    expect(hasHttpEvents([{ timestamp: "", meta: { log_type: "ssh_failed-auth" } }])).toBe(false)
  })
})

describe("eventExtras", () => {
  it("drops the keys the HTTP columns and the sheet header already show", () => {
    expect(eventExtras(HTTP_META, HTTP_EVENT_KEYS)).toEqual([
      ["ASNNumber", "48090"],
      ["traefik_router_name", "web@docker"],
    ])
  })

  it("keeps the HTTP keys when there are no HTTP columns to show them", () => {
    expect(eventExtras({ http_path: "/x", timestamp: "t" }, [])).toEqual([["http_path", "/x"]])
  })
})

describe("contextLabel", () => {
  it("names the keys the hub collections ship", () => {
    expect(contextLabel("target_uri")).toBe("Targeted paths")
    expect(contextLabel("cve")).toBe("CVE")
    expect(contextLabel("fingerprint_id")).toBe("Fingerprint")
    expect(contextLabel("score_reasons")).toBe("Score reasons")
  })

  it("falls back to the raw key for custom context", () => {
    expect(contextLabel("my_custom_key")).toBe("my_custom_key")
  })
})

describe("formatGoDuration", () => {
  it("rounds Go's nanosecond precision to something readable", () => {
    expect(formatGoDuration("9.693947574s")).toBe("9.7 s")
    expect(formatGoDuration("15.003118825s")).toBe("15 s")
    expect(formatGoDuration("350.5ms")).toBe("351 ms")
    expect(formatGoDuration("812.4µs")).toBe("under 1 ms")
    expect(formatGoDuration("1m2.5s")).toBe("1m 3s")
    expect(formatGoDuration("2h3m4s")).toBe("2h 3m")
    expect(formatGoDuration("0s")).toBe("0 s")
  })

  it("returns null for anything that is not a Go duration", () => {
    expect(formatGoDuration("soon")).toBeNull()
  })
})

describe("alertSummary", () => {
  it("rewrites CrowdSec's overflow message without the nanoseconds and the Go timestamp", () => {
    const message =
      "Ip 3.82.141.143 performed 'crowdsecurity/http-probing' (11 events over 9.693947574s) at 2026-09-19 23:43:21.350888026 +0000 UTC"
    expect(alertSummary(message)).toBe("IP 3.82.141.143 triggered this scenario with 11 events over 9.7 s.")
  })

  it("uses the singular for one event", () => {
    const message = "Ip 1.2.3.4 performed 'crowdsecurity/CVE-2017-9841' (1 events over 0s) at 2026-09-19 23:43:21 +0000 UTC"
    expect(alertSummary(message)).toBe("IP 1.2.3.4 triggered this scenario with 1 event.")
  })

  it("keeps other messages, such as a manual ban reason, and fixes the Ip casing", () => {
    expect(alertSummary("manual ban from GeoMetrikks")).toBe("manual ban from GeoMetrikks")
    expect(alertSummary("Ip 1.2.3.4 was banned by hand")).toBe("IP 1.2.3.4 was banned by hand")
  })
})

describe("decisionHasAlert", () => {
  it("is true for a local IP decision with an id", () => {
    expect(decisionHasAlert("Ip", { id: 7, origin: "crowdsec" })).toBe(true)
    expect(decisionHasAlert("Ip", { id: 7, origin: "cscli" })).toBe(true)
  })

  it("is false for blocklist decisions, which share one alert per pull", () => {
    expect(decisionHasAlert("Ip", { id: 7, origin: "CAPI" })).toBe(false)
    expect(decisionHasAlert("Ip", { id: 7, origin: "lists" })).toBe(false)
  })

  it("is false without an id or for a non-IP scope", () => {
    expect(decisionHasAlert("Ip", { id: null, origin: "crowdsec" })).toBe(false)
    expect(decisionHasAlert("Range", { id: 7, origin: "crowdsec" })).toBe(false)
  })
})

describe("asLabel", () => {
  it("joins the name and the number", () => {
    expect(asLabel("Telenor", "2119")).toBe("Telenor (AS2119)")
  })

  it("shows whichever one the LAPI has", () => {
    expect(asLabel(null, "2119")).toBe("AS2119")
    expect(asLabel("Telenor", null)).toBe("Telenor")
    expect(asLabel(null, null)).toBeNull()
  })
})

const CHALLENGE_META = {
  bot_signals: "cdp",
  challenge_event: "rejected",
  challenge_fail_reason: "request score 100",
  fingerprint_bot: "true",
  fsid: "FS1_000010000000000000000_00010h02ba_1920x1200c20m32b00011h366c95_nb6tEurope-Oslo_h3af4_0100h63b845",
  http_user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/153.0.0.0",
  log_type: "appsec-challenge",
  method: "POST",
  os: "Windows",
  request_score: "100",
  request_score_reasons: "cdp=100",
  request_uuid: "b350f54c-2e79-4dc2-af3c-163134d71c47",
  service: "appsec",
  source_ip: "193.212.3.50",
  target_host: "gflix.app",
  target_uri: "/",
  timestamp: "2026-09-26T12:33:41+00:00",
}

describe("kindLabel", () => {
  it("names the kinds the engine stamps", () => {
    expect(kindLabel("bot-detection")).toBe("Bot rejected")
    expect(kindLabel("waf")).toBe("WAF")
    expect(kindLabel("capi")).toBe("Blocklist")
    expect(kindLabel("papi")).toBe("Console")
    expect(kindLabel("cscli")).toBe("cscli")
  })

  it("is null for the default kind and for LAPIs that predate the field, so no badge shows", () => {
    expect(kindLabel("crowdsec")).toBeNull()
    expect(kindLabel(null)).toBeNull()
  })

  it("passes an unknown kind through", () => {
    expect(kindLabel("future-kind")).toBe("future-kind")
  })
})

describe("alertBadge", () => {
  it("marks a bot-detection alert as a rejection", () => {
    expect(alertBadge("bot-detection", "crowdsecurity/rejected-browser-submission")?.label).toBe("Bot rejected")
  })

  it("marks a ban from any bot challenge scenario as a bot ban", () => {
    expect(alertBadge("crowdsec", "crowdsecurity/appsec-bot-challenge-too-many-requests")?.label).toBe("Bot ban")
    expect(alertBadge("crowdsec", "crowdsecurity/appsec-bot-challenge-something-new")?.label).toBe("Bot ban")
  })

  it("falls back to the kind badge", () => {
    expect(alertBadge("waf", "crowdsecurity/vpatch-CVE-2024-1")?.label).toBe("WAF")
  })

  it("shows nothing for a log-scenario alert", () => {
    expect(alertBadge("crowdsec", "crowdsecurity/http-probing")).toBeNull()
  })
})

describe("parseScoreReasons", () => {
  it("splits the per-signal breakdown into signals and points", () => {
    expect(parseScoreReasons("cdp=100,utc_timezone=15")).toEqual([
      { signal: "cdp", points: 100 },
      { signal: "utc_timezone", points: 15 },
    ])
  })

  it("keeps a signal without points and ignores empty entries", () => {
    expect(parseScoreReasons("odd,,gpu_mismatch=30")).toEqual([
      { signal: "odd", points: null },
      { signal: "gpu_mismatch", points: 30 },
    ])
    expect(parseScoreReasons("")).toEqual([])
  })
})

describe("signalNote", () => {
  it("explains that an open DevTools window scores like a bot", () => {
    expect(signalNote("cdp")).toMatch(/DevTools/)
  })

  it("names automation frameworks and headless signals", () => {
    expect(signalNote("playwright")).toMatch(/Playwright/)
    expect(signalNote("headless_screen_resolution")).toMatch(/headless/i)
  })

  it("is null for a signal it does not know", () => {
    expect(signalNote("something_new")).toBeNull()
  })
})

describe("alertSummary for bot-detection messages", () => {
  it("rewrites a rejection with its score", () => {
    const message =
      "WAF bot-detection: 193.212.3.50 rejected by crowdsecurity/rejected-browser-submission (request score 100)"
    expect(alertSummary(message)).toBe("Browser challenge rejected with a score of 100.")
  })

  it("rewrites a failed submission with its reason", () => {
    const message =
      "WAF bot-detection: 1.2.3.4 failed by crowdsecurity/rejected-browser-submission (invalid HMAC in challenge response)"
    expect(alertSummary(message)).toBe("Browser challenge failed: invalid HMAC in challenge response.")
  })

  it("copes with a message without a detail", () => {
    expect(alertSummary("WAF bot-detection: 1.2.3.4 rejected by crowdsecurity/rejected-browser-submission")).toBe(
      "Browser challenge rejected.",
    )
  })
})

describe("challenge events", () => {
  it("recognises the appsec-challenge log type", () => {
    expect(isChallengeEvent(CHALLENGE_META)).toBe(true)
    expect(isChallengeEvent(HTTP_META)).toBe(false)
  })

  it("leaves only the fields the challenge row does not show", () => {
    expect(eventExtras(CHALLENGE_META, CHALLENGE_EVENT_KEYS).map(([key]) => key)).toEqual([
      "bot_signals",
      "fingerprint_bot",
      "fsid",
      "os",
      "request_score",
      "request_score_reasons",
      "request_uuid",
      "service",
    ])
  })
})

describe("challengeContext", () => {
  const context = [
    { key: "bot_detected", values: ["true"] },
    { key: "challenge_event", values: ["rejected"] },
    { key: "fail_reason", values: ["request score 100"] },
    { key: "fingerprint_id", values: [CHALLENGE_META.fsid] },
    { key: "request_score", values: ["100"] },
    { key: "score_reasons", values: ["cdp=100"] },
    { key: "user_agent", values: [CHALLENGE_META.http_user_agent] },
    { key: "target_uri", values: ["/"] },
    { key: "operating_system", values: ["Windows"] },
    { key: "my_custom_key", values: ["x"] },
  ]

  it("lifts the challenge fields out and leaves the rest for the generic list", () => {
    const { challenge, rest } = challengeContext(context)
    expect(challenge).toEqual({
      event: "rejected",
      failReason: "request score 100",
      score: 100,
      reasons: [{ signal: "cdp", points: 100 }],
      fingerprintId: CHALLENGE_META.fsid,
      operatingSystem: "Windows",
      userAgent: CHALLENGE_META.http_user_agent,
      targetUri: "/",
    })
    expect(rest.map((entry) => entry.key)).toEqual(["my_custom_key"])
  })

  it("does not mistake a log scenario's user agents and paths for a challenge", () => {
    const httpContext = [
      { key: "target_uri", values: ["/.env"] },
      { key: "user_agent", values: ["Mozilla/5.0"] },
      { key: "status", values: ["403", "404"] },
    ]
    const { challenge, rest } = challengeContext(httpContext)
    expect(challenge).toBeNull()
    expect(rest).toEqual(httpContext)
  })

  it("has no challenge when the context carries none of the keys", () => {
    const { challenge, rest } = challengeContext([{ key: "cve", values: ["CVE-2017-9841"] }])
    expect(challenge).toBeNull()
    expect(rest).toHaveLength(1)
  })
})

describe("shortFingerprint", () => {
  it("keeps the head and the tail of a long id", () => {
    expect(shortFingerprint(CHALLENGE_META.fsid)).toBe("FS1_0000…h63b845")
  })

  it("leaves a short id alone", () => {
    expect(shortFingerprint("FS1_abc")).toBe("FS1_abc")
  })
})

describe("alertDescription", () => {
  it("uses the singular for one event", () => {
    expect(alertDescription({ id: 13087, createdAt: "2026-09-26T12:33:42Z", eventsCount: 1 })).toMatch(/· 1 event$/)
    expect(alertDescription({ id: 7, createdAt: "2026-09-26T12:33:42Z", eventsCount: 6 })).toMatch(/· 6 events$/)
  })
})

describe("kindBadgeClass", () => {
  it("gives WAF and bot detection their own colors", () => {
    expect(kindBadgeClass("waf")).toMatch(/sky/)
    expect(kindBadgeClass("bot-detection")).toMatch(/violet/)
    expect(kindBadgeClass("waf")).not.toBe(kindBadgeClass("bot-detection"))
  })

  it("leaves the other kinds on the default badge", () => {
    expect(kindBadgeClass("capi")).toBe("")
    expect(kindBadgeClass("future-kind")).toBe("")
  })
})

describe("alertHistoryFooter", () => {
  const capRows = ALERT_MAX_PAGES * ALERT_PAGE_SIZE

  it("offers Load older while more alerts are available", () => {
    expect(alertHistoryFooter({ rowCount: 100, pageCount: 2, hasNextPage: true, isPlaceholderData: false })).toEqual({
      text: "Showing 100 alerts",
      showLoadOlder: true,
    })
  })

  it("says so once the window has no older alerts", () => {
    expect(alertHistoryFooter({ rowCount: 1, pageCount: 1, hasNextPage: false, isPlaceholderData: false })).toEqual({
      text: "Showing 1 alert. No older alerts in this window.",
      showLoadOlder: false,
    })
  })

  it("stops at the page cap and points at the filters", () => {
    expect(
      alertHistoryFooter({ rowCount: capRows, pageCount: ALERT_MAX_PAGES, hasNextPage: true, isPlaceholderData: false }),
    ).toEqual({
      text: `Showing ${capRows.toLocaleString()} alerts. Filter by IP or scenario to go further back.`,
      showLoadOlder: false,
    })
    expect(capRows.toLocaleString("en-US")).toBe("1,000")
  })

  it("reports the end, not the cap, when the last page lands on the cap", () => {
    expect(
      alertHistoryFooter({ rowCount: capRows, pageCount: ALERT_MAX_PAGES, hasNextPage: false, isPlaceholderData: false }).text,
    ).toBe(`Showing ${capRows.toLocaleString()} alerts. No older alerts in this window.`)
  })

  it("claims neither an end nor a cap while placeholder rows stand in", () => {
    expect(alertHistoryFooter({ rowCount: 50, pageCount: 0, hasNextPage: false, isPlaceholderData: true })).toEqual({
      text: "Showing 50 alerts",
      showLoadOlder: false,
    })
  })
})

describe("alertsEmptyMessage", () => {
  it("names what each kind needs when its view is empty", () => {
    expect(alertsEmptyMessage("all")).toBe("No alerts in this window.")
    expect(alertsEmptyMessage("crowdsec")).toBe("No alerts of this kind in this window.")
    expect(alertsEmptyMessage("waf")).toBe("No WAF alerts in this window. WAF alerts need AppSec enabled on a bouncer.")
    expect(alertsEmptyMessage("bot")).toBe(
      "No bot challenge alerts in this window. The bot challenge needs CrowdSec 1.8 and a bouncer that supports it.",
    )
  })

  it("labels the kind options", () => {
    expect(ALERT_KIND_OPTIONS.map((option) => option.label)).toEqual(["All kinds", "Log scenarios", "WAF", "Bot detection"])
  })
})

describe("alertOutcome", () => {
  it("says an alert without decisions only raised an alert", () => {
    expect(alertOutcome({ decisionTypes: [], decisionCount: 0, activeDecisionCount: 0 })).toEqual({
      text: "Alert only",
      muted: true,
    })
  })

  it("names a single decision's type and whether it still applies", () => {
    expect(alertOutcome({ decisionTypes: ["ban"], decisionCount: 1, activeDecisionCount: 1 })).toEqual({
      text: "Ban, active",
      muted: false,
    })
    expect(alertOutcome({ decisionTypes: ["ban"], decisionCount: 1, activeDecisionCount: 0 })).toEqual({
      text: "Ban, expired",
      muted: true,
    })
    expect(alertOutcome({ decisionTypes: ["captcha"], decisionCount: 1, activeDecisionCount: 1 }).text).toBe(
      "Captcha, active",
    )
  })

  it("counts decisions once there is more than one", () => {
    expect(
      alertOutcome({ decisionTypes: ["ban", "captcha"], decisionCount: 2, activeDecisionCount: 1 }),
    ).toEqual({ text: "2 decisions, 1 active", muted: false })
    expect(alertOutcome({ decisionTypes: ["ban"], decisionCount: 3, activeDecisionCount: 0 })).toEqual({
      text: "3 decisions, 0 active",
      muted: true,
    })
  })

  it("falls back to Alert only when a decision count comes without its type", () => {
    expect(alertOutcome({ decisionTypes: [], decisionCount: 1, activeDecisionCount: 1 })).toEqual({
      text: "Alert only",
      muted: true,
    })
  })
})

let nextAlertId = 1

function makeAlert(value: string, kind: string | null, scenario = "crowdsecurity/http-probing"): AlertView {
  const id = nextAlertId++
  return {
    id,
    value,
    kind,
    scenario,
    scope: "Ip",
    createdAt: "2026-09-28T10:43:44Z",
    message: "",
    eventsCount: 1,
    machineId: "localhost",
    asName: null,
    countryCode: null,
    countryName: null,
    decisionCount: 0,
    decisionTypes: [],
    activeDecisionCount: 0,
  }
}

const runSizes = (alerts: AlertView[]) => groupConsecutiveAlerts(alerts).map((alertRun) => alertRun.alerts.length)

describe("groupConsecutiveAlerts", () => {
  it("merges adjacent alerts with the same source and kind across scenarios", () => {
    const alerts = [
      makeAlert("136.113.203.55", "waf", "crowdsecurity/vpatch-CVE-2023-1"),
      makeAlert("136.113.203.55", "waf", "crowdsecurity/vpatch-CVE-2024-2"),
      makeAlert("136.113.203.55", "waf", "crowdsecurity/vpatch-CVE-2023-1"),
    ]
    const runs = groupConsecutiveAlerts(alerts)
    expect(runs).toHaveLength(1)
    expect(runs[0].alerts).toEqual(alerts)
    expect(runs[0].key).toBe(String(alerts[2].id))
  })

  it("keeps a run's key when a newer alert from the same source joins it", () => {
    const alerts = [makeAlert("1.1.1.1", "waf"), makeAlert("1.1.1.1", "waf")]
    const [before] = groupConsecutiveAlerts(alerts)
    const [after] = groupConsecutiveAlerts([makeAlert("1.1.1.1", "waf"), ...alerts])
    expect(after.alerts).toHaveLength(3)
    expect(after.key).toBe(before.key)
  })

  it("keys a run by time and source when its oldest alert has no id", () => {
    const alert = { ...makeAlert("1.1.1.1", "waf"), id: null }
    expect(groupConsecutiveAlerts([alert])[0].key).toBe(`${alert.createdAt}:1.1.1.1`)
  })

  it("keeps an interrupted run apart", () => {
    expect(runSizes([makeAlert("1.1.1.1", "waf"), makeAlert("2.2.2.2", "waf"), makeAlert("1.1.1.1", "waf")])).toEqual([
      1, 1, 1,
    ])
  })

  it("keeps different kinds apart", () => {
    expect(runSizes([makeAlert("1.1.1.1", "waf"), makeAlert("1.1.1.1", "crowdsec")])).toEqual([1, 1])
  })

  it("treats a missing kind as its own kind", () => {
    expect(runSizes([makeAlert("1.1.1.1", null), makeAlert("1.1.1.1", null)])).toEqual([2])
    expect(runSizes([makeAlert("1.1.1.1", null), makeAlert("1.1.1.1", "crowdsec")])).toEqual([1, 1])
  })

  it("merges runs across page boundaries", () => {
    const page1 = [makeAlert("2.2.2.2", "crowdsec"), makeAlert("1.1.1.1", "waf")]
    const page2 = [makeAlert("1.1.1.1", "waf"), makeAlert("3.3.3.3", "waf")]
    expect(runSizes(page1.concat(page2))).toEqual([1, 2, 1])
  })
})

describe("runScenarioLabel", () => {
  it("is null when every alert in the run has the same scenario", () => {
    const alerts = [makeAlert("1.1.1.1", "waf"), makeAlert("1.1.1.1", "waf")]
    expect(runScenarioLabel({ key: "1", alerts })).toBeNull()
  })

  it("counts the distinct scenarios of a mixed run", () => {
    const scenarios = ["a", "b", "c", "d"]
    const alerts = Array.from({ length: 12 }, (_, index) =>
      makeAlert("1.1.1.1", "waf", `crowdsecurity/vpatch-${scenarios[index % 4]}`),
    )
    expect(runScenarioLabel({ key: "1", alerts })).toBe("4 scenarios")
  })
})

describe("isRunOpen", () => {
  it("is closed until toggled, then open", () => {
    const [alertRun] = groupConsecutiveAlerts([makeAlert("1.1.1.1", "waf"), makeAlert("1.1.1.1", "waf")])
    expect(isRunOpen(alertRun, new Set())).toBe(false)
    expect(isRunOpen(alertRun, toggleRun(new Set(), alertRun))).toBe(true)
  })

  it("stays open when a newer alert joins the top of the run", () => {
    const alerts = [makeAlert("1.1.1.1", "waf"), makeAlert("1.1.1.1", "waf")]
    const expanded = toggleRun(new Set(), groupConsecutiveAlerts(alerts)[0])
    const [refreshed] = groupConsecutiveAlerts([makeAlert("1.1.1.1", "waf"), ...alerts])
    expect(isRunOpen(refreshed, expanded)).toBe(true)
  })

  it("stays open when its oldest alert drops off the bottom", () => {
    const alerts = [makeAlert("1.1.1.1", "waf"), makeAlert("1.1.1.1", "waf"), makeAlert("1.1.1.1", "waf")]
    const expanded = toggleRun(new Set(), groupConsecutiveAlerts(alerts)[0])
    const [refreshed] = groupConsecutiveAlerts(alerts.slice(0, 2))
    expect(isRunOpen(refreshed, expanded)).toBe(true)
  })

  it("closes when toggled again, including alerts that joined while open", () => {
    const alerts = [makeAlert("1.1.1.1", "waf"), makeAlert("1.1.1.1", "waf")]
    const expanded = toggleRun(new Set(), groupConsecutiveAlerts(alerts)[0])
    const [refreshed] = groupConsecutiveAlerts([makeAlert("1.1.1.1", "waf"), ...alerts])
    const collapsed = toggleRun(expanded, refreshed)
    expect(isRunOpen(refreshed, collapsed)).toBe(false)
    expect(collapsed.size).toBe(0)
  })

  it("leaves other runs as they were", () => {
    const [first, second] = groupConsecutiveAlerts([makeAlert("1.1.1.1", "waf"), makeAlert("2.2.2.2", "waf")])
    const expanded = toggleRun(new Set(), first)
    expect(isRunOpen(second, expanded)).toBe(false)
  })
})

describe("scenarioFilterAllowed", () => {
  it("rules out a scenario filter for the bot group only", () => {
    expect(scenarioFilterAllowed("bot")).toBe(false)
    expect(scenarioFilterAllowed("all")).toBe(true)
    expect(scenarioFilterAllowed("waf")).toBe(true)
    expect(scenarioFilterAllowed("crowdsec")).toBe(true)
  })
})
