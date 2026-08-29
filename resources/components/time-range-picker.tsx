/**
 * Time-range picker shared by the toolbar and the IP inspector: a dropdown
 * with the preset list and custom from/to fields from `md` up, a bottom
 * drawer with a preset grid below it. The caller supplies the trigger.
 */
import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { useIsMobile } from "@/hooks/use-mobile"
import { TIME_RANGE_PRESETS, type CustomTimeRange, type TimeRangeValue } from "@/lib/api"
import { useTimeRange } from "@/lib/time-range-context"
import { cn } from "@/lib/utils"

/** Trigger text for the current selection: the preset, or the custom span's dates. */
export function timeRangeLabel(range: TimeRangeValue, customRange: CustomTimeRange | null): string {
  return range === "custom" && customRange
    ? `${new Date(customRange.from).toLocaleDateString(undefined, { month: "short", day: "numeric" })} → ${new Date(customRange.to).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
    : TIME_RANGE_PRESETS.find((p) => p.value === range)?.label || "Range"
}

function CustomRangeFields({ onApply }: { onApply: (r: CustomTimeRange) => void }) {
  const { customRange } = useTimeRange()
  const toLocal = (iso?: string) => {
    if (!iso) return ""
    const d = new Date(iso)
    const pad = (n: number) => String(n).padStart(2, "0")
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  } // datetime-local value (local wall-clock, not UTC)
  const [from, setFrom] = useState(toLocal(customRange?.from))
  const [to, setTo] = useState(toLocal(customRange?.to))
  const valid = from && to && new Date(from) < new Date(to)
  return (
    <div className="flex flex-col gap-2 p-2 w-64">
      <label className="text-xs text-muted-foreground">From</label>
      <Input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
      <label className="text-xs text-muted-foreground">To</label>
      <Input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
      <Button
        size="sm"
        className="pointer-coarse:h-10"
        disabled={!valid}
        onClick={() => onApply({ from: new Date(from).toISOString(), to: new Date(to).toISOString() })}
      >
        Apply
      </Button>
    </div>
  )
}

export function TimeRangePicker({
  trigger,
  align = "start",
}: {
  trigger: React.ReactNode
  align?: "start" | "end"
}) {
  const { range, setRange, setCustomRange } = useTimeRange()
  const isMobile = useIsMobile()
  const [rangeDrawerOpen, setRangeDrawerOpen] = useState(false)

  if (isMobile) {
    return (
      /* Time Range Drawer - a bottom sheet with a preset grid, replacing the
          cramped tall dropdown that overflowed the viewport. */
      <Drawer open={rangeDrawerOpen} onOpenChange={setRangeDrawerOpen}>
        <DrawerTrigger asChild>{trigger}</DrawerTrigger>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>Time Range</DrawerTitle>
            <DrawerDescription className="sr-only">
              Choose a preset time range or set a custom from/to range.
            </DrawerDescription>
          </DrawerHeader>
          <div className="overflow-y-auto px-4 pb-6">
            {/* Presets as a compact grid instead of a long scroll list */}
            <div className="grid grid-cols-3 gap-2">
              {TIME_RANGE_PRESETS.map((preset) => (
                <Button
                  key={preset.value}
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setRange(preset.value)
                    setRangeDrawerOpen(false)
                  }}
                  className={cn(
                    "text-xs pointer-coarse:h-10",
                    range === preset.value &&
                      "bg-primary/20 text-primary border-primary/40"
                  )}
                >
                  {preset.label}
                </Button>
              ))}
            </div>
            <div className="mt-4 border-t border-border/50 pt-2">
              <div className="text-xs font-medium text-muted-foreground px-2">
                Custom range
              </div>
              <CustomRangeFields
                onApply={(r) => {
                  setCustomRange(r)
                  setRangeDrawerOpen(false)
                }}
              />
            </div>
          </div>
        </DrawerContent>
      </Drawer>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-auto!">
        {TIME_RANGE_PRESETS.map((preset) => (
          <DropdownMenuItem
            key={preset.value}
            onClick={() => setRange(preset.value)}
            className={cn(
              "text-xs",
              range === preset.value && "bg-primary/20 text-primary"
            )}
          >
            {preset.label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs">Custom range</DropdownMenuLabel>
        <div onKeyDown={(e) => e.stopPropagation()}>
          <CustomRangeFields onApply={setCustomRange} />
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
