import { describe, expect, test } from "vitest"
import type { ReportIpDto, ReportedIpDto } from "@/generated/api/types.gen"
import {
  abuseipdbCheckUrl,
  ABUSEIPDB_CATEGORIES,
  buildReportComment,
  canonicalIp,
  categoriesForScenarios,
  commentLength,
  defaultAttackTime,
  isPublicIp,
  localScenarios,
  MAX_COMMENT_LENGTH,
  reportedItemState,
  reportItemState,
} from "./abuseipdb"

function ipEvidence(overrides: Partial<ReportIpDto> = {}): ReportIpDto {
  return {
    alerts: [],
    alertsTruncated: false,
    asn: null,
    asnDrop: false,
    asnOrganization: null,
    countryCode: null,
    countryName: null,
    decisions: [],
    distinctPaths: 0,
    dropNetwork: null,
    firstSeen: null,
    ipAddress: "3.5.140.2",
    lastSeen: null,
    lines: [],
    malformedRequests: 0,
    paths: [],
    peak: null,
    status2xx: 0,
    status3xx: 0,
    status4xx: 0,
    status5xx: 0,
    totalBytes: 0,
    totalRequests: 0,
    userAgents: [],
    ...overrides,
  }
}

const alert = (scenario: string, startAt: string | null = null) => ({
  createdAt: "2026-11-06T16:00:00Z",
  decisions: [],
  eventsCount: 1,
  kind: null,
  scenario,
  startAt,
  stopAt: null,
})

const decision = (origin: string, scenario: string) => ({
  duration: "1h",
  origin,
  scenario,
  scope: "Ip",
  type: "ban",
  value: "3.5.140.2",
})

const trafficEvidence = (overrides: Partial<ReportIpDto> = {}) =>
  ipEvidence({
    totalRequests: 412,
    status4xx: 398,
    firstSeen: "2026-11-06T14:02:11Z",
    lastSeen: "2026-11-06T16:40:55Z",
    paths: [
      { url: "/.env", hits: 200, errorHits: 200 },
      { url: "/", hits: 50, errorHits: 0 },
      { url: "/.git/config", hits: 100, errorHits: 100 },
    ],
    userAgents: [{ userAgent: "zgrab/0.x", hits: 412 }],
    ...overrides,
  })

describe("categories", () => {
  test("lists the 23 categories in id order", () => {
    expect(ABUSEIPDB_CATEGORIES).toHaveLength(23)
    expect(ABUSEIPDB_CATEGORIES.map((category) => category.id)).toEqual(Array.from({ length: 23 }, (_, index) => index + 1))
    expect(ABUSEIPDB_CATEGORIES[20]).toEqual({ id: 21, name: "Web App Attack" })
  })

  test("ssh brute force maps to 18 and 22", () => {
    expect(categoriesForScenarios(["crowdsecurity/ssh-bf"])).toEqual({ ids: [18, 22], fromCrowdsec: true })
  })

  test("sqli maps to 16 and 21", () => {
    expect(categoriesForScenarios(["crowdsecurity/http-sqli-probing-detection"])).toEqual({
      ids: [16, 21],
      fromCrowdsec: true,
    })
  })

  test("http probing maps to 21 only", () => {
    expect(categoriesForScenarios(["crowdsecurity/http-probing"])).toEqual({ ids: [21], fromCrowdsec: true })
  })

  test("bad user agent maps to 19", () => {
    expect(categoriesForScenarios(["crowdsecurity/http-bad-user-agent"])).toEqual({ ids: [19], fromCrowdsec: true })
  })

  test("port scan and open proxy", () => {
    expect(categoriesForScenarios(["firewallservices/port-scan"]).ids).toEqual([14])
    expect(categoriesForScenarios(["x/open-proxy"]).ids).toEqual([9])
  })

  test("several scenarios merge without duplicates", () => {
    expect(categoriesForScenarios(["crowdsecurity/http-probing", "crowdsecurity/http-sensitive-files"]).ids).toEqual([21])
  })

  test("manual and unknown fall back to 21 and 19", () => {
    expect(categoriesForScenarios(["manual"])).toEqual({ ids: [19, 21], fromCrowdsec: false })
    expect(categoriesForScenarios(["manual 'ban' from 'cli'"])).toEqual({ ids: [19, 21], fromCrowdsec: false })
    expect(categoriesForScenarios([])).toEqual({ ids: [19, 21], fromCrowdsec: false })
  })
})

