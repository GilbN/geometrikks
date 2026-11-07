/**
 * Map route - Interactive geo-location visualization.
 *
 * Data filters (servers/countries/cities) live in the URL search params so
 * filtered map views are shareable links; see resources/lib/map-filters.ts
 * for the codec.
 */

import { createFileRoute } from "@tanstack/react-router"
import { lazy, Suspense, useState } from "react"
import { MapLiveSlotContext } from "@/components/map/map-live-slot"
import { MapSkeleton } from "@/components/map/MapSkeleton"
import { MapTopRow } from "@/components/map/MapTopRow"
import { mapSearchSchema } from "@/lib/map-filters"

const GeoMap = lazy(() => import("@/components/map/GeoMap"))

export const Route = createFileRoute("/map")({
  validateSearch: (search: Record<string, unknown>) => mapSearchSchema.parse(search),
  staticData: { timeRange: true },
  component: MapPage,
})

function MapPage() {
  const [liveSlot, setLiveSlot] = useState<HTMLDivElement | null>(null)
  return (
    <div className="fullscreen-map h-full w-full relative">
      <MapTopRow liveSlotRef={setLiveSlot} />
      <MapLiveSlotContext.Provider value={liveSlot}>
        <Suspense fallback={<MapSkeleton />}>
          <GeoMap />
        </Suspense>
      </MapLiveSlotContext.Provider>
    </div>
  )
}
