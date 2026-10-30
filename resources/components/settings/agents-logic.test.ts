import { describe, expect, it } from "vitest"
import type { Advisory, HealthResponse, InstanceView, InstancesResponse } from "@/generated/api/types.gen"
import {
  agentAdvisoryCards,
  agentIngestionState,
  agentInstances,
  agentSummary,
  agentsNeedingAttention,
  canRemove,
  deepLinkScrollDelta,
  errorHeadline,
  instanceDetailSections,
  instanceHeaderLine,
  instanceRowLine,
  instanceSearchValue,
  instanceStatusLabel,
  instancesErrorState,
  jobReportState,
  liveTone,
  problemHeadline,
  schemaWaitState,
  sourceReasonLabel,
  shortVersion,
  versionTone,
} from "./agents-logic"

function makeProblem(id: string, severity: Advisory["severity"], summary = `${id} summary`): Advisory {
  return { id, severity, summary }
}

function makeInstance(overrides: Partial<InstanceView> = {}): InstanceView {
  return {
    instanceName: "edge",
    mode: "agent",
    appVersion: "0.20.0",
    schemaRevision: "7c1e9a",
    bootId: "boot-edge",
    startedAt: "2026-10-17T08:00:00+00:00",
    lastSeen: "2026-10-17T10:00:00+00:00",
    isSelf: false,
    checkingIn: true,
    status: "ok",
    problems: [],
    payload: null,
    health: null,
    serverLocations: [],
    ...overrides,
  }
}

const HEAD = makeInstance({ instanceName: "head", mode: "full", bootId: "boot-head", isSelf: true })

function makeResponse(instances: InstanceView[]): InstancesResponse {
  return {
    checkedAt: "2026-10-17T10:00:30+00:00",
    head: { instanceName: "head", appVersion: "0.20.0", schemaRevision: "7c1e9a" },
    instances,
  }
}

const NOT_CHECKING_IN = makeInstance({
  instanceName: "nas",
  checkingIn: false,
  status: "critical",
  problems: [makeProblem("instance-not-checking-in", "critical")],
})
const OUTDATED = makeInstance({
  instanceName: "edge-traefik",
  status: "critical",
  problems: [
    makeProblem("instance-schema-behind", "critical", "edge-traefik runs an older database migration than the head."),
    makeProblem("instance-name-not-set", "warning"),
    makeProblem("geoip-asn-stale", "warning"),
  ],
})
const VERSION_DRIFT = makeInstance({
  instanceName: "vps",
  status: "warning",
  problems: [makeProblem("instance-version-mismatch", "warning")],
})
const HEALTHY = makeInstance({ instanceName: "pi" })

describe("agentInstances", () => {
  it("returns every instance except the head itself", () => {
    const names = agentInstances(makeResponse([HEAD, HEALTHY, OUTDATED])).map((instance) => instance.instanceName)
    expect(names).toEqual(["pi", "edge-traefik"])
  })
  it("is empty while loading", () => {
    expect(agentInstances(undefined)).toEqual([])
  })
})

describe("agentsNeedingAttention", () => {
  it("excludes healthy agents and the head, even when the head has problems", () => {
    const head = { ...HEAD, status: "warning" as const, problems: [makeProblem("geoip-stale", "warning")] }
    const names = agentsNeedingAttention(makeResponse([head, HEALTHY, VERSION_DRIFT, NOT_CHECKING_IN])).map(
      (instance) => instance.instanceName,
    )
    expect(names).toEqual(["vps", "nas"])
  })
})

