/**
 * Popup component for displaying location details.
 * Uses CSS variables for theming - defined in main.css as --popup-* variables.
 */

import type { CSSProperties } from "react"
import { Popup } from "react-map-gl/maplibre"
import { MapPin, Globe, Clock, Hash, Users, ChevronsUpDown, Loader2 } from "lucide-react"
import { formatNumber } from "@/lib/api"
import type { GeoJSONFeatureProperties } from "@/lib/api"
import { useLocationTopIPs } from "@/lib/queries"
import { IpBanControls } from "./IpBanControls"
import { InspectIpButton } from "./InspectIpButton"

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"

// One line per IP: the rank is glued to the address with a non-breaking
// space and the box never wraps. A full IPv6 address needs the wider popup
// below to fit beside the icons and the count.
const IP_CODE_STYLE: CSSProperties = {
  fontSize: "10px",
  background: "var(--popup-code-bg)",
  padding: "2px 6px",
  borderRadius: "4px",
  fontFamily: "monospace",
  whiteSpace: "nowrap",
}

function LastHitToolTip({ lastHit }: { lastHit: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span style={{ fontWeight: 500, fontSize: "10px" }}>{lastHit}</span>
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
}

export function MapPopup({
  longitude,
  latitude,
  properties,
  onClose,
}: MapPopupProps) {
  const {
    id: locationId,
    city,
    countryName,
    countryCode,
    state,
    eventCount,
    lastHit,
    geohash,
  } = properties

  // Fetch top IPs on-demand when popup opens
  const { data: topIPsData, isLoading: isLoadingTopIPs } = useLocationTopIPs(locationId)
  const top_ips = topIPsData?.topIps ?? []
  const hasIpv6 = top_ips.some((ip) => ip.ipAddress.includes(":"))

  // Format last hit date
  const formattedLastHit = lastHit
    ? new Date(lastHit).toLocaleString()
    : "Unknown"

  // Build location string
  const locationParts = [city, state, countryName].filter(Boolean)
  const locationString = locationParts.join(", ") || "Unknown Location"

  return (
    <Popup
      longitude={longitude}
      latitude={latitude}
      anchor="bottom"
      onClose={onClose}
      closeButton={false}
      closeOnClick={false}
      className="geo-popup"
      maxWidth={hasIpv6 ? "380px" : "280px"}
      style={{
        // Override the popup container background
        background: "transparent",
      }}
    >
      <div
        style={{
          // Positioned so the close button anchors to this card rather than
          // to whichever ancestor MapLibre happens to have positioned.
          position: "relative",
          background: "color-mix(in oklab, var(--background) 85%, transparent)",
          backdropFilter: "blur(8px)",
          color: "var(--popup-fg)",
          borderRadius: "8px",
          padding: "12px",
          boxShadow: "0 4px 12px rgba(0, 0, 0, 0.3)",
          border: "1px solid var(--popup-border)",
          minWidth: "200px",
        }}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          style={{
            position: "absolute",
            top: "8px",
            right: "8px",
            background: "transparent",
            border: "none",
            color: "var(--popup-muted)",
            cursor: "pointer",
            fontSize: "18px",
            lineHeight: 1,
            padding: "2px 6px",
          }}
          aria-label="Close popup"
        >
          ×
        </button>

        {/* Header. paddingRight clears the absolutely positioned close
            button, which otherwise sits on top of the location name. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            paddingBottom: "8px",
            paddingRight: "24px",
            marginBottom: "8px",
            borderBottom: "1px solid var(--popup-border)",
          }}
        >
          <MapPin style={{ width: 16, height: 16, color: "var(--primary)", flexShrink: 0 }} />
          <span style={{ fontSize: "14px", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {locationString}
          </span>
        </div>

        {/* Event count */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
          <span style={{ fontSize: "12px", color: "var(--popup-muted)" }}>Events</span>
          <span
            style={{
              background: "var(--popup-badge-bg)",
              color: "var(--popup-badge-text)",
              padding: "2px 8px",
              borderRadius: "9999px",
              fontSize: "12px",
              fontWeight: 500,
            }}
          >
            {formatNumber(eventCount)}
          </span>
        </div>

        {/* Country */}
        {countryCode && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "12px", marginBottom: "6px" }}>
            <span style={{ color: "var(--popup-muted)", display: "flex", alignItems: "center", gap: "4px" }}>
              <Globe style={{ width: 12, height: 12 }} />
              Country
            </span>
            <span style={{ fontWeight: 500 }}>{countryCode}</span>
          </div>
        )}

        {/* Last hit */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "12px", marginBottom: "6px" }}>
          <span style={{ color: "var(--popup-muted)", display: "flex", alignItems: "center", gap: "4px" }}>
            <Clock style={{ width: 12, height: 12 }} />
            Last hit
          </span>
          <LastHitToolTip lastHit={formattedLastHit} />
        </div>

        {/* Geohash */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "12px", marginBottom: "6px" }}>
          <span style={{ color: "var(--popup-muted)", display: "flex", alignItems: "center", gap: "4px" }}>
            <Hash style={{ width: 12, height: 12 }} />
            Geohash
          </span>
          <code
            style={{
              fontSize: "10px",
              background: "var(--popup-code-bg)",
              padding: "2px 6px",
              borderRadius: "4px",
              fontFamily: "monospace",
            }}
          >
            {geohash}
          </code>
        </div>

        {/* Top IPs */}
        {(isLoadingTopIPs || top_ips.length > 0) && (
          <Collapsible
            style={{
              paddingTop: "8px",
              marginTop: "8px",
              borderTop: "1px solid var(--popup-border)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "4px", marginBottom: "6px" }}>
              <Users style={{ width: 12, height: 12, color: "var(--popup-muted)" }} />
              <span style={{ fontSize: "12px", color: "var(--popup-muted)" }}>
                {isLoadingTopIPs ? "Loading..." : `Top ${top_ips.length} IPs`}
              </span>
              {isLoadingTopIPs && <Loader2 style={{ width: 10, height: 10, animation: "spin 1s linear infinite" }} />}
            </div>
            {/* First IP always visible */}
            {!isLoadingTopIPs && top_ips.length > 0 && (
              <>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    fontSize: "11px",
                  }}
                >
                  <code
                    style={IP_CODE_STYLE}
                  >
                    1.&nbsp;{top_ips[0].ipAddress}
                  </code>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", flexShrink: 0 }}>
                    <IpBanControls ip={top_ips[0].ipAddress}>
                      <InspectIpButton ip={top_ips[0].ipAddress} fromLocationId={locationId} />
                    </IpBanControls>
                    <span
                      style={{
                        fontSize: "10px",
                        color: "var(--popup-muted)",
                      }}
                    >
                      {formatNumber(top_ips[0].eventCount)}
                    </span>
                  </span>
                </div>
                {/* Remaining IPs in collapsible */}
                {top_ips.length > 1 && (
                  <>
                    <CollapsibleContent>
                      <div style={{ display: "flex", flexDirection: "column", gap: "4px", marginTop: "4px" }}>
                        {top_ips.slice(1).map((ip, index) => (
                          <div
                            key={ip.ipAddress}
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                              fontSize: "11px",
                            }}
                          >
                            <code
                              style={IP_CODE_STYLE}
                            >
                              {index + 2}.&nbsp;{ip.ipAddress}
                            </code>
                            <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", flexShrink: 0 }}>
                              <IpBanControls ip={ip.ipAddress}>
                                <InspectIpButton ip={ip.ipAddress} fromLocationId={locationId} />
                              </IpBanControls>
                              <span
                                style={{
                                  fontSize: "10px",
                                  color: "var(--popup-muted)",
                                }}
                              >
                                {formatNumber(ip.eventCount)}
                              </span>
                            </span>
                          </div>
                        ))}
                      </div>
                    </CollapsibleContent>
                    <CollapsibleTrigger
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: "100%",
                        background: "transparent",
                        border: "none",
                        padding: "4px 0 0 0",
                        cursor: "pointer",
                        color: "var(--popup-muted)",
                        fontSize: "10px",
                        gap: "4px",
                      }}
                    >
                      <ChevronsUpDown style={{ width: 10, height: 10 }} />
                      <span>{top_ips.length - 1} more</span>
                    </CollapsibleTrigger>
                  </>
                )}
              </>
            )}
          </Collapsible>
        )}

        {/* Coordinates */}
        <div
          style={{
            paddingTop: "6px",
            marginTop: "6px",
            borderTop: "1px solid var(--popup-border)",
            fontSize: "10px",
            color: "var(--popup-muted)",
          }}
        >
          {latitude.toFixed(4)}, {longitude.toFixed(4)}
        </div>
      </div>
    </Popup>
  )
}
