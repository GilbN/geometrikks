/**
 * Map control overlay with layer toggle and utilities.
 */

import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Flame, MapPin, Maximize2, Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"
import type { LayerType } from "./GeoMap"

interface MapControlsProps {
  activeLayer: LayerType
  onLayerChange: (layer: LayerType) => void
  onFitBounds: () => void
  isLoading?: boolean
  featureCount?: number
}

export function MapControls({
  activeLayer,
  onLayerChange,
  onFitBounds,
  isLoading = false,
  featureCount = 0,
}: MapControlsProps) {
  return (
    <div className="absolute top-4 right-4 z-10 flex flex-col gap-2">
      {/* Layer Toggle */}
      <Card className="p-2">
        <ToggleGroup
          type="single"
          value={activeLayer}
          onValueChange={(value) => value && onLayerChange(value as LayerType)}
          className="flex flex-col gap-1"
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
      <Card className="p-1">
        <Button
          variant="ghost"
          size="icon"
          onClick={onFitBounds}
          disabled={isLoading || featureCount === 0}
          title="Fit to data bounds"
        >
          <Maximize2 className="h-4 w-4" />
        </Button>
      </Card>

      {/* Status Indicator */}
      <Card className="px-3 py-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {isLoading ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>Loading...</span>
            </>
          ) : (
            <>
              <div className="h-2 w-2 rounded-full bg-emerald-500" />
              <span>{featureCount} locations</span>
            </>
          )}
        </div>
      </Card>
    </div>
  )
}
