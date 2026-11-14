import type { AbuseReportResponse, ReportIpDto } from "../../resources/generated/api/types.gen"

export const IP = "3.5.140.2"
export const MINUTE_MS = 60_000

export function minutesAgo(minutes: number) {
  return new Date(Date.now() - minutes * MINUTE_MS).toISOString()
}

// Fixed once, so a minute that turns mid-test can't move what the test expects.
export const FIRST_SEEN = minutesAgo(180)

export function ipEvidence(overrides: Partial<ReportIpDto> = {}): ReportIpDto {
  return {
    ipAddress: IP,
    alerts: [{
      createdAt: minutesAgo(170), decisions: [], eventsCount: 12, kind: null,
      scenario: "crowdsecurity/http-probing", startAt: minutesAgo(175), stopAt: minutesAgo(170),
    }],
    alertsTruncated: false,
    asn: 16509, asnDrop: false, asnOrganization: "Amazon.com, Inc.",
    countryCode: "US", countryName: "United States",
    // Someone else's detection, so it must tick no category and stay out of the comment.
    decisions: [{
      duration: "160h", origin: "CAPI", scenario: "crowdsecurity/community-ssh-bf",
      scope: "Ip", type: "ban", value: IP,
    }],
    distinctPaths: 2, dropNetwork: null,
    firstSeen: FIRST_SEEN, lastSeen: minutesAgo(30),
    lines: [], malformedRequests: 0,
    paths: [{ url: "/.env", hits: 300, errorHits: 300 }, { url: "/.git/config", hits: 98, errorHits: 98 }],
    peak: null,
    status2xx: 14, status3xx: 0, status4xx: 398, status5xx: 0,
    totalBytes: 41_200, totalRequests: 412,
    userAgents: [{ userAgent: "Mozilla/5.0 zgrab/0.x", hits: 412 }],
    ...overrides,
  }
}

export function evidence(ipEntry = ipEvidence()): AbuseReportResponse {
  return {
    crowdsec: { status: "ok", message: null },
    startDate: minutesAgo(24 * 60), endDate: new Date().toISOString(), generatedAt: new Date().toISOString(),
    granularity: "hourly", ipCount: 1, ips: [ipEntry], redactions: 3,
    status4xx: 398, totalRequests: 412,
    target: { kind: "ip", ipAddress: IP, asn: null, asnDrop: false, asnOrganization: null },
  }
}