describe("agentSummary", () => {
  it("is null when the head is the only instance", () => {
    expect(agentSummary(makeResponse([HEAD]))).toBeNull()
    expect(agentSummary(undefined)).toBeNull()
  })
  it("says all healthy and is emerald when no agent has a problem", () => {
    expect(agentSummary(makeResponse([HEAD, HEALTHY, makeInstance({ instanceName: "vps" })]))).toEqual({
      tone: "emerald",
      line: "2 agents, all healthy",
    })
  })
  it("uses the singular for one agent", () => {
    expect(agentSummary(makeResponse([HEAD, HEALTHY]))?.line).toBe("1 agent, healthy")
  })
  it("counts agents per problem kind, with schema and version drift both out of date", () => {
    const summary = agentSummary(makeResponse([HEAD, HEALTHY, OUTDATED, VERSION_DRIFT, NOT_CHECKING_IN]))
    expect(summary?.line).toBe("4 agents, 1 not checking in, 2 out of date, 1 unnamed, 1 needs attention")
  })
  it("counts an agent whose writes fail", () => {
    const failing = makeInstance({
      instanceName: "edge-json",
      status: "critical",
      problems: [makeProblem("instance-writes-failing", "critical")],
    })
    expect(agentSummary(makeResponse([HEAD, HEALTHY, failing]))).toEqual({
      tone: "red",
      line: "2 agents, 1 with failing writes",
    })
  })
  it("counts an agent on a newer migration apart from the out of date ones", () => {
    const newer = makeInstance({
      instanceName: "edge-new",
      status: "critical",
      problems: [makeProblem("instance-schema-ahead", "critical")],
    })
    const summary = agentSummary(makeResponse([HEAD, OUTDATED, VERSION_DRIFT, newer]))
    expect(summary?.line).toBe("3 agents, 2 out of date, 1 newer than the head, 1 unnamed, 1 needs attention")
  })
  it("counts an agent once per kind even when it has two problems of that kind", () => {
    const twoForwarded = makeInstance({
      instanceName: "edge",
      status: "warning",
      problems: [makeProblem("geoip-stale", "warning"), makeProblem("geoip-asn-stale", "warning")],
    })
    expect(agentSummary(makeResponse([HEAD, twoForwarded]))?.line).toBe("1 agent, 1 needs attention")
  })
  it("takes the worst tone across agents", () => {
    expect(agentSummary(makeResponse([HEAD, HEALTHY, VERSION_DRIFT]))?.tone).toBe("amber")
    expect(agentSummary(makeResponse([HEAD, VERSION_DRIFT, NOT_CHECKING_IN]))?.tone).toBe("red")
  })
  it("ignores the head's own problems", () => {
    const head = { ...HEAD, status: "critical" as const, problems: [makeProblem("db-down", "critical")] }
    expect(agentSummary(makeResponse([head, HEALTHY]))).toEqual({ tone: "emerald", line: "1 agent, healthy" })
  })
})

describe("agentAdvisoryCards", () => {
  it("gives one card per agent with the worst problem and the count of the rest", () => {
    expect(agentAdvisoryCards(makeResponse([HEAD, HEALTHY, OUTDATED, VERSION_DRIFT]))).toEqual([
      {
        instanceName: "edge-traefik",
        tone: "red",
        summary: "edge-traefik runs an older database migration than the head.",
        moreCount: 2,
        lastSeenAgo: "30s ago",
      },
      {
        instanceName: "vps",
        tone: "amber",
        summary: "instance-version-mismatch summary",
        moreCount: 0,
        lastSeenAgo: "30s ago",
      },
    ])
  })
  it("measures last seen against the head's check time", () => {
    const stale = makeInstance({
      instanceName: "old",
      status: "critical",
      checkingIn: false,
      lastSeen: "2026-10-15T09:00:00+00:00",
      problems: [makeProblem("instance-not-checking-in", "critical")],
    })
    expect(agentAdvisoryCards(makeResponse([HEAD, stale]))[0].lastSeenAgo).toBe("2d ago")
  })
  it("is empty when every agent is healthy", () => {
    expect(agentAdvisoryCards(makeResponse([HEAD, HEALTHY]))).toEqual([])
  })
})

describe("canRemove", () => {
  it("is false for the head itself", () => {
    expect(canRemove({ ...HEAD, checkingIn: false })).toBe(false)
  })
  it("is false for an agent that is still checking in", () => {
    expect(canRemove(HEALTHY)).toBe(false)
  })
  it("is true for an agent that stopped checking in", () => {
    expect(canRemove(NOT_CHECKING_IN)).toBe(true)
  })
})

describe("instancesErrorState", () => {
  it("is error when the query failed and nothing was ever loaded", () => {
    expect(instancesErrorState(true, undefined)).toBe("error")
  })
  it("is error when the query failed even though stale data is cached", () => {
    expect(instancesErrorState(true, makeResponse([HEAD, HEALTHY]))).toBe("error")
  })
  it("is loading before the first answer", () => {
    expect(instancesErrorState(false, undefined)).toBe("loading")
  })
  it("is ready once data arrived", () => {
    expect(instancesErrorState(false, makeResponse([HEAD]))).toBe("ready")
  })
})

