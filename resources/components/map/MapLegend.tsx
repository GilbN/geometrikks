/**
 * Map legend showing the color scale for heatmap or markers.
 * On mobile it collapses to a small swatch button (hidden by default) that
 * expands the full card on tap, to keep the map area uncluttered.
 *
 * Positioning is owned by GeoMap's bottom-left overlay stack, so the legend
 * and the live request strips can never overlap.
 */

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { formatNumber } from "@/lib/api"
import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"
import type { LayerType } from "./GeoMap"

interface MapLegendProps {
  maxValue: number
  layerType: LayerType
}

// Traditional heatmap gradient: blue -> cyan -> green -> yellow -> orange -> red
const HEATMAP_GRADIENT =
  "linear-gradient(to right, rgba(65, 105, 225, 0.6), rgba(0, 191, 255, 0.7), rgba(0, 255, 127, 0.75), rgba(255, 255, 0, 0.8), rgba(255, 140, 0, 0.85), rgba(220, 20, 60, 1))"

// Marker gradient: green -> yellow -> red
const MARKER_GRADIENT =
  "linear-gradient(to right, rgba(34, 197, 94, 0.9), rgba(132, 204, 22, 0.9), rgba(234, 179, 8, 0.9), rgba(249, 115, 22, 0.9), rgba(239, 68, 68, 0.9), rgba(185, 28, 28, 0.95))"

export function MapLegend({ maxValue, layerType }: MapLegendProps) {
  const isHeatmap = layerType === "heatmap"
  const title = isHeatmap ? "Event Density" : "Event Count"
  const gradient = isHeatmap ? HEATMAP_GRADIENT : MARKER_GRADIENT
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(false)

  // Mobile, collapsed: a compact swatch button that expands the legend on tap.
  if (isMobile && !open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`Show ${title.toLowerCase()} legend`}
        aria-label={`Show ${title.toLowerCase()} legend`}
        className="pointer-events-auto flex items-center gap-2 rounded-md border border-border/50 bg-card/90 px-2.5 py-1.5 shadow-sm backdrop-blur cursor-pointer"
      >
        <span
          className="h-2.5 w-10 rounded-sm"
          style={{ background: gradient }}
        />
        <span className="text-[10px] font-medium text-muted-foreground">
          {title}
        </span>
      </button>
    )
  }

  return (
    <Card className="pointer-events-auto gap-3 py-0 w-44">
      <CardHeader className="pb-0 pt-3 px-3">
        <CardTitle
          className={cn(
            "text-xs font-medium text-muted-foreground flex items-center justify-between",
            isMobile && "gap-2",
          )}
        >
          {title}
          {isMobile && (
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label={`Hide ${title.toLowerCase()} legend`}
              className="cursor-pointer text-muted-foreground/60"
            >
              <span aria-hidden="true">×</span>
            </button>
          )}
        </CardTitle>
        <div className="border-b border-border/50">
        </div>
      </CardHeader>
      <CardContent className="pb-3 px-3">
        {/* Color gradient bar */}
        <div
          className="h-3 w-full rounded-sm"
          style={{ background: gradient }}
        />

        {/* Labels */}
        <div className="flex justify-between mt-1.5 text-[10px] text-muted-foreground">
          <span>Low</span>
          <span>High</span>
        </div>

        {/* Max value indicator */}
        {maxValue > 0 && (
          <div className="mt-2 pt-2 border-t border-border/50">
            <div className="flex justify-between text-[10px]">
              <span className="text-muted-foreground">Total</span>
              <span className="text-foreground font-medium">
                {formatNumber(maxValue)}
              </span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
