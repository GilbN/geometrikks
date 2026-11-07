/**
 * A traffic location's details: MapPopup anchors them to the point on
 * desktop, and LocationPanel shows them in a MapDetailPanel on a phone.
 */

import { useRef, type ReactElement } from "react"
import type { Popup as MapLibrePopup } from "maplibre-gl"
import { Popup } from "react-map-gl/maplibre"
import { Activity, Clock, ExternalLink, Loader2, MapPin, Percent, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import { formatNumber } from "@/lib/api"
import type { GeoJSONFeatureProperties, TopIPDTO } from "@/lib/api"
import { useLocationTopIPs } from "@/lib/queries"
import { IpBanControls } from "./IpBanControls"
import { CountryLabel } from "@/components/country-flag"
import { InspectIpButton } from "@/components/ip-inspector/inspect-ip-button"
import { POPUP_OFFSET, POPUP_ROW_ICON_STYLE, PopupBadge, PopupCard, PopupRow } from "./PopupCard"
import { MapDetailPanel, PanelSection, PanelStats } from "./MapDetailPanel"
import { IpLabel } from "@/components/ip-actions/ip-label"
import { CopyIpButton } from "@/components/ip-actions/ip-actions-menu"
import { PanelBanButton } from "./PanelBanButton"
import { IpStatusDetails, IpStatusWords } from "./IpStatusDetails"
import type { DecisionRef } from "@/components/security/alert-detail-sheet"
import { countryLabel } from "@/lib/ip-filter-targets"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

function LastHitToolTip({ lastHit }: { lastHit: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span style={{ fontWeight: 500, fontSize: "11px" }}>{lastHit}</span>
      </TooltipTrigger>
      <TooltipContent>
        <p>Updated every 5 minutes</p>
      </TooltipContent>
    </Tooltip>
  )
}

export interface PopupInfo {
  longitude: number
  latitude: number
  properties: GeoJSONFeatureProperties
}

interface MapPopupProps extends PopupInfo {
  onClose: () => void
  /** Every event on the map in the range and filters, for this location's share. */
  totalEvents?: number
  /** Opens the alert behind a decision. Without it the scenario is plain text. */
  onOpenAlert?: (decision: DecisionRef) => void
}

/** The title and the line under it, and the place an IP's details name. */
function locationHeading({ city, state, countryName, countryCode }: GeoJSONFeatureProperties) {
  const country = countryCode ? countryLabel(countryCode, countryName) : null
  // GeoIP often names the region after its city, as in "Milton Keynes, Milton Keynes".
  const region = state && state !== city ? state : null
  const title = city ?? region ?? country ?? "Unknown Location"
  return {
    title,
    titleIsCountry: title === country,
    where: [city ? region : null, title === country ? null : country].filter(Boolean).join(", "),
    place: [city ?? region, country].filter(Boolean).join(", "),
  }
}

/** "AS64500 Example Net", or null when GeoIP had no ASN for the IP. */
function networkName(ip: TopIPDTO): string | null {
  return ip.asn == null ? null : [`AS${ip.asn}`, ip.asOrganization].filter(Boolean).join(" ")
}

/** The point on openstreetmap.org, at a city-wide zoom to match GeoIP's precision. */
function openStreetMapUrl(latitude: number, longitude: number): string {
  const lat = latitude.toFixed(4)
  const lon = longitude.toFixed(4)
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=12/${lat}/${lon}`
}

/** "4.2%", or "<0.1%" for a sliver that would round to zero. */
function formatShare(part: number, total: number): string {
  const percent = (part / total) * 100
  return percent > 0 && percent < 0.1 ? "<0.1%" : `${percent.toFixed(1)}%`
}

/** The full network name on hover, for a line too narrow to show it. */
function NetworkTooltip({ network, children }: { network: string | null; children: ReactElement }) {
  if (!network) return children
  return (
    // Below and gone once the pointer leaves, so it never sits over the IP above.
    <Tooltip disableHoverableContent>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom">{network}</TooltipContent>
    </Tooltip>
  )
}

/** "Banned · 355 events · AS13335 Cloudflare, Inc." under a top IP. */
function TopIpMeta({ ip, eventCount, network }: { ip: string; eventCount: number; network: string | null }) {
  return (
    <>
      <IpStatusWords ip={ip} />
      <span className="tabular-nums">{formatNumber(eventCount)}</span> {eventCount === 1 ? "event" : "events"}
      {network && ` · ${network}`}
    </>
  )
}

export function MapPopup({
  longitude,
  latitude,
  properties,
  totalEvents,
  onClose,
  onOpenAlert,
}: MapPopupProps) {
  const { id: locationId, countryName, countryCode, eventCount, lastHit } = properties
  const { data: topIPsData, isLoading: isLoadingTopIPs } = useLocationTopIPs(locationId)
  const topIps = topIPsData?.topIps ?? []
  const hasIpv6 = topIps.some((ip) => ip.ipAddress.includes(":"))
  const { title, where, place, titleIsCountry } = locationHeading(properties)
  const divider = "1px solid var(--popup-border)"

  const popupRef = useRef<MapLibrePopup>(null)
  return (
    <Popup
      ref={popupRef}
      longitude={longitude}
      latitude={latitude}
      offset={POPUP_OFFSET}
      onClose={onClose}
      closeButton={false}
      closeOnClick={false}
      className="geo-popup"
      maxWidth={hasIpv6 ? "380px" : "300px"}
      style={{ background: "transparent" }}
    >
      <PopupCard
        onClose={onClose}
        point={[longitude, latitude]}
        popupRef={popupRef}
        minWidth="240px"
        header={
          <>
            <MapPin style={{ width: 16, height: 16, color: "var(--primary)", flexShrink: 0, alignSelf: "flex-start", marginTop: "2px" }} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: "14px", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {titleIsCountry ? <CountryLabel code={countryCode} name={countryName}>{title}</CountryLabel> : title}
              </div>
              {where && (
                <div style={{ fontSize: "11px", color: "var(--popup-muted)", marginTop: "1px" }}>
                  <CountryLabel code={countryCode} name={countryName}>{where}</CountryLabel>
                </div>
              )}
            </div>
          </>
        }
      >
        <PopupRow label="Events" icon={<Activity style={POPUP_ROW_ICON_STYLE} />} value={<PopupBadge>{formatNumber(eventCount)}</PopupBadge>} />
        <PopupRow label="Unique IPs" icon={<Users style={POPUP_ROW_ICON_STYLE} />} value={topIPsData ? formatNumber(topIPsData.uniqueIps) : "–"} />
        <PopupRow label="Of all events" icon={<Percent style={POPUP_ROW_ICON_STYLE} />} value={totalEvents ? formatShare(eventCount, totalEvents) : "–"} />
        <PopupRow label="Last hit" icon={<Clock style={POPUP_ROW_ICON_STYLE} />} value={lastHit ? <LastHitToolTip lastHit={new Date(lastHit).toLocaleString()} /> : "Unknown"} />

        {(isLoadingTopIPs || topIps.length > 0) && (
          <div style={{ paddingTop: "8px", marginTop: "8px", borderTop: divider }}>
            <div style={{ display: "flex", alignItems: "center", gap: "4px", marginBottom: "2px", fontSize: "12px", color: "var(--popup-muted)" }}>
              {isLoadingTopIPs ? <Loader2 className="size-3 animate-spin" /> : <Users style={{ width: 12, height: 12 }} />}
              {isLoadingTopIPs ? "Loading top IPs..." : topIps.length === 1 ? "Top IP" : `Top ${topIps.length} IPs`}
            </div>
            {topIps.map((ip, index) => (
              <div
                key={ip.ipAddress}
                style={{ display: "flex", alignItems: "center", gap: "6px", padding: "4px 0", borderTop: index ? divider : undefined }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <IpStatusDetails
                    ip={ip.ipAddress}
                    context={[place, networkName(ip)].filter(Boolean).join(" · ")}
                    fromLocationId={locationId}
                    onOpenAlert={onOpenAlert}
                  >
                    <IpLabel ip={ip.ipAddress} prefix={`${index + 1}.\u00a0`} className="text-[11px] break-all" />
                  </IpStatusDetails>
                  <NetworkTooltip network={networkName(ip)}>
                    <div style={{ fontSize: "10px", color: "var(--popup-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      <TopIpMeta ip={ip.ipAddress} eventCount={ip.eventCount} network={networkName(ip)} />
                    </div>
                  </NetworkTooltip>
                </div>
                <span style={{ display: "inline-flex", alignItems: "center", flexShrink: 0 }}>
                  <IpBanControls ip={ip.ipAddress} showBadge={false}>
                    <InspectIpButton ip={ip.ipAddress} fromLocationId={locationId} />
                  </IpBanControls>
                </span>
              </div>
            ))}
          </div>
        )}

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "12px",
            paddingTop: "6px",
            marginTop: "6px",
            borderTop: divider,
            fontSize: "10px",
            color: "var(--popup-muted)",
          }}
        >
          <span className="tabular-nums">{latitude.toFixed(4)}, {longitude.toFixed(4)}</span>
          <a
            href={openStreetMapUrl(latitude, longitude)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
          >
            Open in OpenStreetMap
            <ExternalLink className="size-3" />
          </a>
        </div>
      </PopupCard>
    </Popup>
  )
}

/** A top IP row on a phone: address, its events and network, then copy, inspect and ban.
 *  The address carries its decision fill and DROP outline, as in the tables. */
function PanelTopIpRow({ rank, ip, network, place, eventCount, locationId, onOpenAlert }: {
  rank: number
  ip: string
  /** "AS64500 Example Net", or null when GeoIP had no ASN for the IP. */
  network: string | null
  place: string
  eventCount: number
  locationId: number
  onOpenAlert?: (decision: DecisionRef) => void
}) {
  return (
    <li className="flex min-h-13 items-center gap-2 border-b border-border/60 py-1 last:border-0">
      <span className="w-4 shrink-0 text-xs tabular-nums text-muted-foreground">{rank}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center">
          <IpStatusDetails
            ip={ip}
            context={[place, network].filter(Boolean).join(" · ")}
            fromLocationId={locationId}
            onOpenAlert={onOpenAlert}
          >
            <IpLabel ip={ip} className="text-[15px] break-all" />
          </IpStatusDetails>
          {/* Beside the IP rather than with the actions, so the line below keeps room for the network. */}
          <CopyIpButton ip={ip} className="-my-3 ml-0.5 size-11 shrink-0 rounded-full" />
        </span>
        <span className="line-clamp-2 text-xs text-muted-foreground">
          <TopIpMeta ip={ip} eventCount={eventCount} network={network} />
        </span>
      </span>
      <InspectIpButton ip={ip} fromLocationId={locationId} className="size-11 rounded-full [&_svg:not([class*='size-'])]:size-5" />
      <PanelBanButton ip={ip} />
    </li>
  )
}

/** The location popup's content on a phone, in a MapDetailPanel. */
export function LocationPanel({
  longitude,
  latitude,
  properties,
  totalEvents,
  onClose,
  onOpenAlert,
  inline = false,
}: MapPopupProps & {
  /** Under a small map in the page flow; see MapDetailPanel. */
  inline?: boolean
}) {
  const { id: locationId, countryName, countryCode, eventCount, lastHit } = properties
  const { data: topIPsData, isLoading: isLoadingTopIPs } = useLocationTopIPs(locationId)
  const topIps = topIPsData?.topIps ?? []
  const { title, where, place, titleIsCountry } = locationHeading(properties)

  return (
    <MapDetailPanel
      point={[longitude, latitude]}
      inline={inline}
      onClose={onClose}
      icon={<MapPin className="size-5 text-primary" />}
      // Without a city or region the country is the title, so its flag moves up with it.
      title={titleIsCountry ? <CountryLabel code={countryCode} name={countryName} className="gap-2">{title}</CountryLabel> : title}
      subtitle={where && <CountryLabel code={countryCode} name={countryName}>{where}</CountryLabel>}
    >
      <PanelStats
        items={[
          { label: "Events", value: formatNumber(eventCount), accent: true },
          { label: "Unique IPs", value: topIPsData ? formatNumber(topIPsData.uniqueIps) : "–" },
          { label: "Of all events", value: totalEvents ? formatShare(eventCount, totalEvents) : "–" },
          {
            label: "Last hit",
            value: lastHit ? new Date(lastHit).toLocaleString() : "Unknown",
            narrowValue: lastHit ? new Date(lastHit).toLocaleTimeString() : "Unknown",
            wide: true,
          },
        ]}
      />
      {(isLoadingTopIPs || topIps.length > 0) && (
        <PanelSection
          icon={isLoadingTopIPs ? <Loader2 className="animate-spin" /> : <Users />}
          title={isLoadingTopIPs ? "Loading top IPs..." : topIps.length === 1 ? "Top IP" : `Top ${topIps.length} IPs`}
        >
          <ol>
            {topIps.map((ip, index) => (
              <PanelTopIpRow
                key={ip.ipAddress}
                rank={index + 1}
                ip={ip.ipAddress}
                network={networkName(ip)}
                place={place}
                eventCount={ip.eventCount}
                locationId={locationId}
                onOpenAlert={onOpenAlert}
              />
            ))}
          </ol>
        </PanelSection>
      )}
      <div className="mt-1 flex flex-wrap items-center justify-between gap-x-3 text-xs text-muted-foreground">
        <span className="tabular-nums">{latitude.toFixed(4)}, {longitude.toFixed(4)}</span>
        <Button asChild variant="link" className="h-auto min-h-11 px-0 text-xs">
          <a href={openStreetMapUrl(latitude, longitude)} target="_blank" rel="noopener noreferrer">
            Open in OpenStreetMap
            <ExternalLink className="size-3.5" />
          </a>
        </Button>
      </div>
    </MapDetailPanel>
  )
}
