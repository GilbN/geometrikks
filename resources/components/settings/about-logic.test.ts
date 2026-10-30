import { describe, expect, it } from "vitest"
import type { AboutResponse } from "@/generated/api/types.gen"
import {
  aboutDetailsText,
  databaseSummary,
  geoipSummary,
  migrationStatus,
  runtimeLabel,
  runtimeSummary,
  shortPostgresVersion,
  splitPath,
  startsOpen,
} from "./about-logic"

function makeAbout(overrides: Partial<AboutResponse> = {}): AboutResponse {
  return {
    app: {
      name: "GeoMetrikks",
      version: "0.22.0",
      commit: "391c3265e1f0a7d2b9c4e5f6a7b8c9d0e1f2a3b4",
      container: true,
      imageTag: null,
      environment: "production",
      startedAt: "2026-10-28T08:00:00Z",
      changelogDigest: null,
    },
    runtime: { pythonVersion: "3.13.16", litestarVersion: "2.25.0", apschedulerVersion: "3.11.3" },
    database: {
      postgresVersion: "18.6 (Ubuntu 18.6-1.pgdg22.04+2)",
      timescaledbVersion: "2.30.2",
      postgisVersion: "3.6.4",
      migrationRevision: "a41d7e6c2b95",
      migrationName: "add auth_sessions",
      migrationHead: "a41d7e6c2b95",
    },
    geoip: { available: true, ageDays: 7, buildDate: "2026-10-23T00:00:00Z", dbPath: "/app/data/geoip/GeoLite2-City.mmdb" },
    geoipAsn: { available: true, ageDays: 6, buildDate: "2026-10-24T00:00:00Z", dbPath: "/app/data/geoip/GeoLite2-ASN.mmdb" },
    geoipAsnEnabled: true,
    asnClassification: { dataset: "bad-asn-list", entries: 722, license: "MIT", sourceUrl: "https://example.test/list" },
    links: { repository: "https://github.com/GilbN/geometrikks", issues: "https://github.com/GilbN/geometrikks/issues" },
    ...overrides,
  }
}

const database = makeAbout().database

describe("shortPostgresVersion", () => {
  it("keeps the release and drops the packaging string", () => {
    expect(shortPostgresVersion("18.6 (Ubuntu 18.6-1.pgdg22.04+2)")).toBe("18.6")
  })

  it("leaves a bare release alone", () => {
    expect(shortPostgresVersion("17.2")).toBe("17.2")
  })
})

describe("splitPath", () => {
  it("splits a path into the file name and its folder", () => {
    expect(splitPath("/app/data/geoip/GeoLite2-City.mmdb")).toEqual({
      fileName: "GeoLite2-City.mmdb",
      folder: "/app/data/geoip",
    })
  })

  it("has no folder for a bare file name", () => {
    expect(splitPath("GeoLite2-City.mmdb")).toEqual({ fileName: "GeoLite2-City.mmdb", folder: null })
  })

  it("keeps the root folder", () => {
    expect(splitPath("/GeoLite2-City.mmdb")).toEqual({ fileName: "GeoLite2-City.mmdb", folder: "/" })
  })

  it("splits Windows paths", () => {
    expect(splitPath("C:\\geoip\\GeoLite2-City.mmdb")).toEqual({ fileName: "GeoLite2-City.mmdb", folder: "C:\\geoip" })
  })
})

describe("runtimeLabel", () => {
  const app = makeAbout().app

  it("says container when the image tag matches the version or is missing", () => {
    expect(runtimeLabel(app, "v0.22.0")).toBe("container")
    expect(runtimeLabel({ ...app, imageTag: "v0.22.0" }, "v0.22.0")).toBe("container")
  })

  it("names a hand-picked image tag", () => {
    expect(runtimeLabel({ ...app, imageTag: "latest" }, "v0.22.0")).toBe("container: latest")
  })

  it("says host outside a container", () => {
    expect(runtimeLabel({ ...app, container: false }, "v0.22.0")).toBe("host")
  })
})

describe("migrationStatus", () => {
  it("is at head when the revision matches the build's", () => {
    expect(migrationStatus(database)).toBe("at-head")
  })

  it("is behind when the revisions differ", () => {
    expect(migrationStatus({ ...database, migrationRevision: "9f1c2ab4d7e0" })).toBe("behind")
  })

  it("is unavailable without a revision", () => {
    expect(migrationStatus({ ...database, migrationRevision: null })).toBe("unavailable")
  })
})

