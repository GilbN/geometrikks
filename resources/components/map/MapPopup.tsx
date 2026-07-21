/**
 * Popup component for displaying location details.
 * Uses CSS variables for theming - defined in main.css as --popup-* variables.
 */

import { Popup } from "react-map-gl/maplibre"
import {
  MapPin,
  Globe,
  Clock,
  Hash,
  Users,
  ChevronsUpDown,
  Loader2,
  ShieldBan,
  ShieldOff,
} from "lucide-react"
import { formatNumber } from "@/lib/api"
import type { GeoJSONFeatureProperties } from "@/lib/api"
import {
  useLocationTopIPs,
  useBannedIps,
  useBanIp,
  useUnbanIp,
  useCrowdsecStatus,
} from "@/lib/queries"

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

/** Banned badge + ban/unban action for one IP row in the top-IPs list.
 *  Renders nothing unless the CrowdSec integration is involved. */
function IpBanControls({ ip }: { ip: string }) {
  const { data: status } = useCrowdsecStatus()
  const { data: bannedIps } = useBannedIps()
  const ban = useBanIp()
  const unban = useUnbanIp()
  const banned = bannedIps?.has(ip) ?? false
  const isPending = ban.isPending || unban.isPending

  if (!banned && !status?.write_enabled) return null
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
      {banned && (
        <span
          style={{
            fontSize: "9px",
            fontWeight: 600,
            textTransform: "uppercase",
            color: "#f87171",
            background: "rgba(239, 68, 68, 0.15)",
            padding: "1px 5px",
            borderRadius: "9999px",
          }}
        >
          banned
        </span>
      )}
      {status?.write_enabled && (
        <button
          onClick={() => (banned ? unban.mutate(ip) : ban.mutate({ ip }))}
          disabled={isPending}
          title={banned ? `Unban ${ip}` : `Ban ${ip} (default duration)`}
          aria-label={banned ? `Unban ${ip}` : `Ban ${ip}`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            background: "transparent",
            border: "none",
            padding: "2px",
            cursor: isPending ? "wait" : "pointer",
            color: isPending ? "#22d3ee" : "var(--popup-muted)",
          }}
        >
          {isPending ? (
            <Loader2 style={{ width: 12, height: 12, animation: "spin 1s linear infinite" }} />
          ) : banned ? (
            <ShieldOff style={{ width: 12, height: 12 }} />
          ) : (
            <ShieldBan style={{ width: 12, height: 12 }} />
          )}
        </button>
      )}
    </span>
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
    country_name,
    country_code,
    state,
    event_count,
    last_hit,
    geohash,
  } = properties

  // Fetch top IPs on-demand when popup opens
  const { data: topIPsData, isLoading: isLoadingTopIPs } = useLocationTopIPs(locationId)
  const top_ips = topIPsData?.top_ips ?? []

  // Format last hit date
  const formattedLastHit = last_hit
    ? new Date(last_hit).toLocaleString()
    : "Unknown"

  // Build location string
  const locationParts = [city, state, country_name].filter(Boolean)
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
      maxWidth="280px"
      style={{
        // Override the popup container background
        background: "transparent",
      }}
    >
      <div
        style={{
          background: "var(--card)",
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

        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            paddingBottom: "8px",
            marginBottom: "8px",
            borderBottom: "1px solid var(--popup-border)",
          }}
        >
          <MapPin style={{ width: 16, height: 16, color: "#22d3ee", flexShrink: 0 }} />
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
            {formatNumber(event_count)}
          </span>
        </div>

        {/* Country */}
        {country_code && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "12px", marginBottom: "6px" }}>
            <span style={{ color: "var(--popup-muted)", display: "flex", alignItems: "center", gap: "4px" }}>
              <Globe style={{ width: 12, height: 12 }} />
              Country
            </span>
            <span style={{ fontWeight: 500 }}>{country_code}</span>
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
                    style={{
                      fontSize: "10px",
                      background: "var(--popup-code-bg)",
                      padding: "2px 6px",
                      borderRadius: "4px",
                      fontFamily: "monospace",
                    }}
                  >
                    1. {top_ips[0].ip_address}
                  </code>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                    <IpBanControls ip={top_ips[0].ip_address} />
                    <span
                      style={{
                        fontSize: "10px",
                        color: "var(--popup-muted)",
                      }}
                    >
                      {formatNumber(top_ips[0].event_count)}
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
                            key={ip.ip_address}
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                              fontSize: "11px",
                            }}
                          >
                            <code
                              style={{
                                fontSize: "10px",
                                background: "var(--popup-code-bg)",
                                padding: "2px 6px",
                                borderRadius: "4px",
                                fontFamily: "monospace",
                              }}
                            >
                              {index + 2}. {ip.ip_address}
                            </code>
                            <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                              <IpBanControls ip={ip.ip_address} />
                              <span
                                style={{
                                  fontSize: "10px",
                                  color: "var(--popup-muted)",
                                }}
                              >
                                {formatNumber(ip.event_count)}
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