describe("versionTone", () => {
  const head = { instanceName: "head", appVersion: "0.20.0", schemaRevision: "7c1e9a" }
  it("is red when the migration differs", () => {
    expect(versionTone(makeInstance({ appVersion: "0.19.2", schemaRevision: "4b02d1" }), head)).toBe("red")
  })
  it("is amber when only the version differs", () => {
    expect(versionTone(makeInstance({ appVersion: "0.20.1" }), head)).toBe("amber")
  })
  it("is null when both match", () => {
    expect(versionTone(makeInstance(), head)).toBeNull()
  })
  it("ignores a local suffix", () => {
    expect(versionTone(makeInstance({ appVersion: "0.20.0+g52b67d62c" }), head)).toBeNull()
  })
  it("stays quiet for a local build", () => {
    expect(versionTone(makeInstance({ appVersion: "0.0.0+local" }), head)).toBeNull()
  })
})

describe("jobReportState", () => {
  it("maps the scheduler outcomes", () => {
    expect(jobReportState({ lastStatus: "success" })).toEqual({ tone: "emerald", label: "ok" })
    expect(jobReportState({ lastStatus: "error" })).toEqual({ tone: "red", label: "failed" })
    expect(jobReportState({ lastStatus: "missed" })).toEqual({ tone: "amber", label: "missed" })
  })
  it("is muted when the job has not run or the status is unknown", () => {
    expect(jobReportState({ lastStatus: null })).toEqual({ tone: "muted", label: "not run yet" })
    expect(jobReportState({})).toEqual({ tone: "muted", label: "not run yet" })
    expect(jobReportState({ lastStatus: "paused" })).toEqual({ tone: "muted", label: "paused" })
  })
})

describe("sourceReasonLabel", () => {
  it("names each known reason", () => {
    expect(sourceReasonLabel("missing")).toBe("missing")
    expect(sourceReasonLabel("unreadable")).toBe("not readable")
    expect(sourceReasonLabel("rejected")).toBe("rejected by Loki")
    expect(sourceReasonLabel("unreachable")).toBe("unreachable")
  })
  it("falls back for an empty or unknown reason", () => {
    expect(sourceReasonLabel("")).toBe("unavailable")
    expect(sourceReasonLabel(null)).toBe("unavailable")
    expect(sourceReasonLabel(undefined)).toBe("unavailable")
    expect(sourceReasonLabel("throttled")).toBe("throttled")
  })
})

describe("schemaWaitState", () => {
  it("is null when the instance never waits for the schema", () => {
    expect(schemaWaitState(null)).toBeNull()
    expect(schemaWaitState(undefined)).toBeNull()
  })
  it("labels each outcome", () => {
    expect(schemaWaitState("ready")).toEqual({ tone: "emerald", label: "ready" })
    expect(schemaWaitState("waiting")).toEqual({ tone: "amber", label: "waiting for the head to migrate" })
    expect(schemaWaitState("newer")).toEqual({ tone: "amber", label: "database is ahead of this build" })
    expect(schemaWaitState("timeout")).toEqual({ tone: "red", label: "gave up waiting" })
  })
})

describe("agentIngestionState", () => {
  function makeIngestion(overrides: Partial<HealthResponse["ingestion"]> = {}): HealthResponse["ingestion"] {
    return { running: true, parsedLines: 10, pendingRecords: 0, missingFiles: [], lastRecordAt: null, ...overrides }
  }
  it("is muted when the agent sent no health report", () => {
    expect(agentIngestionState(undefined, null)).toEqual({ tone: "muted", label: "unknown" })
  })
  it("is muted when ingestion is turned off", () => {
    expect(agentIngestionState(makeIngestion({ status: "disabled", running: false }), 0).label).toBe("turned off")
  })
  it("is amber when not running", () => {
    expect(agentIngestionState(makeIngestion({ running: false }), 0)).toEqual({ tone: "amber", label: "not running" })
  })
  it("is red when writes failed in the last 5 minutes", () => {
    expect(agentIngestionState(makeIngestion(), 4)).toEqual({ tone: "red", label: "running, writes failing" })
  })
  it("is amber when a source is unavailable", () => {
    const ingestion = makeIngestion({ unavailableSources: [{ kind: "file", label: "/logs/a.log", reason: "missing" }] })
    expect(agentIngestionState(ingestion, 0)).toEqual({ tone: "amber", label: "running, a source is unavailable" })
  })
  it("ignores failures older than 5 minutes", () => {
    expect(agentIngestionState(makeIngestion({ failedBatches: 3 }), 0)).toEqual({ tone: "emerald", label: "running" })
    expect(agentIngestionState(makeIngestion(), null)).toEqual({ tone: "emerald", label: "running" })
  })
})

