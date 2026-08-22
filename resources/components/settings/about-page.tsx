import type { ReactNode } from "react"
import { Bug, Cpu, Database, ExternalLink, Globe2 } from "lucide-react"
import { useAbout } from "@/lib/queries"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { MonoChip, StatusLed, type LedTone } from "@/components/settings/status-led"
import { AsnListDialog } from "@/components/settings/asn-list-dialog"

function formatUptime(startedAt: string | null | undefined): string {
  if (!startedAt) return "unknown"
  let seconds = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000))
  const days = Math.floor(seconds / 86_400)
  seconds %= 86_400
  const hours = Math.floor(seconds / 3_600)
  seconds %= 3_600
  const minutes = Math.floor(seconds / 60)
  if (days > 0) return `${days}d ${hours}h ${minutes}m`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

/** GeoLite2 EULA expects refresh within 30 days; warn as that approaches. */
function geoipFreshness(available: boolean, ageDays: number | null | undefined): {
  tone: LedTone
  label: string
} {
  if (!available) return { tone: "red", label: "not available" }
  if (ageDays === null || ageDays === undefined) return { tone: "emerald", label: "available" }
  if (ageDays > 30) return { tone: "red", label: `stale (${ageDays} days old)` }
  if (ageDays > 14) return { tone: "amber", label: `aging (${ageDays} days old)` }
  return { tone: "emerald", label: `fresh (${ageDays} days old)` }
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/40 py-1.5 last:border-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="break-all text-right text-sm">{value ?? "unknown"}</span>
    </div>
  )
}

function SectionIcon({ icon: Icon }: { icon: React.ComponentType<{ className?: string }> }) {
  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-geo-cyan/10">
      <Icon className="h-4 w-4 text-geo-cyan" />
    </div>
  )
}

/** The sidebar's brand mark, reused at masthead size. */
function BrandMark() {
  return (
    <div className="relative shrink-0">
      <div className="absolute inset-0 rounded-xl bg-geo-cyan/20 blur-md" />
      <div className="relative flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-geo-cyan to-geo-cyan-dim shadow-lg shadow-geo-glow">
        <svg
          viewBox="0 0 24 24"
          className="h-6 w-6 text-primary-foreground"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 2L2 7l10 5 10-5-10-5z" />
          <path d="M2 17l10 5 10-5" />
          <path d="M2 12l10 5 10-5" />
        </svg>
      </div>
    </div>
  )
}

