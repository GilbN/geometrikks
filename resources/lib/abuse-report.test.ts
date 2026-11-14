import { describe, expect, it } from "vitest"
import type { AbuseReportResponse, ReportAlertDto, ReportIpDto } from "@/generated/api/types.gen"
import {
  CSV_COLUMNS,
  WRAP_WIDTH,
  behaviorFindings,
  blacklistNoticeHeadline,
  blacklistedAddressCount,
  dropNoticeHeadline,
  formatAbuseReportCsv,
  formatAbuseReportText,
  groupDecisions,
  logLine,
  reportDropListings,
  reportFileName,
  reportIsFor,
  summarizeAlerts,
  titleDropBadgeKind,
  wrap,
} from "./abuse-report"

function ip(overrides: Partial<ReportIpDto> = {}): ReportIpDto {
  return {
    ipAddress: "198.51.100.7",
    countryCode: "US",
    countryName: "United States",
    asn: 64500,
    asnOrganization: "Example Hosting",
    totalRequests: 200,
    status2xx: 10,
    status3xx: 0,
    status4xx: 190,
    status5xx: 0,
    totalBytes: 2000,
    firstSeen: "2026-09-25T08:00:00+00:00",
    lastSeen: "2026-09-25T09:30:00+00:00",
    distinctPaths: 120,
    malformedRequests: 0,
    peak: { timestamp: "2026-09-25T08:00:00+00:00", hits: 150 },
    paths: [{ url: "/.env", hits: 40, errorHits: 40 }],
    userAgents: [{ userAgent: "curl/8.0", hits: 200 }],
    lines: [
      {
        timestamp: "2026-09-25T09:30:00+00:00",
        method: "GET",
        url: "/.env",
        httpVersion: "HTTP/1.1",
        statusCode: 404,
        bytesSent: 153,
        userAgent: 'say "hi"',
      },
    ],
    decisions: [],
    alerts: [],
    alertsTruncated: false,
    dropNetwork: null,
    asnDrop: false,
    ...overrides,
  }
}

function alert(overrides: Partial<ReportAlertDto> = {}): ReportAlertDto {
  return {
    scenario: "crowdsecurity/http-probing",
    kind: "crowdsec",
    createdAt: "2026-09-25T08:05:00Z",
    startAt: "2026-09-25T08:04:00Z",
    stopAt: "2026-09-25T08:05:00Z",
    eventsCount: 11,
    decisions: [{ type: "ban", duration: "3h", expired: false }],
    ...overrides,
  }
}

function report(overrides: Partial<AbuseReportResponse> = {}): AbuseReportResponse {
  return {
    target: { kind: "ip", ipAddress: "198.51.100.7", asn: 64500, asnOrganization: "Example Hosting", asnDrop: false },
    startDate: "2026-09-19T12:00:00+00:00",
    endDate: "2026-09-26T12:00:00+00:00",
    generatedAt: "2026-09-26T12:00:05+00:00",
    granularity: "hourly",
    ipCount: 1,
    totalRequests: 200,
    status4xx: 190,
    redactions: 0,
    crowdsec: { status: "ok", message: null },
    ips: [ip()],
    ...overrides,
  }
}

describe("wrap", () => {
  it("keeps lines within the width and indents continuations", () => {
    const lines = wrap(`- ${"word ".repeat(40)}`, "  ")
    expect(lines.every((line) => line.length <= WRAP_WIDTH)).toBe(true)
    expect(lines.slice(1).every((line) => line.startsWith("  "))).toBe(true)
  })

  it("leaves a word longer than the width on its own line", () => {
    const long = "x".repeat(WRAP_WIDTH + 10)
    expect(wrap(`a ${long} b`)).toEqual(["a", long, "b"])
  })
})

describe("logLine", () => {
  it("renders the combined log format with the referrer withheld", () => {
    expect(logLine("198.51.100.7", ip().lines[0])).toBe(
      '198.51.100.7 - - [25/Sep/2026:09:30:00 +0000] "GET /.env HTTP/1.1" 404 153 "-" "say \\"hi\\""',
    )
  })
})