describe("localScenarios", () => {
  test("takes alerts and crowdsec or appsec decisions, once each, in first-seen order", () => {
    const evidence = ipEvidence({
      alerts: [alert("crowdsecurity/http-probing"), alert("crowdsecurity/ssh-bf")],
      decisions: [
        decision("crowdsec", "crowdsecurity/ssh-bf"),
        decision("appsec", "crowdsecurity/appsec-vpatch"),
        decision("cscli", "manual 'ban' from 'cli'"),
      ],
    })
    expect(localScenarios(evidence)).toEqual([
      "crowdsecurity/http-probing",
      "crowdsecurity/ssh-bf",
      "crowdsecurity/appsec-vpatch",
    ])
  })

  test("manual alerts and decisions never count", () => {
    const evidence = ipEvidence({
      alerts: [alert("manual")],
      decisions: [decision("crowdsec", "manual")],
    })
    expect(localScenarios(evidence)).toEqual([])
    expect(buildReportComment(evidence, localScenarios(evidence))).toBe("")
  })

  test("CAPI and lists decisions never count", () => {
    const evidence = ipEvidence({
      decisions: [decision("CAPI", "crowdsecurity/http-probing"), decision("lists", "crowdsecurity/http-probing")],
    })
    expect(localScenarios(evidence)).toEqual([])
    expect(categoriesForScenarios(localScenarios(evidence)).fromCrowdsec).toBe(false)
  })
})

describe("buildReportComment", () => {
  test("matches the mockup shape", () => {
    expect(buildReportComment(trafficEvidence(), ["crowdsecurity/http-probing"])).toBe(
      "412 HTTP requests 2026-11-06 14:02 to 16:40 UTC, 398 answered 4xx. Probed /.env, /.git/config. User agent: zgrab/0.x. CrowdSec: http-probing.",
    )
  })

  test("a range over two days spells out both dates", () => {
    const evidence = trafficEvidence({ lastSeen: "2026-11-07T01:05:00Z" })
    expect(buildReportComment(evidence, [])).toContain("2026-11-06 14:02 to 2026-11-07 01:05 UTC")
  })

  test("paths that only answered 2xx and 3xx stay out", () => {
    expect(buildReportComment(trafficEvidence(), [])).toContain(" Probed /.env, /.git/config. ")
  })

  test("strips any author prefix from scenarios", () => {
    expect(buildReportComment(ipEvidence(), ["LePresidente/http-generic-403-bf", "crowdsecurity/ssh-bf"])).toBe(
      "CrowdSec: http-generic-403-bf, ssh-bf.",
    )
  })

  test("stays within 1024 code points and keeps the CrowdSec part", () => {
    const longPaths = Array.from({ length: 10 }, (_, index) => ({
      url: `/${index}${"a".repeat(199)}`,
      hits: 10,
      errorHits: 10,
    }))
    const comment = buildReportComment(trafficEvidence({ paths: longPaths }), ["crowdsecurity/http-probing"])
    expect(commentLength(comment)).toBeLessThanOrEqual(MAX_COMMENT_LENGTH)
    expect(comment.endsWith("CrowdSec: http-probing.")).toBe(true)
    expect(comment).toContain("/0aaa")
    expect(comment).not.toContain("/9aaa")
  })

  test("names a scenario once when two authors share it", () => {
    expect(buildReportComment(ipEvidence(), ["crowdsecurity/ssh-bf", "custom/ssh-bf"])).toBe("CrowdSec: ssh-bf.")
  })

  test("a scenario's reason stays out of the comment", () => {
    expect(buildReportComment(ipEvidence(), ["geometrikks/manual-ban: spam"])).toBe("CrowdSec: manual-ban.")
  })

  test("a user agent that does not fit is dropped", () => {
    const evidence = trafficEvidence({
      paths: [{ url: `/${"a".repeat(900)}`, hits: 1, errorHits: 1 }],
      userAgents: [{ userAgent: "u".repeat(200), hits: 1 }],
    })
    const comment = buildReportComment(evidence, ["crowdsecurity/http-probing"])
    expect(comment).toContain("Probed /aaa")
    expect(comment).not.toContain("User agent")
    expect(commentLength(comment)).toBeLessThanOrEqual(MAX_COMMENT_LENGTH)
  })

  test("the user agent stays between the paths and CrowdSec after paths were cut", () => {
    const longPaths = Array.from({ length: 10 }, (_, index) => ({ url: `/${index}${"a".repeat(199)}`, hits: 1, errorHits: 1 }))
    const comment = buildReportComment(trafficEvidence({ paths: longPaths }), ["crowdsecurity/http-probing"])
    expect(comment).not.toContain("/9aaa")
    expect(comment).toMatch(/\. User agent: zgrab\/0\.x\. CrowdSec: http-probing\.$/)
  })

  test("many scenarios are cut whole, in order, within the limit", () => {
    const scenarios = Array.from({ length: 60 }, (_, index) => `author/scenario-${index}-${"s".repeat(10)}`)
    const comment = buildReportComment(ipEvidence(), scenarios)
    expect(commentLength(comment)).toBeLessThanOrEqual(MAX_COMMENT_LENGTH)
    expect(comment).toContain("scenario-0-ssssssssss, scenario-1-")
    expect(comment).not.toContain("scenario-59-")
    expect(comment.endsWith("s.")).toBe(true)
  })

  test("non-BMP scenario names are counted in code points", () => {
    const scenarios = Array.from({ length: 300 }, (_, index) => `author/${"😀".repeat(5)}${index}`)
    const comment = buildReportComment(trafficEvidence(), scenarios)
    expect(commentLength(comment)).toBeLessThanOrEqual(MAX_COMMENT_LENGTH)
    expect(comment.startsWith("412 HTTP requests")).toBe(true)
    expect(comment).toContain("CrowdSec: 😀😀😀😀😀0,")
  })

  test("the counts stay when they alone fill the budget", () => {
    const comment = buildReportComment(trafficEvidence({ totalRequests: 412 }), [`author/${"x".repeat(2000)}`])
    expect(comment.startsWith("412 HTTP requests")).toBe(true)
    expect(comment).not.toContain("CrowdSec")
    expect(commentLength(comment)).toBeLessThanOrEqual(MAX_COMMENT_LENGTH)
  })

  test("IP without traffic gets only the CrowdSec part, or nothing", () => {
    expect(buildReportComment(ipEvidence(), ["crowdsecurity/ssh-bf"])).toBe("CrowdSec: ssh-bf.")
    expect(buildReportComment(ipEvidence(), [])).toBe("")
  })
})