describe("instanceStatusLabel", () => {
  it("names each status in words for screen readers", () => {
    expect(instanceStatusLabel("ok")).toBe("Healthy")
    expect(instanceStatusLabel("warning")).toBe("Needs attention")
    expect(instanceStatusLabel("critical")).toBe("Critical")
  })
})

describe("instanceSearchValue", () => {
  it("keeps a string name", () => {
    expect(instanceSearchValue("edge-traefik")).toBe("edge-traefik")
  })
  it("turns names the router parsed as numbers or booleans back into strings", () => {
    expect(instanceSearchValue(123)).toBe("123")
    expect(instanceSearchValue(true)).toBe("true")
    expect(instanceSearchValue(false)).toBe("false")
  })
  it("drops empty and non-scalar values", () => {
    expect(instanceSearchValue("")).toBeUndefined()
    expect(instanceSearchValue(undefined)).toBeUndefined()
    expect(instanceSearchValue(null)).toBeUndefined()
    expect(instanceSearchValue(["a"])).toBeUndefined()
    expect(instanceSearchValue({ name: "a" })).toBeUndefined()
  })
})

const CHECKED_AT = Date.parse("2026-10-17T10:00:30+00:00")

function makeHealth(overrides: Partial<HealthResponse> = {}): HealthResponse {
  return {
    status: "healthy",
    timestamp: "2026-10-17T10:00:00+00:00",
    startedAt: "2026-10-17T08:00:00+00:00",
    crowdsec: { enabled: false, lapiReachable: null },
    database: { reachable: true },
    geoip: { available: true, dbBuildDate: "2026-10-14T00:00:00+00:00", asnAvailable: true },
    ingestion: { running: true, parsedLines: 52310, pendingRecords: 0, missingFiles: [], lastRecordAt: null },
    ...overrides,
  } as HealthResponse
}

function sectionById(instance: InstanceView, id: string) {
  return instanceDetailSections(instance, CHECKED_AT).find((section) => section.id === id)
}

function partsText(parts: { text: string }[]): string {
  return parts.map((part) => part.text).join(" · ")
}

describe("problemHeadline", () => {
  it("uses fixed words for the problems the head computes", () => {
    expect(problemHeadline(makeProblem("instance-not-checking-in", "critical"), "nas")).toBe("Not checking in")
    expect(problemHeadline(makeProblem("instance-version-mismatch", "warning"), "nas")).toBe("Out of date")
    expect(problemHeadline(makeProblem("instance-schema-behind", "critical"), "nas")).toBe("Out of date")
  })
  it("drops the agent's name from its own sentence", () => {
    const restarting = makeProblem("instance-restart-loop", "warning", "traefik started 4 times in the last hour.")
    expect(problemHeadline(restarting, "traefik")).toBe("Started 4 times in the last hour")
  })
  it("shortens an unreadable source", () => {
    const missing = makeProblem("instance-ingestion-degraded", "warning", "caddy cannot read /var/log/caddy.log.")
    expect(problemHeadline(missing, "caddy")).toBe("Can't read /var/log/caddy.log")
    const stopped = makeProblem("instance-ingestion-degraded", "warning", "Ingestion on caddy is not running.")
    expect(problemHeadline(stopped, "caddy")).toBe("Ingestion not running")
  })
  it("says whether all or some writes fail", () => {
    expect(problemHeadline(makeProblem("instance-writes-failing", "critical"), "nas")).toBe("Writes failing")
    expect(problemHeadline(makeProblem("instance-writes-failing", "warning"), "nas")).toBe("Some writes failing")
  })
  it("shortens the write failures an instance reports about itself", () => {
    expect(problemHeadline(makeProblem("ingestion-write-failures", "critical"), "head")).toBe("Writes failing")
    expect(problemHeadline(makeProblem("ingestion-write-failures", "warning"), "head")).toBe("Writes failed since startup")
  })
  it("keeps a forwarded summary", () => {
    const forwarded = makeProblem("geoip-asn-stale", "warning", "The ASN database is old.")
    expect(problemHeadline(forwarded, "nas")).toBe("The ASN database is old")
  })
})

