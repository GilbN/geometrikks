/**
 * Map route - Interactive geo-location visualization.
 *
 * Data filters (sources/countries/cities) live in the URL search params so
 * filtered map views are shareable links; see resources/lib/map-filters.ts
 * for the codec.
 */

import { createFileRoute } from "@tanstack/react-router"
import { lazy, Suspense } from "react"
import { MapSkeleton } from "@/components/map/MapSkeleton"
import { mapSearchSchema } from "@/lib/map-filters"

const GeoMap = lazy(() => import("@/components/map/GeoMap"))

export const Route = createFileRoute("/map")({
  validateSearch: (search: Record<string, unknown>) => mapSearchSchema.parse(search),
  component: MapPage,
})

function MapPage() {
  return (
    <div className="fullscreen-map h-full w-full relative">
      <Suspense fallback={<MapSkeleton />}>
        <GeoMap />
      </Suspense>
    </div>
  )
}
