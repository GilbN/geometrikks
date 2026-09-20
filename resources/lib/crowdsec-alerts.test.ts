import { describe, expect, it } from "vitest"
import { alertSummary, decisionHasAlert, contextLabel, eventExtras, formatGoDuration, hasHttpEvents } from "./crowdsec-alerts"

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
    expect(eventExtras(HTTP_META, true)).toEqual([
      ["ASNNumber", "48090"],
      ["traefik_router_name", "web@docker"],
    ])
  })

  it("keeps the HTTP keys when there are no HTTP columns to show them", () => {
    expect(eventExtras({ http_path: "/x", timestamp: "t" }, false)).toEqual([["http_path", "/x"]])
  })
})

describe("contextLabel", () => {
  it("names the keys the hub collections ship", () => {
    expect(contextLabel("target_uri")).toBe("Targeted paths")
    expect(contextLabel("cve")).toBe("CVE")
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
