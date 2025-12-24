/**
 * Popup component for displaying location details.
 * Uses CSS variables for theming - defined in App.css as --popup-* variables.
 */

import { Popup } from "react-map-gl/maplibre"
import { MapPin, Globe, Clock, Hash, HelpCircle } from "lucide-react"
import { formatNumber } from "@/lib/api"
import type { GeoJSONFeatureProperties } from "@/lib/api"

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

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
    city,
    country_name,
    country_code,
    state,
    event_count,
    last_hit,
    geohash,
  } = properties

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
          background: "var(--popup-bg)",
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