describe("printable", () => {
  it("escapes line breaks so a client cannot forge report lines", () => {
    const line = { ...ip().lines[0], url: '/x\n203.0.113.9 - - [x] "GET /admin" 200', userAgent: "a\u2028b" }
    const rendered = logLine("198.51.100.7", line)
    expect(rendered.split("\n")).toHaveLength(1)
    expect(rendered).toContain("/x\\x0A203.0.113.9")
    expect(rendered).toContain('"a\\u2028b"')
  })
})

describe("groupDecisions", () => {
  it("folds repeats into one entry per type with the longest time left", () => {
    const decisions = [
      { type: "ban", scope: "Ip", value: "x", origin: "crowdsec", scenario: "a", duration: "1h" },
      { type: "ban", scope: "Ip", value: "x", origin: "crowdsec", scenario: "b", duration: "3h59m" },
      { type: "ban", scope: "Ip", value: "x", origin: "crowdsec", scenario: "a", duration: "2h" },
    ]
    expect(groupDecisions(decisions)).toEqual([{ type: "ban", duration: "3h59m", scenarios: ["a", "b"] }])
  })
})

describe("summarizeAlerts", () => {
  it("counts detections and events per scenario, busiest first", () => {
    const summary = summarizeAlerts([
      alert({ scenario: "b", startAt: "2026-09-25T08:00:00Z", eventsCount: 2 }),
      alert({ scenario: "a", startAt: "2026-09-25T09:00:00Z" }),
      alert({ scenario: "b", startAt: "2026-09-25T10:00:00Z", eventsCount: 3 }),
    ])
    expect(summary.map((s) => [s.scenario, s.detections, s.events])).toEqual([
      ["b", 2, 5],
      ["a", 1, 11],
    ])
    expect([summary[0].first, summary[0].last]).toEqual(["2026-09-25T08:00:00Z", "2026-09-25T10:00:00Z"])
  })
})

describe("behaviorFindings", () => {
  it("describes errors, path spread and a burst", () => {
    const findings = behaviorFindings(ip(), "hourly")
    expect(findings).toHaveLength(3)
    expect(findings[0]).toMatch(/^95% of the requests got a 4xx/)
    expect(findings[2]).toContain("in the hour starting 2026-09-25 08:00 UTC")
  })

  it("says nothing about a handful of requests", () => {
    expect(behaviorFindings(ip({ totalRequests: 5, status4xx: 5, distinctPaths: 5, peak: null }), "hourly")).toEqual([])
  })
})