describe("defaultAttackTime", () => {
  test("uses firstSeen when there is one", () => {
    expect(defaultAttackTime(trafficEvidence())).toBe("2026-11-06T14:02:11Z")
  })

  test("falls back to the earliest alert", () => {
    const evidence = ipEvidence({
      alerts: [
        alert("a", "2026-11-05T10:00:00Z"),
        alert("b", null),
        alert("c", "2026-11-04T09:30:00Z"),
      ],
    })
    expect(defaultAttackTime(evidence)).toBe("2026-11-04T09:30:00Z")
  })

  test("is null with no evidence", () => {
    expect(defaultAttackTime(ipEvidence())).toBeNull()
  })
})

test("an emoji counts as one character", () => {
  expect(commentLength("😀" + "a".repeat(1023))).toBe(1024)
})

describe("reportedItemState", () => {
  const now = Date.parse("2026-11-07T12:00:00Z")
  const entry = (reportedAt: string, status: ReportedIpDto["status"] = "sent"): ReportedIpDto => ({
    ipAddress: "3.5.140.2",
    reportedAt,
    status,
  })

  test("no entry means ready", () => {
    expect(reportedItemState(undefined, now)).toEqual({ detail: null, disabled: false })
  })

  test("inside the window it counts down and disables", () => {
    expect(reportedItemState(entry("2026-11-07T11:54:00Z"), now)).toEqual({ detail: "again in 9 min", disabled: true })
    expect(reportedItemState(entry("2026-11-07T11:54:00Z", "unconfirmed"), now).disabled).toBe(true)
  })

  test("a report stamped slightly in the future counts as just sent", () => {
    expect(reportedItemState(entry("2026-11-07T12:02:00Z"), now)).toEqual({ detail: "again in 15 min", disabled: true })
  })

  test("after the window it shows the age", () => {
    expect(reportedItemState(entry("2026-11-07T11:30:00Z"), now)).toEqual({ detail: "reported 30 min ago", disabled: false })
    expect(reportedItemState(entry("2026-11-07T10:00:00Z", "unconfirmed"), now)).toEqual({
      detail: "may have been sent 2 h ago",
      disabled: false,
    })
    expect(reportedItemState(entry("2026-11-04T12:00:00Z"), now).detail).toBe("reported 3 d ago")
    expect(reportedItemState(entry("2026-10-28T12:00:00Z"), now).detail).toBe("reported on 2026-10-28")
  })
})

