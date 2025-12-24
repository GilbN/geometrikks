/**
 * Map legend showing the color scale for heatmap or markers.
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { formatNumber } from "@/lib/api"
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

  return (
    <Card className="absolute bottom-6 left-4 z-10 w-44">
      <CardHeader className="pb-2 pt-3 px-3">
        <CardTitle className="text-xs font-medium text-muted-foreground">
          {title}
        </CardTitle>
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
              <span className="text-muted-foreground">Max hits</span>
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
