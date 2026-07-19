import { useState } from "react"
import { useRouterState } from "@tanstack/react-router"
import { RotateCw, Filter, SlidersHorizontal, BarChart3 } from "lucide-react"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"

import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useTimeRange } from "@/lib/time-range-context"
import { TIME_RANGE_PRESETS, POLL_INTERVAL_OPTIONS, type ChartGranularity, type CustomTimeRange } from "@/lib/api"
import { cn } from "@/lib/utils"
import { useIsFetching } from "@tanstack/react-query"

const GRANULARITY_OPTIONS: { label: string; value: ChartGranularity }[] = [
  { label: "Auto", value: "auto" },
  { label: "Hourly", value: "hourly" },
  { label: "Daily", value: "daily" },
]

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
        disabled={!valid}
        onClick={() => onApply({ from: new Date(from).toISOString(), to: new Date(to).toISOString() })}
      >
        Apply
      </Button>
    </div>
  )
}

export function TimeRangeToolbar() {
  const {
    range,
    customRange,
    pollInterval,
    granularity,
    setRange,
    setCustomRange,
    setPollInterval,
    setGranularity,
    refresh,
  } = useTimeRange()
  const isFetching = useIsFetching()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  // The map page has no time-series charts, so granularity is irrelevant there.
  const showGranularity = pathname !== "/map"
  const [rangeDrawerOpen, setRangeDrawerOpen] = useState(false)

  const rangeLabel =
    range === "custom" && customRange
      ? `${new Date(customRange.from).toLocaleDateString(undefined, { month: "short", day: "numeric" })} → ${new Date(customRange.to).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
      : TIME_RANGE_PRESETS.find((p) => p.value === range)?.label || "Range"

  return (
    <>
      {/* Desktop Layout */}
      <div className="hidden md:flex items-center gap-2">
        {/* Time Range Dropdown Menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="flex items-center gap-2">
              <Filter className="w-4 h-4" />
              <span className="text-xs">{rangeLabel}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-auto!">
            {TIME_RANGE_PRESETS.map((preset) => (
              <DropdownMenuItem
                key={preset.value}
                onClick={() => setRange(preset.value)}
                className={cn(
                  "text-xs",
                  range === preset.value && "bg-geo-cyan/20 text-geo-cyan"
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

        <Separator orientation="vertical" className="h-6" />

        {/* Refresh Button */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon-sm"
              onClick={refresh}
              disabled={isFetching > 0}
              className="shrink-0"
            >
              <RotateCw
                className={cn(
                  "h-3.5 w-3.5",
                  isFetching > 0 && "animate-spin"
                )}
              />
              <span className="sr-only">Refresh data</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Refresh now</TooltipContent>
        </Tooltip>

        {/* Poll Interval Select */}
        <Select
          value={String(pollInterval)}
          onValueChange={(value) => setPollInterval(Number(value))}
        >
          <SelectTrigger size="sm" className="w-[80px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {POLL_INTERVAL_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={String(option.value)}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Chart Granularity Select */}
        {showGranularity && (
          <Select
            value={granularity}
            onValueChange={(value) => setGranularity(value as ChartGranularity)}
          >
            <SelectTrigger size="sm" className="w-[90px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GRANULARITY_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Mobile Layout - icon buttons + time-range drawer */}
      <div className="md:hidden flex items-center gap-1">
        {/* Time Range Drawer - a bottom sheet with a preset grid, replacing the
            cramped tall dropdown that overflowed the viewport. */}
        <Drawer open={rangeDrawerOpen} onOpenChange={setRangeDrawerOpen}>
          <DrawerTrigger asChild>
            <Button variant="outline" size="icon-sm" className="shrink-0 pointer-coarse:size-10">
              <Filter className="h-4 w-4" />
              <span className="sr-only">Time Range</span>
            </Button>
          </DrawerTrigger>
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
                        "bg-geo-cyan/20 text-geo-cyan border-geo-cyan/40"
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

        {/* Refresh Button */}
        <Button
          variant="outline"
          size="icon-sm"
          onClick={refresh}
          disabled={isFetching > 0}
          className="shrink-0 pointer-coarse:size-10"
        >
          <RotateCw
            className={cn(
              "h-4 w-4",
              isFetching > 0 && "animate-spin"
            )}
          />
          <span className="sr-only">Refresh data</span>
        </Button>

        {/* Poll Interval Dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon-sm" className="shrink-0 pointer-coarse:size-10">
              <SlidersHorizontal className="h-4 w-4" />
              <span className="sr-only">Auto Refresh</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Auto Refresh</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={String(pollInterval)}
              onValueChange={(value) => setPollInterval(Number(value))}
            >
              {POLL_INTERVAL_OPTIONS.map((option) => (
                <DropdownMenuRadioItem
                  key={option.value}
                  value={String(option.value)}
                  className="text-xs"
                >
                  {option.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Chart Granularity Dropdown */}
        {showGranularity && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon-sm" className="shrink-0 pointer-coarse:size-10">
                <BarChart3 className="h-4 w-4" />
                <span className="sr-only">Chart Granularity</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Chart Granularity</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={granularity}
                onValueChange={(value) => setGranularity(value as ChartGranularity)}
              >
                {GRANULARITY_OPTIONS.map((option) => (
                  <DropdownMenuRadioItem
                    key={option.value}
                    value={option.value}
                    className="text-xs"
                  >
                    {option.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </>
  )
}