describe("instanceRowLine", () => {
  it("names the worst problem and counts the rest", () => {
    expect(partsText(instanceRowLine(OUTDATED))).toBe("Out of date · 2 more problems")
    expect(partsText(instanceRowLine(NOT_CHECKING_IN))).toBe("Not checking in")
  })
  it("says writes are failing instead of Healthy", () => {
    const failing = makeInstance({
      status: "warning",
      problems: [makeProblem("instance-writes-failing", "warning", "edge could not write 14 of 304 records in the last 5 minutes.")],
      payload: { lines5M: 290, failed5M: 14, written5M: 290, sources: [{ label: "/logs/a.log" }] },
    })
    expect(partsText(instanceRowLine(failing))).toBe("Some writes failing")
  })
  it("says a healthy agent's 5-minute line count", () => {
    const healthy = makeInstance({
      payload: { lines5M: 124, failed5M: 0, sources: [{ label: "/logs/a.log", available: true }] },
    })
    expect(partsText(instanceRowLine(healthy))).toBe("Healthy · 124 lines in 5 min")
  })
  it("says the count needs 5 minutes of heartbeats", () => {
    const fresh = makeInstance({ payload: { lines5M: null, sources: [{ label: "/logs/a.log" }] } })
    expect(partsText(instanceRowLine(fresh))).toBe("Healthy · line count needs 5 minutes of heartbeats")
  })
  it("describes a head without log sources", () => {
    expect(partsText(instanceRowLine(makeInstance({ isSelf: true, payload: { sources: [] } })))).toBe(
      "Healthy · serves the UI, no log sources",
    )
  })
  it("adds failed writes in red", () => {
    const failing = makeInstance({ payload: { lines5M: 87, failed5M: 14, sources: [{ label: "/logs/a.log" }] } })
    expect(instanceRowLine(failing).at(-1)).toEqual({ text: "14 failed", tone: "red" })
  })
})

describe("instanceHeaderLine", () => {
  const head = { instanceName: "head", appVersion: "0.23.0.dev5+g05b43030", schemaRevision: "7c1e9a" }
  it("says when it was seen, how long it has run and the version against the head", () => {
    const drifted = makeInstance({
      appVersion: "0.22.1",
      lastSeen: "2026-10-17T10:00:18+00:00",
      startedAt: "2026-10-15T07:00:30+00:00",
    })
    const groups = instanceHeaderLine(drifted, head, CHECKED_AT)
    expect(groups.map((group) => group.map((part) => part.text).join(""))).toEqual([
      "Seen 12s ago",
      "up 2d 3h",
      "v0.22.1, head v0.23.0-dev.5",
    ])
    expect(groups[2][0].tone).toBe("amber")
  })
  it("uses the Status wording for an agent that stopped checking in", () => {
    const stale = makeInstance({ appVersion: "0.23.0.dev5", checkingIn: false, lastSeen: "2026-10-14T10:00:30+00:00" })
    const groups = instanceHeaderLine(stale, head, CHECKED_AT)
    expect(groups.map((group) => group.map((part) => part.text).join(""))).toEqual([
      "Last seen 3d ago",
      "v0.23.0-dev.5",
      "details from its last heartbeat",
    ])
    expect(groups[0][0].tone).toBe("red")
  })
})

describe("shortVersion", () => {
  it("drops the local build suffix", () => {
    expect(shortVersion("0.23.0.dev5+g05b43030")).toBe("v0.23.0-dev.5")
  })
})

describe("errorHeadline", () => {
  it("drops the exception class prefixes", () => {
    const message =
      "(sqlalchemy.dialects.postgresql.asyncpg.IntegrityError) <class 'asyncpg.exceptions.NotNullViolationError'>: null value in column"
    expect(errorHeadline(message)).toBe("null value in column")
  })
  it("leaves a plain message alone", () => {
    expect(errorHeadline("connection refused")).toBe("connection refused")
  })
})

