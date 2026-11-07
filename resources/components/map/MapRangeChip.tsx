import { TAB_BAR_SURFACE } from "@/components/phone-nav/tab-bar"
import { PhoneTimeRangeControls } from "@/components/time-range-toolbar"
import { usePhoneLayout, usePhoneMapSide } from "@/hooks/use-phone-map"
import { usePhoneChrome } from "@/lib/phone-chrome"
import { cn } from "@/lib/utils"
import { pillRight } from "./phone-map-actions"

/**
 * The phone map's refresh button and time range, floating at the top right in
 * place of the header. Held sideways it hides with the pill while a surface
 * covers the bar.
 */
export function MapRangeChip() {
  const phone = usePhoneLayout()
  const side = usePhoneMapSide()
  const { barCovered } = usePhoneChrome()
  if (!phone) return null

  return (
    <div
      role="group"
      aria-label="Time range"
      hidden={barCovered}
      style={{ right: pillRight(side) }}
      className={cn(
        TAB_BAR_SURFACE,
        "absolute top-(--range-chip-top) z-10 flex h-11 items-center gap-0.5 rounded-full border border-border p-[3px]",
      )}
    >
      <PhoneTimeRangeControls chip />
    </div>
  )
}
