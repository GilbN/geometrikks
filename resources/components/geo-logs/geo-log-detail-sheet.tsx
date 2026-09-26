/**
 * Complete record for one grouped geo-events row (a location plus an IP),
 * opened by selecting the row.
 */
import { CountryLabel } from "@/components/country-flag"
import { DetailField, DetailSheet } from "@/components/data/detail-sheet"
import { IpBanControls } from "@/components/crowdsec/ip-ban-controls"
import { InspectIpButton } from "@/components/ip-inspector/inspect-ip-button"
import { FlyToIpButton } from "@/components/map/FlyToIpButton"
import type { GeoLogEntry } from "@/generated/api/types.gen"
import { formatNumber } from "@/lib/api"

export function GeoLogDetailSheet({
  entry,
  onOpenChange,
}: {
  entry: GeoLogEntry | null
  onOpenChange: (open: boolean) => void
}) {
  return (
    <DetailSheet
      open={entry !== null}
      onOpenChange={onOpenChange}
      title={entry ? entry.city || entry.countryName || "Location details" : "Location details"}
      description={entry ? `${formatNumber(entry.eventCount)} events · ${entry.ipAddress}` : undefined}
    >
      {entry && (
        <dl>
          <DetailField label="City" value={entry.city} />
          <DetailField label="Postal code" value={entry.postalCode} mono />
          <DetailField label="State" value={entry.state} />
          <DetailField label="State code" value={entry.stateCode} mono />
          <DetailField
            label="Country"
            value={
              <CountryLabel code={entry.countryCode} name={entry.countryName}>
                {`${entry.countryName} (${entry.countryCode})`}
              </CountryLabel>
            }
          />
          <DetailField
            label="IP address"
            value={
              <span className="inline-flex flex-wrap items-center gap-2 font-mono text-xs">
                {entry.ipAddress}
                <IpBanControls ip={entry.ipAddress}>
                  <InspectIpButton ip={entry.ipAddress} fromLocationId={entry.locationId} onOpen={() => onOpenChange(false)} />
                  <FlyToIpButton ip={entry.ipAddress} locationId={entry.locationId} onOpen={() => onOpenChange(false)} />
                </IpBanControls>
              </span>
            }
          />
          <DetailField
            label="ASN"
            value={entry.asn != null ? `AS${entry.asn}${entry.asOrganization ? ` ${entry.asOrganization}` : ""}` : null}
            mono
          />
          <DetailField label="Request count" value={formatNumber(entry.eventCount)} />
          <DetailField label="Last seen" value={entry.lastSeen ? new Date(entry.lastSeen).toLocaleString() : null} />
          <DetailField label="Latitude" value={entry.latitude.toFixed(4)} mono />
          <DetailField label="Longitude" value={entry.longitude.toFixed(4)} mono />
          <DetailField label="Hostnames" value={entry.hostnames.length ? entry.hostnames.join(", ") : null} mono />
        </dl>
      )}
    </DetailSheet>
  )
}
