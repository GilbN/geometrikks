import { describe, expect, it } from "vitest"
import type { HealthResponse } from "@/lib/api"
import type {
  CrowdSecStatusResponse,
  HypertableStatsView,
  LogFileView,
  SchedulerJobView,
} from "@/generated/api/types.gen"
import type { LogRecord } from "@/lib/logstream"
import {
  compressionSummary,
  crowdsecState,
  databaseState,
  filterErrorRecords,
  formatApproxRows,
  formatSize,
  formatUptime,
  geoipState,
  ingestionState,
  lastEventState,
  liveFeedState,
  nginxLogFiles,
  overallState,
  relativeTime,
  schedulerJobState,
} from "./status-logic"

function makeHealth(overrides: Partial<HealthResponse> = {}): HealthResponse {
  return {
    status: "healthy",
    startedAt: "2026-07-31T07:00:00+00:00",
    ingestion: {
      running: true,
      parsedLines: 10,
      pendingRecords: 0,
      missingFiles: [],
      lastRecordAt: "2026-07-31T09:59:00+00:00",
    },
    database: { reachable: true },
    geoip: { available: true, dbBuildDate: "2026-07-28T00:00:00+00:00" },
    crowdsec: { enabled: true, lapiReachable: true },
    timestamp: "2026-07-31T10:00:00+00:00",
    ...overrides,
  }
}

const NOW = Date.parse("2026-07-31T10:00:00+00:00")

describe("overallState", () => {
  it("is red Unreachable when the health request itself fails", () => {
    expect(overallState(undefined, true)).toMatchObject({ tone: "red", label: "Unreachable" })
  })
  it("is muted while loading", () => {
    expect(overallState(undefined, false).tone).toBe("muted")
  })
  it("maps healthy to emerald and degraded to amber", () => {
    expect(overallState(makeHealth(), false)).toMatchObject({ tone: "emerald", label: "Healthy" })
    expect(overallState(makeHealth({ status: "degraded" }), false)).toMatchObject({
      tone: "amber",
      label: "Degraded",
    })
  })
})

describe("ingestionState", () => {
  it("is emerald Running when ingestion runs", () => {
    expect(ingestionState(makeHealth(), false)).toMatchObject({ tone: "emerald", label: "Running" })
  })
  it("is amber Not running with a hint when stopped", () => {
    const state = ingestionState(
      makeHealth({
        ingestion: {
          running: false,
          parsedLines: 0,
          pendingRecords: 0,
          missingFiles: [],
          lastRecordAt: null,
        },
      }),
      false,
    )
    expect(state.tone).toBe("amber")
    expect(state.label).toBe("Not running")
    expect(state.detail).toBeTruthy()
  })
  it("is amber when running but a tailed file is missing", () => {
    const state = ingestionState(
      makeHealth({
        ingestion: {
          running: true,
          parsedLines: 10,
          pendingRecords: 0,
          missingFiles: ["nginx_logs/access.log"],
          lastRecordAt: null,
        },
      }),
      false,
    )
    expect(state.tone).toBe("amber")
    expect(state.label).toBe("Running, log file missing")
    expect(state.detail).toBeTruthy()
  })
  it("is muted when health failed or is loading", () => {
    expect(ingestionState(undefined, true).tone).toBe("muted")
    expect(ingestionState(undefined, false).tone).toBe("muted")
  })
})

describe("databaseState / geoipState", () => {
  it("database unreachable is red", () => {
    expect(databaseState(makeHealth({ database: { reachable: false } }))).toMatchObject({
      tone: "red",
      label: "Unreachable",
    })
    expect(databaseState(makeHealth())).toMatchObject({ tone: "emerald", label: "Reachable" })
  })
  it("geoip missing is amber", () => {
    expect(geoipState(makeHealth({ geoip: { available: false, dbBuildDate: null } }))).toMatchObject({
      tone: "amber",
      label: "Missing",
    })
    expect(geoipState(makeHealth())).toMatchObject({ tone: "emerald", label: "Available" })
  })
})

describe("crowdsecState", () => {
  const enabled: CrowdSecStatusResponse = { enabled: true, writeEnabled: true, lapiReachable: true }
  it("disabled integration is muted Disabled", () => {
    expect(crowdsecState({ ...enabled, enabled: false }, false)).toMatchObject({
      tone: "muted",
      label: "Disabled",
    })
  })
  it("reachable LAPI is emerald, unreachable is red", () => {
    expect(crowdsecState(enabled, false)).toMatchObject({ tone: "emerald", label: "LAPI reachable" })
    expect(crowdsecState({ ...enabled, lapiReachable: false }, false)).toMatchObject({
      tone: "red",
      label: "LAPI unreachable",
    })
  })
  it("failed status query is muted Unavailable", () => {
    expect(crowdsecState(undefined, true)).toMatchObject({ tone: "muted", label: "Unavailable" })
  })
})

describe("nginxLogFiles", () => {
  const files: LogFileView[] = [
    { name: "geometrikks.log", kind: "app", sizeBytes: 10, modifiedAt: null, available: true },
    { name: "access.log", kind: "nginx", sizeBytes: 20, modifiedAt: null, available: false },
  ]
  it("keeps only nginx entries and tolerates undefined", () => {
    expect(nginxLogFiles(files).map((f) => f.name)).toEqual(["access.log"])
    expect(nginxLogFiles(undefined)).toEqual([])
  })
})