export function AboutPage() {
  const { data, isLoading } = useAbout()

  if (isLoading || !data) {
    return (
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-24 w-full md:col-span-2" />
        <Skeleton className="h-56 w-full" />
        <Skeleton className="h-56 w-full" />
      </div>
    )
  }

  const geoip = geoipFreshness(data.geoip.available, data.geoip.ageDays)
  const asn =
    data.geoipAsnEnabled && data.geoipAsn
      ? geoipFreshness(data.geoipAsn.available, data.geoipAsn.ageDays)
      : null
  const dbReachable = data.database.postgresVersion !== null

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card className="md:col-span-2">
        <CardContent className="flex flex-wrap items-center justify-between gap-4 py-5">
          <div className="flex items-center gap-4">
            <BrandMark />
            <div>
              <div className="flex items-center gap-2.5">
                <span className="text-lg font-semibold tracking-tight">
                  Geo<span className="text-geo-cyan">Metrikks</span>
                </span>
                <MonoChip>v{data.app.version}</MonoChip>
              </div>
              <div className="mt-1 flex items-center gap-1.5">
                <Badge variant="outline" className="text-muted-foreground">
                  {data.app.environment}
                </Badge>
                {data.app.container ? (
                  <Badge variant="secondary">
                    container{data.app.imageTag ? `: ${data.app.imageTag}` : ""}
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-muted-foreground">
                    host
                  </Badge>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <StatusLed tone="emerald" pulse />
            <span className="text-muted-foreground">up</span>
            <span className="font-medium">{formatUptime(data.app.startedAt)}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <SectionIcon icon={Cpu} />
            <CardTitle className="text-base">Runtime</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <Row label="Python" value={<MonoChip>{data.runtime.pythonVersion}</MonoChip>} />
          <Row
            label="Litestar"
            value={
              data.runtime.litestarVersion ? (
                <MonoChip>{data.runtime.litestarVersion}</MonoChip>
              ) : (
                "unknown"
              )
            }
          />
          <Row
            label="APScheduler"
            value={
              data.runtime.apschedulerVersion ? (
                <MonoChip>{data.runtime.apschedulerVersion}</MonoChip>
              ) : (
                "unknown"
              )
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <SectionIcon icon={Database} />
              <CardTitle className="text-base">Database</CardTitle>
            </div>
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <StatusLed tone={dbReachable ? "emerald" : "red"} />
              {dbReachable ? "connected" : "unreachable"}
            </span>
          </div>
        </CardHeader>
        <CardContent>
          <Row
            label="PostgreSQL"
            value={
              data.database.postgresVersion ? (
                <MonoChip>{data.database.postgresVersion}</MonoChip>
              ) : (
                <span className="text-muted-foreground">unavailable</span>
              )
            }
          />
          <Row
            label="TimescaleDB"
            value={
              data.database.timescaledbVersion ? (
                <MonoChip>{data.database.timescaledbVersion}</MonoChip>
              ) : (
                <span className="text-muted-foreground">unavailable</span>
              )
            }
          />
          <Row
            label="PostGIS"
            value={
              data.database.postgisVersion ? (
                <MonoChip>{data.database.postgisVersion}</MonoChip>
              ) : (
                <span className="text-muted-foreground">unavailable</span>
              )
            }
          />
        </CardContent>
      </Card>

      <Card className="md:col-span-2">
        <CardHeader>
          <div className="flex items-center gap-3">
            <SectionIcon icon={Globe2} />
            <CardTitle className="text-base">GeoIP databases</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-x-8 gap-y-4 md:grid-cols-2">
            <div>
              <div className="flex items-center justify-between gap-3 border-b border-border/40 pb-1.5">
                <span className="text-sm font-medium">City</span>
                <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <StatusLed tone={geoip.tone} />
                  {geoip.label}
                </span>
              </div>
              <Row
                label="Build date"
                value={
                  data.geoip.buildDate
                    ? new Date(data.geoip.buildDate).toLocaleDateString()
                    : "unknown"
                }
              />
              <Row
                label="Age"
                value={
                  data.geoip.ageDays !== null && data.geoip.ageDays !== undefined
                    ? `${data.geoip.ageDays} days`
                    : "unknown"
                }
              />
              <Row label="Path" value={<MonoChip>{data.geoip.dbPath}</MonoChip>} />
            </div>
            <div>
              <div className="flex items-center justify-between gap-3 border-b border-border/40 pb-1.5">
                <span className="text-sm font-medium">ASN</span>
                <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  {asn ? (
                    <>
                      <StatusLed tone={asn.tone} />
                      {asn.label}
                    </>
                  ) : (
                    "disabled"
                  )}
                </span>
              </div>
              {asn && data.geoipAsn ? (
                <>
                  <Row
                    label="Build date"
                    value={
                      data.geoipAsn.buildDate
                        ? new Date(data.geoipAsn.buildDate).toLocaleDateString()
                        : "unknown"
                    }
                  />
                  <Row
                    label="Age"
                    value={
                      data.geoipAsn.ageDays !== null && data.geoipAsn.ageDays !== undefined
                        ? `${data.geoipAsn.ageDays} days`
                        : "unknown"
                    }
                  />
                  <Row label="Path" value={<MonoChip>{data.geoipAsn.dbPath}</MonoChip>} />
                  {data.asnClassification && (
                    <>
                      <Row
                        label="Classification list"
                        value={
                          <a
                            href={data.asnClassification.sourceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 hover:underline underline-offset-2"
                          >
                            <MonoChip>
                              {data.asnClassification.dataset} · {data.asnClassification.entries} ASNs · {data.asnClassification.license}
                            </MonoChip>
                            <ExternalLink className="h-3 w-3 text-muted-foreground" />
                          </a>
                        }
                      />
                      <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
                        <p className="max-w-[32ch] text-xs text-muted-foreground">
                          Community list of hosting, VPN, and datacenter
                          operators; matching networks are badged Hosting,
                          the rest show as Other.
                        </p>
                        <AsnListDialog />
                      </div>
                    </>
                  )}
                </>
              ) : (
                <p className="pt-1.5 text-sm text-muted-foreground">
                  ASN enrichment is turned off (GEOIP_ASN_ENABLED=false).
                </p>
              )}
            </div>
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            This product includes GeoLite2 data created by MaxMind, available
            from{" "}
            <a
              href="https://www.maxmind.com"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2"
            >
              maxmind.com
            </a>
            .
          </p>
        </CardContent>
      </Card>

      <Card className="md:col-span-2">
        <CardContent className="flex flex-wrap gap-2 py-4">
          <Button variant="outline" size="sm" className="pointer-coarse:h-10" asChild>
            <a href={data.links.repository} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
              GitHub repository
            </a>
          </Button>
          <Button variant="outline" size="sm" className="pointer-coarse:h-10" asChild>
            <a href={data.links.issues} target="_blank" rel="noopener noreferrer">
              <Bug className="mr-1.5 h-3.5 w-3.5" />
              Issue tracker
            </a>
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
