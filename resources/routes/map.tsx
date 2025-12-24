/**
 * Map route - Interactive geo-location visualization.
 */

import { createFileRoute } from "@tanstack/react-router"
import { lazy, Suspense } from "react"
import { MapSkeleton } from "@/components/map/MapSkeleton"

const GeoMap = lazy(() => import("@/components/map/GeoMap"))

export const Route = createFileRoute("/map")({
  component: MapPage,
})

function MapPage() {
  return (
    <div className="h-[calc(100vh-3.5rem)] w-full relative">
      <Suspense fallback={<MapSkeleton />}>
        <GeoMap />
      </Suspense>
    </div>
  )
}
