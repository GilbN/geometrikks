/**
 * Time-range picker shared by the toolbar and the IP inspector: a dropdown
 * with the preset list and custom from/to fields from `md` up, a bottom
 * drawer below it with the presets split into Recent, Calendar and Custom
 * tabs. The caller supplies the trigger. With `refreshControls` the drawer
 * also sets auto refresh and, on chart pages, the chart buckets, which the
 * phone header has no room for.
 */
import { useEffect, useState } from "react"
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useIsMobile } from "@/hooks/use-mobile"
import {
  CHART_GRANULARITY_OPTIONS,
  POLL_INTERVAL_OPTIONS,
  TIME_RANGE_PRESETS,
  type ChartGranularity,
  type CustomTimeRange,
  type TimeRangeValue,
} from "@/lib/api"
import { useTimeRange } from "@/lib/time-range-context"
import { cn } from "@/lib/utils"

/** Trigger text for the current selection: the preset, or the custom span's dates. */
export function timeRangeLabel(range: TimeRangeValue, customRange: CustomTimeRange | null): string {
  return range === "custom" && customRange
    ? `${new Date(customRange.from).toLocaleDateString(undefined, { month: "short", day: "numeric" })} → ${new Date(customRange.to).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
    : TIME_RANGE_PRESETS.find((p) => p.value === range)?.label || "Range"
}

function CustomRangeFields({
  onApply,
  className = "w-64",
}: {
  onApply: (r: CustomTimeRange) => void
  className?: string
}) {
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
    <div className={cn("flex flex-col gap-2 p-2", className)}>
      <label className="text-xs text-muted-foreground">From</label>
      <Input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
      <label className="text-xs text-muted-foreground">To</label>
      <Input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
      <Button
        size="sm"
        disabled={!valid}
        onClick={() => onApply({ from: new Date(from).toISOString(), to: new Date(to).toISOString() })}
      >
        Apply
      </Button>
    </div>
  )
}

const RECENT_PRESETS = TIME_RANGE_PRESETS.filter((preset) => preset.minutes > 0)
const CALENDAR_PRESETS = TIME_RANGE_PRESETS.filter((preset) => preset.minutes < 0)

type RangeTab = "recent" | "calendar" | "custom"

function rangeTab(range: TimeRangeValue): RangeTab {
  if (range === "custom") return "custom"
  return CALENDAR_PRESETS.some((preset) => preset.value === range) ? "calendar" : "recent"
}

export function TimeRangePicker({
  trigger,
  align = "start",
  refreshControls,
}: {
  trigger: React.ReactNode
  align?: "start" | "end"
  refreshControls?: { chartBuckets: boolean }
}) {
  const { range, setRange, setCustomRange, pollInterval, setPollInterval, granularity, setGranularity } = useTimeRange()
  const isMobile = useIsMobile()
  const [rangeDrawerOpen, setRangeDrawerOpen] = useState(false)
  const [tab, setTab] = useState<RangeTab>(() => rangeTab(range))
  // See ResponsiveRadioMenu: don't reopen after a rotation to wide and back.
  useEffect(() => {
    if (!isMobile) setRangeDrawerOpen(false)
  }, [isMobile])

  if (isMobile) {
    const presetButtons = (presets: typeof TIME_RANGE_PRESETS) =>
      presets.map((preset) => (
        <Button
          key={preset.value}
          variant="outline"
          size="sm"
          onClick={() => {
            setRange(preset.value)
            setRangeDrawerOpen(false)
          }}
          className={cn("text-xs", range === preset.value && "bg-primary/20 text-primary border-primary/40")}
        >
          {preset.label}
        </Button>
      ))
    return (
      <Drawer
        open={rangeDrawerOpen}
        onOpenChange={(open) => {
          if (open) setTab(rangeTab(range))
          setRangeDrawerOpen(open)
        }}
      >
        <DrawerTrigger asChild>{trigger}</DrawerTrigger>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>{refreshControls ? "Time range and refresh" : "Time range"}</DrawerTitle>
            <DrawerDescription className="sr-only">
              {refreshControls
                ? "Choose the time range, how often the page refreshes and how charts bucket their data."
                : "Choose a preset time range or set a custom from/to range."}
            </DrawerDescription>
          </DrawerHeader>
          <div className="flex flex-col gap-5 overflow-y-auto overscroll-contain px-4 pb-6">
            <Tabs value={tab} onValueChange={(value) => setTab(value as RangeTab)}>
              <TabsList className="w-full">
                <TabsTrigger value="recent">Recent</TabsTrigger>
                <TabsTrigger value="calendar">Calendar</TabsTrigger>
                <TabsTrigger value="custom">Custom</TabsTrigger>
              </TabsList>
              <TabsContent value="recent" className="grid grid-cols-3 gap-2 pt-2">
                {presetButtons(RECENT_PRESETS)}
              </TabsContent>
              <TabsContent value="calendar" className="grid grid-cols-2 gap-2 pt-2">
                {presetButtons(CALENDAR_PRESETS)}
              </TabsContent>
              {/* Kept mounted so dates typed but not applied survive a look
                  at another tab. */}
              <TabsContent value="custom" forceMount className="pt-2 data-[state=inactive]:hidden">
                <CustomRangeFields
                  className="w-full px-0"
                  onApply={(r) => {
                    setCustomRange(r)
                    setRangeDrawerOpen(false)
                  }}
                />
              </TabsContent>
            </Tabs>
            {refreshControls && (
              <RefreshControl label="Auto refresh">
                <ToggleGroup
                  type="single"
                  variant="outline"
                  aria-label="Auto refresh"
                  value={String(pollInterval)}
                  onValueChange={(value) => value && setPollInterval(Number(value))}
                  className="w-full"
                >
                  {POLL_INTERVAL_OPTIONS.map((option) => (
                    <ToggleGroupItem key={option.value} value={String(option.value)} className="flex-1 text-xs">
                      {option.label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </RefreshControl>
            )}
            {refreshControls?.chartBuckets && (
              <RefreshControl label="Chart buckets">
                <ToggleGroup
                  type="single"
                  variant="outline"
                  aria-label="Chart buckets"
                  value={granularity}
                  onValueChange={(value) => value && setGranularity(value as ChartGranularity)}
                  className="w-full"
                >
                  {CHART_GRANULARITY_OPTIONS.map((option) => (
                    <ToggleGroupItem key={option.value} value={option.value} className="flex-1 text-xs">
                      {option.label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </RefreshControl>
            )}
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

function RefreshControl({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}
