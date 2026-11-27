import { ZoomOut } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useTimeFormat } from "@/lib/table-view"
import { timeRangeName, timeRangeSpan } from "@/lib/time-range-label"
import type { ZoomStep } from "@/lib/chart-zoom"

/** "Zoom out to Last 7 days": back to the range the last zoom started from. */
export function ZoomOutButton({ back, onClick }: { back: ZoomStep["from"]; onClick: () => void }) {
  const [timeFormat] = useTimeFormat()
  const name =
    back.range === "custom"
      ? timeRangeSpan(back.range, back.customRange, Date.now(), timeFormat)
      : timeRangeName(back.range)
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      onClick={onClick}
      className="-my-1.5 gap-1.5 bg-card font-medium"
    >
      <ZoomOut aria-hidden />
      Zoom out <span className="font-normal text-muted-foreground">to {name}</span>
    </Button>
  )
}
