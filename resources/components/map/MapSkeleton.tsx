/**
 * Loading skeleton for the map component: the brand map scene as a stand-in
 * for the real one, with the controls placeholder and a loading pill on top.
 */

import { Skeleton } from "@/components/ui/skeleton"
import { MapBackdrop } from "@/components/brand/backdrops"

export function MapSkeleton() {
  return (
    <div className="h-full w-full relative bg-background">
      <MapBackdrop tone="quiet" />

      {/* Controls placeholder */}
      <div className="absolute top-4 right-4 z-10 flex flex-col gap-2">
        <Skeleton className="h-20 w-10 rounded-lg" />
        <Skeleton className="h-10 w-10 rounded-lg" />
      </div>

      {/* Loading indicator */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 p-6 rounded-lg bg-background/80 backdrop-blur-sm">
          <div className="h-8 w-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-muted-foreground">Loading map...</span>
        </div>
      </div>
    </div>
  )
}