describe("section summaries", () => {
  it("summarizes the runtime without a light", () => {
    expect(runtimeSummary(makeAbout().runtime)).toEqual({ tone: null, text: "Python 3.13.16, Litestar 2.25.0" })
    expect(runtimeSummary({ pythonVersion: "3.13.16", litestarVersion: null, apschedulerVersion: null })).toEqual({
      tone: null,
      text: "Python 3.13.16",
    })
  })

  it("reports a connected database at head in green", () => {
    expect(databaseSummary(database)).toEqual({ tone: "emerald", text: "Connected, migration at head" })
  })

  it("reports a migration behind in amber", () => {
    expect(databaseSummary({ ...database, migrationRevision: "9f1c2ab4d7e0" })).toEqual({
      tone: "amber",
      text: "Connected, migration behind",
    })
  })

  it("reports an unreachable database in red", () => {
    expect(databaseSummary({ ...database, postgresVersion: null })).toEqual({ tone: "red", text: "Unreachable" })
  })

  it("gives both GeoIP ages", () => {
    expect(geoipSummary(makeAbout())).toEqual({ tone: "emerald", text: "City 7 days old, ASN 6 days old" })
  })

  it("takes the worse light of City and ASN", () => {
    const about = makeAbout()
    expect(geoipSummary({ ...about, geoip: { ...about.geoip, ageDays: 41 } }).tone).toBe("red")
    expect(geoipSummary({ ...about, geoipAsn: { ...about.geoipAsn!, ageDays: 20 } }).tone).toBe("amber")
  })

  it("says when ASN is off or City is missing", () => {
    const about = makeAbout({ geoipAsnEnabled: false, geoipAsn: null })
    expect(geoipSummary({ ...about, geoip: { ...about.geoip, available: false } })).toEqual({
      tone: "red",
      text: "City not available, ASN disabled",
    })
  })

  it("uses the singular for one day", () => {
    const about = makeAbout()
    expect(geoipSummary({ ...about, geoip: { ...about.geoip, ageDays: 1 } }).text).toBe("City 1 day old, ASN 6 days old")
  })

  it("opens rows with a red or amber light", () => {
    expect(startsOpen({ tone: "red", text: "" })).toBe(true)
    expect(startsOpen({ tone: "amber", text: "" })).toBe(true)
    expect(startsOpen({ tone: "emerald", text: "" })).toBe(false)
    expect(startsOpen({ tone: null, text: "" })).toBe(false)
  })
})

describe("aboutDetailsText", () => {
  it("puts the versions on six lines", () => {
    expect(aboutDetailsText(makeAbout())).toBe(
      [
        "GeoMetrikks v0.22.0 (commit 391c3265e1f0a7d2b9c4e5f6a7b8c9d0e1f2a3b4), container",
        "Python 3.13.16, Litestar 2.25.0, APScheduler 3.11.3",
        "PostgreSQL 18.6 (Ubuntu 18.6-1.pgdg22.04+2)",
        "TimescaleDB 2.30.2, PostGIS 3.6.4",
        "Migration a41d7e6c2b95 (at head)",
        "GeoLite2 City 2026-10-23, ASN 2026-10-24",
      ].join("\n"),
    )
  })

  it("keeps the local version suffix the card hides", () => {
    const about = makeAbout()
    const text = aboutDetailsText({
      ...about,
      app: { ...about.app, version: "0.23.0.dev5+g05b43030f", container: false, commit: null },
    })
    expect(text.split("\n")[0]).toBe("GeoMetrikks v0.23.0-dev.5+g05b43030f, host")
  })

  it("covers an unreachable database, a missing City file and ASN turned off", () => {
    const about = makeAbout({ geoipAsnEnabled: false, geoipAsn: null })
    const lines = aboutDetailsText({
      ...about,
      database: {
        postgresVersion: null,
        timescaledbVersion: null,
        postgisVersion: null,
        migrationRevision: null,
        migrationName: null,
        migrationHead: "a41d7e6c2b95",
      },
      geoip: { ...about.geoip, available: false, buildDate: null },
    }).split("\n")
    expect(lines.slice(2)).toEqual([
      "PostgreSQL unreachable",
      "TimescaleDB unavailable, PostGIS unavailable",
      "Migration unavailable",
      "GeoLite2 City missing, ASN disabled",
    ])
  })

  it("names the build's revision when the migration is behind", () => {
    const about = makeAbout()
    const text = aboutDetailsText({ ...about, database: { ...about.database, migrationRevision: "9f1c2ab4d7e0" } })
    expect(text.split("\n")[4]).toBe("Migration 9f1c2ab4d7e0 (behind, build ships a41d7e6c2b95)")
  })
})
