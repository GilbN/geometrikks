import { TAB_BAR_SURFACE } from "@/components/phone-nav/tab-bar"
import { PhoneTimeRangeControls } from "@/components/time-range-toolbar"
import { usePhoneLayout, usePhoneMapSide } from "@/hooks/use-phone-map"
import { usePhoneChrome } from "@/lib/phone-chrome"
import { cn } from "@/lib/utils"
import { pillRight } from "./phone-map-actions"

/**
 * The phone map's top row, in place of the header: the live vitals pill
 * (GeoMap portals it into `liveSlotRef`) on the left, and the refresh button
 * and time range in a chip on the right. Held sideways the chip hides with
 * the pill while a surface covers the bar.
 */
export function MapTopRow({ liveSlotRef }: { liveSlotRef: (slot: HTMLDivElement | null) => void }) {
  const phone = usePhoneLayout()
  const side = usePhoneMapSide()
  const { barCovered } = usePhoneChrome()
  if (!phone) return null

  return (
    <div
      style={{ right: pillRight(side) }}
      className="pointer-events-none absolute top-(--range-chip-top) left-[max(1rem,env(safe-area-inset-left))] z-20 flex h-(--range-chip-height) items-center gap-2"
    >
      <div ref={liveSlotRef} className="flex min-w-0" />
      <div
        role="group"
        aria-label="Time range"
        hidden={barCovered}
        className={cn(
          TAB_BAR_SURFACE,
          "pointer-events-auto ml-auto flex h-(--range-chip-height) shrink-0 items-center gap-0.5 rounded-full border border-border p-[3px]",
        )}
      >
        <PhoneTimeRangeControls chip />
      </div>
    </div>
  )
}
