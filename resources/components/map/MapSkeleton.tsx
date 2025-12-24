/**
 * Loading skeleton for the map component.
 */

import { Skeleton } from "@/components/ui/skeleton"

export function MapSkeleton() {
  return (
    <div className="h-full w-full relative bg-background">
      {/* Map placeholder */}
      <Skeleton className="h-full w-full rounded-none" />

      {/* Controls placeholder */}
      <div className="absolute top-4 right-4 z-10 flex flex-col gap-2">
        <Skeleton className="h-20 w-10 rounded-lg" />
        <Skeleton className="h-10 w-10 rounded-lg" />
      </div>

      {/* Legend placeholder */}
      <div className="absolute bottom-6 left-4 z-10">
        <Skeleton className="h-32 w-48 rounded-lg" />
      </div>

      {/* Loading indicator */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 p-6 rounded-lg bg-background/80 backdrop-blur-sm">
          <div className="h-8 w-8 border-2 border-geo-cyan border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-muted-foreground">Loading map...</span>
        </div>
      </div>
    </div>
  )
}