describe("formatAbuseReportText", () => {
  it("opens with the subject and the abuse contact", () => {
    const text = formatAbuseReportText(report(), {
      query: "198.51.100.7",
      kind: "ip",
      registry: "rdap.arin.net",
      rdapUrl: "https://rdap.arin.net/registry/ip/198.51.100.7",
      name: "EXAMPLE-NET",
      handle: "NET-1",
      startAddress: null,
      endAddress: null,
      cidrs: ["198.51.100.0/24"],
      country: null,
      abuseEmails: ["abuse@example.net"],
      abuseName: null,
    })
    expect(text.split("\n").slice(0, 2)).toEqual([
      "Subject: Abuse report for 198.51.100.7, 2026-09-19 to 2026-09-26",
      "To: abuse@example.net",
    ])
    expect(text).toContain("Registry record (rdap.arin.net): EXAMPLE-NET / NET-1, 198.51.100.0/24")
  })

  it("names the CrowdSec scenarios and keeps manual decisions anonymous", () => {
    const text = formatAbuseReportText(
      report({
        ips: [
          ip({
            alerts: [alert(), alert({ scenario: "manual", kind: null, eventsCount: 1 })],
            decisions: [
              { type: "ban", scope: "Ip", value: "x", origin: "geometrikks", scenario: "manual", duration: "2h" },
            ],
          }),
        ],
      }),
    )
    expect(text.replace(/\s+/g, " ")).toContain("CrowdSec flagged it for crowdsecurity/http-probing.")
    expect(text).toContain("- manual decision: 1 detection, 1 event")
    expect(text).toContain("- ban for 2h00m more: manual")
  })

  it("lists the busiest addresses of an ASN", () => {
    const text = formatAbuseReportText(
      report({
        target: { kind: "asn", ipAddress: null, asn: 64500, asnOrganization: "Example Hosting", asnDrop: false },
        ipCount: 40,
        totalRequests: 900,
        status4xx: 630,
        ips: [ip(), ip({ ipAddress: "198.51.100.8", alerts: [alert()] })],
      }),
    )
    const flat = text.replace(/\s+/g, " ")
    expect(flat).toContain("40 IP addresses in AS64500 (Example Hosting) sent 900 HTTP")
    // The share covers the same 900 requests, not only the listed addresses.
    expect(flat).toContain("70% of those requests got a 4xx response")
    expect(text).toContain("The 2 busiest addresses of the 40:")
    expect(flat).toContain("CrowdSec flagged 1 of the 2 addresses listed below")
    expect(text).toContain("== 198.51.100.8 ==")
  })

  it("asks for nothing when the address sent nothing", () => {
    const quiet = ip({ totalRequests: 0, status4xx: 0, lines: [], paths: [], userAgents: [], peak: null })
    const text = formatAbuseReportText(report({ totalRequests: 0, status4xx: 0, ips: [quiet] })).replace(/\s+/g, " ")
    expect(text).toContain("sent no HTTP requests")
    expect(text).not.toContain("Please investigate")
  })

  it("wraps a long list of decision scenarios", () => {
    const decisions = Array.from({ length: 6 }, (_, n) => ({
      type: "ban", scope: "Ip", value: "x", origin: "crowdsec", scenario: `crowdsecurity/scenario-number-${n}`, duration: "2h",
    }))
    const text = formatAbuseReportText(report({ ips: [ip({ decisions })] }))
    const block = text.split("Active CrowdSec decisions:\n")[1].split("\nMost requested paths:")[0]
    expect(block.split("\n").length).toBeGreaterThan(1)
    expect(block.split("\n").every((line) => line.length <= 76)).toBe(true)
  })

  it("says when the alert limit left nothing to list", () => {
    const text = formatAbuseReportText(report({ ips: [ip({ alerts: [], alertsTruncated: true })] }))
    expect(text).toContain("CrowdSec detections: too many to fetch for this period.")
  })

  it("wraps prose at the email width", () => {
    const text = formatAbuseReportText(report())
    const prose = text.split("\n\n")[2]
    expect(prose.split("\n").every((line) => line.length <= WRAP_WIDTH)).toBe(true)
  })
})