describe("formatSize", () => {
  it("formats B, KB, MB and GB", () => {
    expect(formatSize(512)).toBe("512 B")
    expect(formatSize(2048)).toBe("2.0 KB")
    expect(formatSize(3 * 1024 * 1024)).toBe("3.0 MB")
    expect(formatSize(107148991)).toBe("102.2 MB")
    expect(formatSize(4.5 * 1024 * 1024 * 1024)).toBe("4.5 GB")
  })
})

describe("formatApproxRows", () => {
  it("abbreviates large counts", () => {
    expect(formatApproxRows(739)).toBe("739")
    expect(formatApproxRows(2_234_663)).toBe("2.2M")
    expect(formatApproxRows(15_400)).toBe("15.4k")
    expect(formatApproxRows(null)).toBe("-")
  })
})

describe("compressionSummary", () => {
  const table = (before: number | null, after: number | null): HypertableStatsView => ({
    name: "t",
    approxRows: 1,
    totalBytes: 1,
    beforeCompressionBytes: before,
    afterCompressionBytes: after,
  })
  it("aggregates ratio across tables with compression stats", () => {
    const result = compressionSummary([
      table(400 * 1024 * 1024, 20 * 1024 * 1024),
      table(100 * 1024 * 1024, 30 * 1024 * 1024),
      table(null, null),
    ])
    expect(result).toBe("10.0x (500.0 MB compressed to 50.0 MB)")
  })
  it("is null when nothing is compressed yet", () => {
    expect(compressionSummary([table(null, null)])).toBeNull()
    expect(compressionSummary(undefined)).toBeNull()
  })
})

describe("relativeTime", () => {
  it("renders past, future and missing values", () => {
    expect(relativeTime("2026-07-31T09:57:00+00:00", NOW)).toBe("3m ago")
    expect(relativeTime("2026-08-02T10:00:00+00:00", NOW)).toBe("in 2d")
    expect(relativeTime(null, NOW)).toBe("never")
    expect(relativeTime(undefined, NOW)).toBe("never")
  })
  it("uses the largest sensible unit", () => {
    expect(relativeTime("2026-07-31T09:59:58+00:00", NOW)).toBe("2s ago")
    expect(relativeTime("2026-07-31T07:00:00+00:00", NOW)).toBe("3h ago")
  })
})

describe("formatUptime", () => {
  it("renders h/m for a started app and null when unknown", () => {
    expect(formatUptime("2026-07-31T07:48:00+00:00", NOW)).toBe("up 2h 12m")
    expect(formatUptime("2026-07-29T10:00:00+00:00", NOW)).toBe("up 2d 0h")
    expect(formatUptime("2026-07-31T09:59:30+00:00", NOW)).toBe("up <1m")
    expect(formatUptime(null, NOW)).toBeNull()
  })
})

describe("lastEventState", () => {
  it("is emerald with a recent event", () => {
    const state = lastEventState("2026-07-31T09:59:00+00:00", true, NOW)
    expect(state.tone).toBe("emerald")
    expect(state.label).toBe("1m ago")
  })
  it("is amber when running but stale beyond 15 minutes", () => {
    const state = lastEventState("2026-07-31T09:00:00+00:00", true, NOW)
    expect(state.tone).toBe("amber")
    expect(state.label).toBe("1h ago")
    expect(state.detail).toBeTruthy()
  })
  it("is muted when no event was ever ingested or not running", () => {
    expect(lastEventState(null, true, NOW)).toMatchObject({ tone: "muted", label: "never" })
    expect(lastEventState("2026-07-31T09:00:00+00:00", false, NOW).tone).toBe("muted")
  })
})

describe("schedulerJobState", () => {
  const job = (over: Partial<SchedulerJobView>): SchedulerJobView => ({
    id: "j",
    name: "Job",
    trigger: "interval",
    nextRunTime: null,
    lastRunTime: null,
    lastStatus: null,
    lastError: null,
    lastDurationSeconds: null,
    running: false,
    ...over,
  })
  it("maps states to tones", () => {
    expect(schedulerJobState(job({ running: true })).tone).toBe("cyan")
    expect(schedulerJobState(job({ lastStatus: "error" })).tone).toBe("red")
    expect(schedulerJobState(job({ lastStatus: "missed" })).tone).toBe("amber")
    expect(schedulerJobState(job({ lastStatus: "success" })).tone).toBe("emerald")
    expect(schedulerJobState(job({})).tone).toBe("muted")
  })
})

describe("filterErrorRecords", () => {
  const rec = (level: string | undefined, event: string): LogRecord => ({
    level,
    event,
    timestamp: "2026-07-31T09:00:00+00:00",
  })
  it("keeps only error/critical, newest last-in-first, capped", () => {
    const records = [
      rec("info", "a"),
      rec("error", "b"),
      rec("warning", "c"),
      rec("critical", "d"),
      rec(undefined, "e"),
      rec("error", "f"),
    ]
    expect(filterErrorRecords(records, 2).map((r) => r.event)).toEqual(["f", "d"])
    expect(filterErrorRecords(undefined, 5)).toEqual([])
  })
})

describe("liveFeedState", () => {
  it("maps socket states; disconnected warns because the page actively probes", () => {
    expect(liveFeedState("connected")).toMatchObject({ tone: "emerald", label: "Connected" })
    expect(liveFeedState("connecting").tone).toBe("amber")
    const down = liveFeedState("disconnected")
    expect(down.tone).toBe("amber")
    expect(down.label).toBe("Not connected")
    expect(down.detail).toBeTruthy()
  })
})
