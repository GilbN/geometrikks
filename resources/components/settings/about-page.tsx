import type { ReactNode } from "react"
import { useAbout } from "@/lib/queries"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

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

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 border-b border-border/40 last:border-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm text-right break-all">{value ?? "unknown"}</span>
    </div>
  )
}

export function AboutPage() {
  const { data, isLoading } = useAbout()

  if (isLoading || !data) {
    return (
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-56 w-full" />
        <Skeleton className="h-56 w-full" />
      </div>
    )
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Application</CardTitle>
        </CardHeader>
        <CardContent>
          <Row label="Name" value={data.app.name} />
          <Row label="Version" value={<code className="text-xs">v{data.app.version}</code>} />
          <Row label="Environment" value={data.app.environment} />
          <Row
            label="Runtime"
            value={
              data.app.container ? (
                <Badge variant="secondary">
                  container{data.app.image_tag ? `: ${data.app.image_tag}` : ""}
                </Badge>
              ) : (
                <Badge variant="outline">host</Badge>
              )
            }
          />
          <Row label="Uptime" value={formatUptime(data.app.started_at)} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Runtime versions</CardTitle>
        </CardHeader>
        <CardContent>
          <Row label="Python" value={data.runtime.python_version} />
          <Row label="Litestar" value={data.runtime.litestar_version} />
          <Row label="APScheduler" value={data.runtime.apscheduler_version} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Database</CardTitle>
        </CardHeader>
        <CardContent>
          <Row label="PostgreSQL" value={data.database.postgres_version ?? "unavailable"} />
          <Row label="TimescaleDB" value={data.database.timescaledb_version ?? "unavailable"} />
          <Row label="PostGIS" value={data.database.postgis_version ?? "unavailable"} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">GeoIP database</CardTitle>
        </CardHeader>
        <CardContent>
          <Row
            label="Status"
            value={
              data.geoip.available ? (
                <Badge variant="secondary">available</Badge>
              ) : (
                <Badge variant="destructive">not available</Badge>
              )
            }
          />
          <Row label="Path" value={<code className="text-xs">{data.geoip.db_path}</code>} />
          <Row
            label="Build date"
            value={
              data.geoip.build_date
                ? new Date(data.geoip.build_date).toLocaleDateString()
                : "unknown"
            }
          />
          <Row
            label="Age"
            value={data.geoip.age_days !== null ? `${data.geoip.age_days} days` : "unknown"}
          />
        </CardContent>
      </Card>

      <Card className="md:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">Links</CardTitle>
        </CardHeader>
        <CardContent className="flex gap-4">
          <a
            className="text-sm underline underline-offset-4 hover:text-foreground text-muted-foreground"
            href={data.links.repository}
            target="_blank"
            rel="noreferrer"
          >
            GitHub repository
          </a>
          <a
            className="text-sm underline underline-offset-4 hover:text-foreground text-muted-foreground"
            href={data.links.issues}
            target="_blank"
            rel="noreferrer"
          >
            Issue tracker
          </a>
        </CardContent>
      </Card>
    </div>
  )
}
