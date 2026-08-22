/**
 * Map route - Interactive geo-location visualization.
 *
 * Data filters (sources/countries/cities) live in the URL search params so
 * filtered map views are shareable links; see resources/lib/map-filters.ts
 * for the codec.
 */

import { createFileRoute } from "@tanstack/react-router"
import { lazy, Suspense } from "react"
import { z } from "zod"
import { MapSkeleton } from "@/components/map/MapSkeleton"

const GeoMap = lazy(() => import("@/components/map/GeoMap"))

const mapSearchSchema = z.object({
  sources: z.array(z.string()).optional().catch(undefined),
  countries: z.array(z.string()).optional().catch(undefined),
  cities: z.array(z.string()).optional().catch(undefined),
  demoTraffic: z.string().optional().catch(undefined),
})

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
