/**
 * Map control overlay with layer toggle and utilities.
 * Collapsible on mobile for better map visibility.
 */

import { useState, useEffect } from "react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Flame, MapPin, Maximize2, Loader2, SlidersHorizontal, X } from "lucide-react"
import { cn } from "@/lib/utils"
import type { LayerType } from "./GeoMap"
import { GEOJSONFeatureStats, formatNumber } from "@/lib/api"


interface MapControlsProps {
  activeLayer: LayerType
  onLayerChange: (layer: LayerType) => void
  onFitBounds: () => void
  isLoading?: boolean
  featureStats: GEOJSONFeatureStats
  onFlyToLocation?: (lat: number, lng: number) => void
}

export function MapControls({
  activeLayer,
  onLayerChange,
  onFitBounds,
  isLoading = false,
  featureStats,
  onFlyToLocation
}: MapControlsProps) {
  const { events: events, countries, cities, locations, top_ips } = featureStats;
  const [isExpanded, setIsExpanded] = useState(true)

  // Default collapsed on mobile (< 768px)
  useEffect(() => {
    const checkMobile = () => setIsExpanded(window.innerWidth >= 768)
    checkMobile()
    window.addEventListener('resize', checkMobile)
    return () => window.removeEventListener('resize', checkMobile)
  }, [])

  // Collapsed state - single toggle button
  if (!isExpanded) {
    return (
      <div className="absolute top-4 right-4 z-10">
        <Button
          size="icon"
          variant="outline"
          className="bg-background mt-1"
          onClick={() => setIsExpanded(true)}
          title="Show map controls"
        >
          <SlidersHorizontal className="h-4 w-4" />
        </Button>
      </div>
    )
  }

  // Expanded state - full controls
  return (
    <div className="absolute top-4 right-4 bottom-4 z-10 flex gap-2 overflow-hidden">
      {/* Scrollable controls area */}
      <div
        className="flex flex-col gap-2 p-1 overflow-y-auto overscroll-contain min-h-0 max-w-[min(200px,calc(100vw-4rem))]"
        style={{ touchAction: 'pan-y' }}
      >
      {/* Layer Toggle */}
      <Card className="p-2 shrink-0">
        <ToggleGroup
          type="single"
          value={activeLayer}
          onValueChange={(value) => value && onLayerChange(value as LayerType)}
          className="flex flex-col gap-1 w-full"
          orientation="vertical"
          spacing={4}
        >
          <ToggleGroupItem
            value="heatmap"
            aria-label="Heatmap view"
            variant="outline"
            className={cn(
              "w-full justify-start gap-2 px-3 data-[state=on]:bg-geo-cyan/15 data-[state=on]:text-geo-cyan data-[state=on]:border-geo-cyan/30",
              activeLayer === "heatmap" && "bg-geo-cyan/15 text-geo-cyan border-geo-cyan/30"
            )}
          >
            <Flame className="h-4 w-4" />
            <span className="text-sm font-medium">Heatmap</span>
          </ToggleGroupItem>
          <ToggleGroupItem
            value="markers"
            aria-label="Marker view"
            variant="outline"
            className={cn(
              "w-full justify-start gap-2 px-3 data-[state=on]:bg-geo-cyan/15 data-[state=on]:text-geo-cyan data-[state=on]:border-geo-cyan/30",
              activeLayer === "markers" && "bg-geo-cyan/15 text-geo-cyan border-geo-cyan/30"
            )}
          >
            <MapPin className="h-4 w-4" />
            <span className="text-sm font-medium">Markers</span>
          </ToggleGroupItem>
        </ToggleGroup>
      </Card>

      {/* Fit Bounds Button */}
      <Card className="p-1 shrink-0">
        <Button
          variant="ghost"
          size="icon"
          onClick={onFitBounds}
          disabled={isLoading || events === 0}
          title="Fit to data bounds"
        >
          <Maximize2 className="h-4 w-4" />
        </Button>
      </Card>

      {/* Status Indicator */}
      <Card className="px-3 py-2 shrink-0">
        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
          {isLoading ? (
            <div className="flex items-center gap-2">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>Loading...</span>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <div className="h-2 w-2 rounded-full bg-emerald-500" />
                <span>{events} events</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="h-2 w-2 rounded-full bg-emerald-500" />
                <span>{countries} countries</span>
              </div>              <div className="flex items-center gap-2">
                <div className="h-2 w-2 rounded-full bg-emerald-500" />
                <span>{cities} cities</span>
              </div>              <div className="flex items-center gap-2">
                <div className="h-2 w-2 rounded-full bg-emerald-500" />
                <span>{locations} locations</span>
              </div>
            </>
          )}
        </div>
      </Card>

      {/* Top IPs */}
      {top_ips && top_ips.length > 0 && (
        <Card className="px-3 py-2 gap-1 shrink-0">
          <div className="text-xs font-medium text-muted-foreground mb-2">Top IPs</div>
          <div className="flex flex-col gap-1">
            {top_ips.map((ip) => (
              <button
                key={ip.ip_address}
                onClick={() => ip.location && onFlyToLocation?.(ip.location.latitude, ip.location.longitude)}
                disabled={!ip.location}
                className="flex items-center justify-between text-[10px] hover:bg-accent/50 rounded px-1 py-0.5 -mx-1 cursor-pointer disabled:cursor-default disabled:opacity-50 text-left"
              >
                <div className="font-mono truncate"><Badge variant="secondary" className="text-[10px] h-5 min-w-5 py-0 font-mono tabular-nums">{formatNumber(ip.event_count)}</Badge> {ip.ip_address}</div>
                <span className="text-muted-foreground ml-2 shrink-0">
                  {ip.location?.city ?? ip.location?.country_code ?? ""}
                </span>
              </button>
            ))}
          </div>
        </Card>
      )}
      </div>
      {/* Collapse button - inline right */}
      <Button
        size="icon"
        variant="outline"
        className="mt-1 bg-background shrink-0 p-1 self-start"
        onClick={() => setIsExpanded(false)}
        title="Hide map controls"
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  )
}