describe("DROP listings in the text", () => {
  const listedIp = ip({ dropNetwork: { cidr: "198.51.100.0/24", sblId: "SBL000042" }, asnDrop: true })

  it("adds the Listed on line after the Network line", () => {
    const lines = formatAbuseReportText(report({ ips: [listedIp] })).split("\n")
    const network = lines.indexOf("Network: AS64500 Example Hosting, US")
    expect(lines[network + 1]).toBe("Listed on: Spamhaus DROP SBL000042 (198.51.100.0/24), ASN-DROP AS64500")
  })

  it("lists only the listings that apply", () => {
    const networkOnly = formatAbuseReportText(report({ ips: [ip({ dropNetwork: listedIp.dropNetwork })] }))
    const asnOnly = formatAbuseReportText(report({ ips: [ip({ asnDrop: true })] }))
    expect(networkOnly).toContain("\nListed on: Spamhaus DROP SBL000042 (198.51.100.0/24)\n")
    expect(asnOnly).toContain("\nListed on: ASN-DROP AS64500\n")
  })

  it("has no Listed on line without a listing", () => {
    expect(formatAbuseReportText(report())).not.toContain("Listed on:")
  })

  it("lists an ASN-DROP target with no address rows", () => {
    const target = { kind: "asn" as const, ipAddress: null, asn: 64500, asnOrganization: "Example Hosting", asnDrop: true }
    const empty = { target, ipCount: 0, totalRequests: 0, status4xx: 0, ips: [] }
    const lines = formatAbuseReportText(report(empty)).split("\n")
    expect(lines.filter((line) => line.startsWith("Listed on:"))).toEqual(["Listed on: ASN-DROP AS64500"])
    const unlisted = formatAbuseReportText(report({ ...empty, target: { ...target, asnDrop: false } }))
    expect(unlisted).not.toContain("Listed on:")
  })

  it("keeps the ASN listing on the address rows when there are some", () => {
    const target = { kind: "asn" as const, ipAddress: null, asn: 64500, asnOrganization: "Example Hosting", asnDrop: true }
    const text = formatAbuseReportText(report({ target, ips: [ip({ asnDrop: true })] }))
    expect(text.match(/^Listed on:.*$/gm)).toEqual(["Listed on: ASN-DROP AS64500"])
  })

  it("links each SBL record once, before the address sections", () => {
    const otherNetwork = { cidr: "203.0.113.0/24", sblId: "SBL000099" }
    const target = { kind: "asn" as const, ipAddress: null, asn: 64500, asnOrganization: null, asnDrop: false }
    const text = formatAbuseReportText(
      report({
        target,
        ips: [
          ip({ ipAddress: "198.51.100.7", dropNetwork: listedIp.dropNetwork }),
          ip({ ipAddress: "198.51.100.8", dropNetwork: listedIp.dropNetwork }),
          ip({ ipAddress: "203.0.113.1", dropNetwork: otherNetwork }),
        ],
      }),
    )
    expect(text).toContain(
      "\nSpamhaus DROP records:\n" +
        "SBL000042 (198.51.100.0/24): https://check.spamhaus.org/sbl/query/SBL000042\n" +
        "SBL000099 (203.0.113.0/24): https://check.spamhaus.org/sbl/query/SBL000099\n\n",
    )
    expect(text.indexOf("Spamhaus DROP records:")).toBeLessThan(text.indexOf("== 198.51.100.7 =="))
    const single = formatAbuseReportText(report({ ips: [listedIp] }))
    expect(single).toContain("\nSpamhaus DROP record:\nSBL000042 (198.51.100.0/24): https://check.spamhaus.org/sbl/query/SBL000042\n")
    expect(formatAbuseReportText(report({ ips: [ip({ asnDrop: true })] }))).not.toContain("Spamhaus DROP record")
  })

  it("names the IPv4 network for an IPv4-mapped client", () => {
    const mappedIp = ip({ ipAddress: "::ffff:192.0.2.10", dropNetwork: { cidr: "192.0.2.0/24", sblId: "SBL000042" } })
    const target = { kind: "ip" as const, ipAddress: "::ffff:192.0.2.10", asn: 64500, asnOrganization: null, asnDrop: false }
    const text = formatAbuseReportText(report({ target, ips: [mappedIp] }))
    expect(text).toContain("::ffff:192.0.2.10")
    expect(text).toContain("\nNetwork: AS64500 Example Hosting, US\nListed on: Spamhaus DROP SBL000042 (192.0.2.0/24)\n")
  })
})

