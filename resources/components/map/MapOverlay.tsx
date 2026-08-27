import { cn } from "@/lib/utils"

type Placement = "top-left" | "top-right" | "bottom-left" | "bottom-right"

const PLACEMENT: Record<Placement, string> = {
  "top-left": "top-[max(1rem,env(safe-area-inset-top))] left-[max(1rem,env(safe-area-inset-left))]",
  "top-right": "top-[max(1rem,env(safe-area-inset-top))] right-[max(1rem,env(safe-area-inset-right))]",
  "bottom-left": "bottom-[max(1rem,env(safe-area-inset-bottom))] left-[max(1rem,env(safe-area-inset-left))]",
  "bottom-right": "bottom-[max(1rem,env(safe-area-inset-bottom))] right-[max(1rem,env(safe-area-inset-right))]",
}

/**
 * A floating surface over the map: glass card, safe-area offsets, a bounded
 * height and internal scrolling so it never grows to the map's full height
 * or under the MapLibre controls docked bottom-right.
 */
export function MapOverlay({
  placement,
  className,
  ...props
}: React.ComponentProps<"div"> & { placement: Placement }) {
  return (
    <div
      data-slot="map-overlay"
      data-placement={placement}
      className={cn(
        "pointer-events-auto absolute z-10 flex max-h-[min(38rem,calc(100%-2rem))] flex-col overflow-hidden rounded-xl bg-background/85 ring-1 ring-border shadow-[var(--shadow-card)] backdrop-blur",
        PLACEMENT[placement],
        className,
      )}
      {...props}
    />
  )
}
