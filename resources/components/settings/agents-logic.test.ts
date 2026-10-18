import { describe, expect, it } from "vitest"
import type { Advisory, HealthResponse, InstanceView, InstancesResponse } from "@/generated/api/types.gen"
import {
  agentAdvisoryCards,
  agentIngestionState,
  agentInstances,
  agentSummary,
  agentsNeedingAttention,
  canRemove,
  instanceSearchValue,
  instanceStatusLabel,
  instancesErrorState,
  jobReportState,
  schemaWaitState,
  sourceReasonLabel,
  versionText,
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
      },
      { instanceName: "vps", tone: "amber", summary: "instance-version-mismatch summary", moreCount: 0 },
    ])
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

describe("versionText", () => {
  it("prefixes real versions and leaves unknown alone", () => {
    expect(versionText("0.20.0")).toBe("v0.20.0")
    expect(versionText("unknown")).toBe("unknown")
    expect(versionText("")).toBe("unknown")
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
