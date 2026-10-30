import type { AboutResponse, GeoIpInfoView } from "@/generated/api/types.gen"
import type { LedTone } from "@/components/settings/status-led"
import { displayVersion, publicVersion } from "@/lib/version"

export interface SectionSummary {
  tone: LedTone | null
  text: string
}

/** GeoLite2 EULA expects refresh within 30 days; warn as that approaches. */
export function geoipFreshness(available: boolean, ageDays: number | null | undefined): {
  tone: LedTone
  label: string
} {
  if (!available) return { tone: "red", label: "not available" }
  if (ageDays === null || ageDays === undefined) return { tone: "emerald", label: "available" }
  if (ageDays > 30) return { tone: "red", label: `stale (${ageDays} days old)` }
  if (ageDays > 14) return { tone: "amber", label: `aging (${ageDays} days old)` }
  return { tone: "emerald", label: `fresh (${ageDays} days old)` }
}

/** "container", "container: latest" or "host", as the version card's badge reads. */
export function runtimeLabel(app: AboutResponse["app"], version: string): string {
  // The release workflow tags images with the version, so a tag that matches
  // it says nothing new; a hand-built image tagged "latest" or "local" does.
  if (!app.container) return "host"
  return app.imageTag && app.imageTag !== version ? `container: ${app.imageTag}` : "container"
}

/** "18.6 (Ubuntu 18.6-1.pgdg22.04+2)" becomes "18.6". */
export function shortPostgresVersion(postgresVersion: string): string {
  return postgresVersion.split(" ")[0]
}

/** A path as its file name and the folder it sits in; folder is null for a bare name. */
export function splitPath(path: string): { fileName: string; folder: string | null } {
  const lastSlash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
  if (lastSlash === -1) return { fileName: path, folder: null }
  return { fileName: path.slice(lastSlash + 1), folder: path.slice(0, lastSlash) || path.slice(0, 1) }
}

export type MigrationStatus = "at-head" | "behind" | "unavailable"

export function migrationStatus(database: AboutResponse["database"]): MigrationStatus {
  if (!database.migrationRevision) return "unavailable"
  return database.migrationRevision === database.migrationHead ? "at-head" : "behind"
}

const TONE_RANK: Record<LedTone, number> = { red: 3, amber: 2, accent: 1, emerald: 1, muted: 0 }

function worstTone(tones: LedTone[]): LedTone | null {
  return tones.reduce<LedTone | null>(
    (worst, tone) => (worst === null || TONE_RANK[tone] > TONE_RANK[worst] ? tone : worst),
    null,
  )
}

export function runtimeSummary(runtime: AboutResponse["runtime"]): SectionSummary {
  const parts = [`Python ${runtime.pythonVersion}`]
  if (runtime.litestarVersion) parts.push(`Litestar ${runtime.litestarVersion}`)
  return { tone: null, text: parts.join(", ") }
}

export function databaseSummary(database: AboutResponse["database"]): SectionSummary {
  if (database.postgresVersion === null) return { tone: "red", text: "Unreachable" }
  const status = migrationStatus(database)
  if (status === "behind") return { tone: "amber", text: "Connected, migration behind" }
  return { tone: "emerald", text: status === "at-head" ? "Connected, migration at head" : "Connected, migration unavailable" }
}

function geoipPart(name: string, info: GeoIpInfoView): string {
  if (!info.available) return `${name} not available`
  if (info.ageDays === null || info.ageDays === undefined) return `${name} available`
  return `${name} ${info.ageDays} ${info.ageDays === 1 ? "day" : "days"} old`
}

export function geoipSummary(about: Pick<AboutResponse, "geoip" | "geoipAsn" | "geoipAsnEnabled">): SectionSummary {
  const asn = about.geoipAsnEnabled && about.geoipAsn ? about.geoipAsn : null
  const tones = [geoipFreshness(about.geoip.available, about.geoip.ageDays).tone]
  if (asn) tones.push(geoipFreshness(asn.available, asn.ageDays).tone)
  const asnPart = asn ? geoipPart("ASN", asn) : "ASN disabled"
  return { tone: worstTone(tones), text: `${geoipPart("City", about.geoip)}, ${asnPart}` }
}

/** A row with a red or amber light starts open, so the problem shows without a tap. */
export function startsOpen(summary: SectionSummary): boolean {
  return summary.tone === "red" || summary.tone === "amber"
}

function buildDay(info: GeoIpInfoView): string {
  if (!info.available) return "missing"
  if (!info.buildDate) return "unknown"
  const date = new Date(info.buildDate)
  return Number.isNaN(date.getTime()) ? info.buildDate : date.toISOString().slice(0, 10)
}

/** The plain-text block Copy details puts on the clipboard, one fact group per line. */
export function aboutDetailsText(about: AboutResponse): string {
  const { app, runtime, database } = about
  const commit = app.commit ? ` (commit ${app.commit})` : ""
  const status = migrationStatus(database)
  const migration =
    status === "unavailable"
      ? "Migration unavailable"
      : status === "at-head"
        ? `Migration ${database.migrationRevision} (at head)`
        : `Migration ${database.migrationRevision} (behind, build ships ${database.migrationHead})`
  const asn = about.geoipAsnEnabled && about.geoipAsn ? `ASN ${buildDay(about.geoipAsn)}` : "ASN disabled"
  return [
    `GeoMetrikks ${displayVersion(app.version)}${commit}, ${runtimeLabel(app, displayVersion(publicVersion(app.version)))}`,
    `Python ${runtime.pythonVersion}, Litestar ${runtime.litestarVersion ?? "unknown"}, APScheduler ${runtime.apschedulerVersion ?? "unknown"}`,
    `PostgreSQL ${database.postgresVersion ?? "unreachable"}`,
    `TimescaleDB ${database.timescaledbVersion ?? "unavailable"}, PostGIS ${database.postgisVersion ?? "unavailable"}`,
    migration,
    `GeoLite2 City ${buildDay(about.geoip)}, ${asn}`,
  ].join("\n")
}