describe("canonicalIp", () => {
  test.each([
    ["3.5.140.2", "3.5.140.2"],
    [" 8.8.8.8 ", "8.8.8.8"],
    ["2600:1F18:0:0::1", "2600:1f18::1"],
    ["2600:1f18:0000:0000:0000:0000:0000:0001", "2600:1f18::1"],
    ["2001:4860:4860:0:0:0:0:8888", "2001:4860:4860::8888"],
    ["2001:0:0:1:0:0:0:1", "2001:0:0:1::1"],
    ["2001:0:0:1:0:0:1:1", "2001::1:0:0:1:1"],
    ["1:0:1:0:1:0:1:0", "1:0:1:0:1:0:1:0"],
    ["::", "::"],
    ["::1", "::1"],
    ["fe80::", "fe80::"],
    ["::ffff:8.8.8.8", "8.8.8.8"],
    ["::FFFF:808:808", "8.8.8.8"],
    ["::1.2.3.4", "::102:304"],
  ])("%s reads as %s", (input, expected) => {
    expect(canonicalIp(input)).toBe(expected)
  })

  test.each(["", "not-an-ip", "1.2.3", "1.2.3.256", "01.2.3.4", "1:2:3:4:5:6:7:8:9", "2600::1::2", "2600:1f18::1%eth0", "12345::1"])(
    "%s is not an address",
    (input) => {
      expect(canonicalIp(input)).toBeNull()
    },
  )
})

describe("isPublicIp", () => {
  test.each(["3.5.140.2", "8.8.8.8", "2600:1f18::1", "2001:4860:4860::8888", "::ffff:8.8.8.8", "192.0.0.9", "2001:3::1", "64:ff9b::808:808"])(
    "%s is public",
    (ip) => {
      expect(isPublicIp(ip)).toBe(true)
    },
  )

  // The first row matches tests/test_abuseipdb_service.py's refusals.
  test.each([
    "10.0.0.1", "127.0.0.2", "::1", "203.0.113.7", "2001:db8::1", "fe80::1%eth0", "not-an-ip", "2600:1f18::1%eth0", "::ffff:10.0.0.1",
    "10.0.0.5", "172.16.0.1", "192.168.1.34", "100.64.0.1", "169.254.1.1", "192.0.2.1", "198.51.100.7", "198.18.0.1",
    "0.0.0.0", "255.255.255.255", "240.0.0.1", "224.0.0.1", "239.255.255.250",
    "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "2001::1", "2002::1", "3fff::1",
  ])("%s is refused", (ip) => {
    expect(isPublicIp(ip)).toBe(false)
  })
})

describe("reportItemState", () => {
  const now = Date.parse("2026-11-07T12:00:00Z")

  test("a non-public address is disabled whatever its history", () => {
    expect(reportItemState("10.0.0.5", undefined, now)).toEqual({ detail: "not a public address", disabled: true })
  })

  test("a public address follows its latest report", () => {
    expect(reportItemState("3.5.140.2", undefined, now)).toEqual({ detail: null, disabled: false })
    expect(
      reportItemState("3.5.140.2", { ipAddress: "3.5.140.2", reportedAt: "2026-11-07T11:54:00Z", status: "sent" }, now),
    ).toEqual({ detail: "again in 9 min", disabled: true })
  })
})

test("check url keeps colons", () => {
  expect(abuseipdbCheckUrl("2600:1f18::1")).toBe("https://www.abuseipdb.com/check/2600:1f18::1")
})
