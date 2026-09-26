import { describe, expect, it } from "vitest"
import {
  CHALLENGE_EVENT_KEYS,
  HTTP_EVENT_KEYS,
  alertDescription,
  alertSummary,
  asLabel,
  challengeContext,
  contextLabel,
  decisionHasAlert,
  eventExtras,
  formatGoDuration,
  hasHttpEvents,
  isChallengeEvent,
  kindBadgeClass,
  kindLabel,
  parseScoreReasons,
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
    expect(kindLabel("bot-detection")).toBe("Bot detection")
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