describe("reportDropListings and dropNoticeHeadline", () => {
  const dropNetwork = { cidr: "198.51.100.0/24", sblId: "SBL000042" }

  it("names the network and the ASN of an IP report", () => {
    const listed = report({
      target: { kind: "ip", ipAddress: "198.51.100.7", asn: 64500, asnOrganization: null, asnDrop: true },
      ips: [ip({ dropNetwork, asnDrop: true })],
    })
    const listings = reportDropListings(listed)
    expect(listings).toEqual({ dropNetwork, asnDropAsn: 64500, addressNetworks: [], addressCount: 0 })
    expect(dropNoticeHeadline(listings)).toBe("On the DROP list as SBL000042 (198.51.100.0/24), and AS64500 is on ASN-DROP.")
  })

  const unlisted = { dropNetwork: null, asnDropAsn: null, addressNetworks: [], addressCount: 0 }

  it("names one listing alone", () => {
    expect(dropNoticeHeadline({ ...unlisted, dropNetwork })).toBe("On the DROP list as SBL000042 (198.51.100.0/24).")
    expect(dropNoticeHeadline({ ...unlisted, asnDropAsn: 64500 })).toBe("AS64500 is on ASN-DROP.")
    expect(dropNoticeHeadline(unlisted)).toBeNull()
  })

  const asnTarget = { kind: "asn" as const, ipAddress: null, asn: 64500, asnOrganization: null, asnDrop: true }
  const otherNetwork = { cidr: "203.0.113.0/24", sblId: "SBL000099" }

  it("collects the DROP networks of an ASN report's addresses, the fullest first", () => {
    const asnReport = report({
      target: asnTarget,
      ips: [
        ip({ ipAddress: "203.0.113.1", dropNetwork: otherNetwork }),
        ip({ ipAddress: "198.51.100.7", dropNetwork, asnDrop: true }),
        ip({ ipAddress: "198.51.100.8", dropNetwork, asnDrop: true }),
        ip({ ipAddress: "192.0.2.1" }),
      ],
    })
    expect(reportDropListings(asnReport)).toEqual({
      dropNetwork: null,
      asnDropAsn: 64500,
      addressNetworks: [{ ...dropNetwork, addresses: 2 }, { ...otherNetwork, addresses: 1 }],
      addressCount: 4,
    })
    expect(dropNoticeHeadline(reportDropListings(asnReport))).toBe(
      "AS64500 is on ASN-DROP, and 3 of the 4 addresses the report lists are in DROP networks.",
    )
  })

  it("says when every address of an ASN report is in one DROP network", () => {
    const asnReport = report({
      target: { ...asnTarget, asnDrop: false },
      ips: [ip({ ipAddress: "198.51.100.7", dropNetwork }), ip({ ipAddress: "198.51.100.8", dropNetwork })],
    })
    expect(dropNoticeHeadline(reportDropListings(asnReport))).toBe("All 2 addresses the report lists are in a DROP network.")
    const single = report({ target: { ...asnTarget, asnDrop: false }, ips: [ip({ dropNetwork })] })
    expect(dropNoticeHeadline(reportDropListings(single))).toBe("The one address the report lists is in a DROP network.")
  })
})

describe("titleDropBadgeKind", () => {
  const dropNetwork = { cidr: "198.51.100.0/24", sblId: "SBL000042" }

  it("prefers the network listing when both apply", () => {
    expect(titleDropBadgeKind({ dropNetwork, asnDropAsn: 64500 })).toBe("network")
    expect(titleDropBadgeKind({ dropNetwork, asnDropAsn: null })).toBe("network")
  })

  it("badges an IP whose ASN alone is on ASN-DROP", () => {
    const listed = report({
      target: { kind: "ip", ipAddress: "203.0.113.9", asn: 64500, asnOrganization: null, asnDrop: true },
      ips: [ip({ ipAddress: "203.0.113.9", dropNetwork: null, asnDrop: true })],
    })
    expect(titleDropBadgeKind(reportDropListings(listed))).toBe("asn")
  })

  it("badges a listed ASN report and nothing when unlisted", () => {
    const asnReport = report({
      target: { kind: "asn", ipAddress: null, asn: 64500, asnOrganization: null, asnDrop: true },
      ips: [ip({ dropNetwork, asnDrop: true })],
    })
    expect(titleDropBadgeKind(reportDropListings(asnReport))).toBe("asn")
    expect(titleDropBadgeKind({ dropNetwork: null, asnDropAsn: null })).toBeNull()
  })
})

describe("blacklistedAddressCount", () => {
  it("counts listed addresses, matching any IPv6 spelling", () => {
    const blacklist = new Set(["192.0.2.1", "2600:1f18::1"])
    const ips = [{ ipAddress: "192.0.2.1" }, { ipAddress: "2600:1F18:0:0::1" }, { ipAddress: "192.0.2.9" }]
    expect(blacklistedAddressCount(ips, blacklist)).toBe(2)
  })
})

