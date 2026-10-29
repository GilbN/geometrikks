/**
 * Complete record for one access-log row, opened by selecting the row.
 * Every field on the DTO is listed; missing values read "Not recorded" so
 * the list is the same shape for every request.
 */
import { CountryLabel } from "@/components/country-flag"
import { DetailIpActions, DetailIpBlock } from "@/components/ip-actions/detail-ip"
import { DetailField, DetailSheet } from "@/components/data/detail-sheet"
import { Badge } from "@/components/ui/badge"
import { formatBytes, formatDuration, type AccessLog } from "@/lib/api"
import type { IpRowValues } from "@/lib/ip-filter-targets"
import { statusBadgeClass } from "@/lib/status-badge"
import { formatDurationOrNa } from "@/lib/timing"
import { cn } from "@/lib/utils"

function ipValues(entry: AccessLog): IpRowValues {
  return {
    ip: entry.ipAddress,
    host: entry.host,
    server: entry.server,
    countryCode: entry.countryCode,
    countryName: entry.countryName,
    city: entry.city,
    asn: entry.autonomousSystemNumber,
    asOrganization: entry.autonomousSystemOrganization,
  }
}

export function AccessLogDetailSheet({
  entry,
  onOpenChange,
}: {
  entry: AccessLog | null
  onOpenChange: (open: boolean) => void
}) {
  return (
    <DetailSheet
      open={entry !== null}
      onOpenChange={onOpenChange}
      title={entry ? `Request #${entry.id}` : "Request details"}
      description={
        entry ? `${new Date(entry.timestamp).toLocaleString()} · ${entry.method ?? "Unknown method"}` : undefined
      }
      footer={entry && <DetailIpActions values={ipValues(entry)} onNavigate={() => onOpenChange(false)} />}
    >
      {entry && <DetailIpBlock values={ipValues(entry)} />}
      {entry && (
        <dl>
          <DetailField
            label="Status"
            value={
              <Badge className={cn("tabular-nums border-transparent", statusBadgeClass(entry.statusCode))}>
                HTTP {entry.statusCode}
              </Badge>
            }
          />
          <DetailField label="Time" value={new Date(entry.timestamp).toLocaleString()} />
          <DetailField label="Method" value={entry.method} mono />
          <DetailField label="URL" value={entry.url} mono />
          <DetailField label="Host" value={entry.host} mono />
          <DetailField label="Remote user" value={entry.remoteUser} mono />
          <DetailField label="HTTP version" value={entry.httpVersion} mono />
          <DetailField label="Bytes sent" value={formatBytes(entry.bytesSent)} />
          <DetailField label="Request time" value={formatDurationOrNa(entry.requestTime)} />
          <DetailField
            label="Upstream response"
            value={entry.upstreamResponseTime != null ? formatDuration(entry.upstreamResponseTime * 1000) : null}
          />
          <DetailField label="Referrer" value={entry.referrer} mono />
          <DetailField label="User agent" value={entry.userAgent} mono />
          <DetailField
            label="Country"
            value={
              entry.countryCode && (
                <CountryLabel code={entry.countryCode} name={entry.countryName}>
                  {`${entry.countryName ?? entry.countryCode} (${entry.countryCode})`}
                </CountryLabel>
              )
            }
          />
          <DetailField label="City" value={entry.city} />
          <DetailField
            label="ASN"
            value={entry.autonomousSystemNumber != null ? `AS${entry.autonomousSystemNumber}` : null}
            mono
          />
          <DetailField label="AS organization" value={entry.autonomousSystemOrganization} />
          <DetailField label="Server" value={entry.server} mono />
          <DetailField label="Source format" value={entry.logFormat} mono />
        </dl>
      )}
    </DetailSheet>
  )
}