describe("liveTone", () => {
  it("greys out a light once the agent stops checking in", () => {
    expect(liveTone("emerald", true)).toBe("emerald")
    expect(liveTone("emerald", false)).toBe("muted")
    expect(liveTone("red", false)).toBe("muted")
  })
})

describe("instanceDetailSections", () => {
  const failing = makeInstance({
    health: makeHealth(),
    payload: {
      failed5M: 14,
      lastError: { message: "(IntegrityError) null value in column" },
      jobs: [
        { id: "geoip-refresh", name: "Refresh GeoLite2", lastStatus: "error", lastStart: "2026-10-16T09:00:00+00:00" },
        { id: "server-location-refresh", name: "Locate", lastStatus: "success" },
      ],
      sources: [{ label: "/logs/json.log", available: true, parsedLines: 39020, logFormat: "geometrikks-json" }],
    },
  })
  it("puts red and amber sections first and keeps the rest in order", () => {
    expect(instanceDetailSections(failing, CHECKED_AT).map((section) => section.id)).toEqual([
      "ingestion",
      "last-error",
      "jobs",
      "sources",
      "geoip",
      "instance",
      "server-locations",
    ])
  })
  it("summarizes failing writes, the last error and a failed job", () => {
    expect(partsText(sectionById(failing, "ingestion")!.summary)).toBe("Running, writes failing · 14 failed in 5 min")
    expect(partsText(sectionById(failing, "last-error")!.summary)).toBe("null value in column")
    expect(partsText(sectionById(failing, "jobs")!.summary)).toBe("Refresh GeoLite2 failed 1d ago · 1 ok")
    expect(partsText(sectionById(failing, "sources")!.summary)).toBe("/logs/json.log · 39,020 lines")
  })
  it("leaves out Last error when nothing failed", () => {
    expect(sectionById(makeInstance({ health: makeHealth(), payload: {} }), "last-error")).toBeUndefined()
  })
  it("names the format instead of repeating the line count", () => {
    const healthy = makeInstance({
      health: makeHealth(),
      payload: { sources: [{ label: "/logs/nginx.log", available: true, parsedLines: 52310, logFormat: "nginx" }] },
    })
    expect(partsText(sectionById(healthy, "ingestion")!.summary)).toBe("Running · 52,310 lines")
    expect(partsText(sectionById(healthy, "sources")!.summary)).toBe("/logs/nginx.log · nginx")
  })
  it("greys out live state from the last heartbeat of a stopped agent", () => {
    const stale = makeInstance({
      checkingIn: false,
      health: makeHealth(),
      payload: { sources: [{ label: "/logs/nginx.log", available: true, logFormat: "nginx" }] },
    })
    const ingestion = sectionById(stale, "ingestion")!
    expect(ingestion.tone).toBe("muted")
    expect(partsText(ingestion.summary)).toBe("Running when last seen · 52,310 lines")
    expect(sectionById(stale, "sources")!.tone).toBe("muted")
    expect(sectionById(stale, "geoip")!.tone).toBe("muted")
    expect(sectionById(stale, "instance")!.tone).toBe("muted")
  })
  it("marks an unreadable source red with its reason", () => {
    const missing = makeInstance({
      health: makeHealth(),
      payload: { sources: [{ label: "/logs/caddy.log", available: false, reason: "missing" }] },
    })
    const sources = sectionById(missing, "sources")!
    expect(sources.tone).toBe("red")
    expect(partsText(sources.summary)).toBe("/logs/caddy.log · missing")
  })
  it("has no recorded server locations as muted", () => {
    const none = sectionById(makeInstance(), "server-locations")!
    expect(none.tone).toBe("muted")
    expect(partsText(none.summary)).toBe("None recorded yet")
  })
})

describe("deepLinkScrollDelta", () => {
  const base = { viewportTop: 56, viewportBottom: 900, cardTop: 160, rowTop: 300, rowBottom: 340 }
  it("does not scroll when the details already show", () => {
    expect(deepLinkScrollDelta({ ...base, detailBottom: 800 })).toBe(0)
  })
  it("stops at the card's top so its title and headers stay in view", () => {
    expect(deepLinkScrollDelta({ ...base, detailBottom: 1600 })).toBe(104)
  })
  it("scrolls past the card when the row would stay out of view", () => {
    expect(deepLinkScrollDelta({ ...base, rowTop: 1300, rowBottom: 1340, detailBottom: 2200 })).toBe(1228)
  })
})