describe("blacklistNoticeHeadline", () => {
  it("says an IP report's IP is listed", () => {
    expect(blacklistNoticeHeadline("ip", 1, 1)).toBe("On AbuseIPDB's blacklist, with a 100% abuse confidence score.")
  })
  it("returns null when nothing is listed", () => {
    expect(blacklistNoticeHeadline("ip", 0, 1)).toBeNull()
    expect(blacklistNoticeHeadline("asn", 0, 25)).toBeNull()
  })
  it("counts an ASN report's listed addresses", () => {
    expect(blacklistNoticeHeadline("asn", 3, 25)).toBe("3 of the 25 addresses the report lists are on AbuseIPDB's blacklist.")
    expect(blacklistNoticeHeadline("asn", 1, 25)).toBe("1 of the 25 addresses the report lists is on AbuseIPDB's blacklist.")
    expect(blacklistNoticeHeadline("asn", 25, 25)).toBe("All 25 addresses the report lists are on AbuseIPDB's blacklist.")
    expect(blacklistNoticeHeadline("asn", 1, 1)).toBe("The one address the report lists is on AbuseIPDB's blacklist.")
  })
})

describe("reportIsFor", () => {
  const asnTarget = { kind: "asn" as const, ipAddress: null, asn: 64500, asnOrganization: null, asnDrop: true }

  it("matches the same IP whatever the other options", () => {
    expect(reportIsFor(report(), { kind: "ip", ip: "198.51.100.7" })).toBe(true)
    expect(reportIsFor(report(), { kind: "ip", ip: "198.51.100.8" })).toBe(false)
  })

  it("matches the same ASN", () => {
    expect(reportIsFor(report({ target: asnTarget }), { kind: "asn", asn: 64500 })).toBe(true)
    expect(reportIsFor(report({ target: asnTarget }), { kind: "asn", asn: 64501 })).toBe(false)
  })

  it("never matches across a scope switch", () => {
    expect(reportIsFor(report(), { kind: "asn", asn: 64500 })).toBe(false)
    expect(reportIsFor(report({ target: asnTarget }), { kind: "ip", ip: "198.51.100.7" })).toBe(false)
  })
})

describe("formatAbuseReportCsv", () => {
  it("writes one row per log line, quoted per RFC 4180", () => {
    const rows = formatAbuseReportCsv(report()).trimEnd().split("\r\n")
    expect(rows[0]).toBe(CSV_COLUMNS.join(","))
    expect(rows[0]).toBe(
      "timestamp_utc,source_ip,asn,as_organization,country,method,path,http_version,status,bytes,user_agent,drop_network,drop_sbl",
    )
    expect(rows[1]).toBe(
      '2026-09-25T09:30:00.000Z,198.51.100.7,64500,Example Hosting,US,GET,/.env,HTTP/1.1,404,153,"say ""hi""",,',
    )
  })

  it("fills the DROP columns for a listed IP", () => {
    const listed = ip({ dropNetwork: { cidr: "198.51.100.0/24", sblId: "SBL000042" } })
    const rows = formatAbuseReportCsv(report({ ips: [listed] })).trimEnd().split("\r\n")
    expect(rows[1]).toBe(
      '2026-09-25T09:30:00.000Z,198.51.100.7,64500,Example Hosting,US,GET,/.env,HTTP/1.1,404,153,"say ""hi""",198.51.100.0/24,SBL000042',
    )
  })

  it("keeps the 0.19.0 columns in place for scripts that read by position", () => {
    const shipped = ["timestamp_utc", "source_ip", "asn", "as_organization", "country", "method", "path", "http_version", "status", "bytes", "user_agent"]
    expect(CSV_COLUMNS.slice(0, shipped.length)).toEqual(shipped)
  })

  it("defuses cells a spreadsheet would run as formulas", () => {
    const line = { ...ip().lines[0], userAgent: "=HYPERLINK(\"http://x\")" }
    const csv = formatAbuseReportCsv(report({ ips: [ip({ lines: [line] })] }))
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")"`)
  })
})

describe("reportFileName", () => {
  it("names IPv6 files without colons", () => {
    const r = report({ target: { kind: "ip", ipAddress: "2001:db8::1", asn: null, asnOrganization: null, asnDrop: false } })
    expect(reportFileName(r, "txt")).toBe("abuse-report-2001-db8--1-2026-09-26.txt")
  })
})
