import { useRouterState } from "@tanstack/react-router"
import { ChevronDown, RotateCw, Filter } from "lucide-react"

import { Button } from "@/components/ui/button"
import { TimeRangePicker, timeRangeLabel } from "@/components/time-range-picker"
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
import { useRouteHeader } from "@/lib/route-header"
import { CHART_GRANULARITY_OPTIONS, POLL_INTERVAL_OPTIONS, type ChartGranularity } from "@/lib/api"
import { cn } from "@/lib/utils"
import { useIsFetching } from "@tanstack/react-query"

export function TimeRangeToolbar() {
  const {
    range,
    customRange,
    pollInterval,
    granularity,
    setPollInterval,
    setGranularity,
    refresh,
  } = useTimeRange()
  const isFetching = useIsFetching()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const routeHeader = useRouteHeader()
  // The map page has no time-series charts, so granularity is irrelevant there.
  const showGranularity = pathname !== "/map"
  const rangeLabel = timeRangeLabel(range, customRange)

  return (
    <>
      {/* Desktop Layout */}
      <div className="hidden md:flex phone:hidden items-center gap-2">
        {/* Time Range Dropdown Menu */}
        <TimeRangePicker
          trigger={
            <Button variant="outline" size="sm" className="flex items-center gap-2">
              <Filter className="w-4 h-4" />
              <span className="text-xs">{rangeLabel}</span>
            </Button>
          }
        />

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
              {CHART_GRANULARITY_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Phones: a refresh button and a range pill that opens one drawer
          for the range, auto refresh and chart buckets. Pages that don't
          follow the range show neither. */}
      {routeHeader.timeRange && (
        <div className="md:hidden phone:flex flex items-center gap-1.5">
          <PhoneTimeRangeControls />
        </div>
      )}
    </>
  )
}

const CHIP_REFRESH = "size-9 pointer-coarse:min-h-9 pointer-coarse:min-w-9"
const CHIP_RANGE =
  "h-9 pointer-coarse:min-h-9 bg-primary/14 text-primary dark:border-transparent dark:bg-primary/14 hover:bg-primary/22 dark:hover:bg-primary/22 not-dark:hover:bg-primary/22 active:bg-primary/28 not-dark:active:bg-primary/28"

/** The phone's refresh button and range pill, in the header or, on the map, in
 *  the floating range chip, where both are 36px and the pill is tinted. */
export function PhoneTimeRangeControls({ chip = false }: { chip?: boolean }) {
  const { range, customRange } = useTimeRange()
  const routeHeader = useRouteHeader()
  const rangeLabel = timeRangeLabel(range, customRange)

  return (
    <>
      <RefreshButton className={chip ? CHIP_REFRESH : undefined} />
      <TimeRangePicker
        refreshControls={{ chartBuckets: routeHeader.chartBuckets, overviewCharts: routeHeader.overviewCharts }}
        trigger={
          <Button
            size="sm"
            aria-label={`Time range and refresh, ${rangeLabel}`}
            // The focus ring is the primary colour too and needs a gap to
            // show against the light theme's filled pill.
            className={cn(
              "shrink-0 gap-1 rounded-full px-3 text-xs font-semibold not-dark:hover:bg-[color-mix(in_oklab,var(--primary)_85%,var(--primary-state-mix))] not-dark:active:bg-[color-mix(in_oklab,var(--primary)_70%,var(--primary-state-mix))] focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              chip && CHIP_RANGE,
            )}
          >
            <span className="max-w-28 truncate tabular-nums">{rangeLabel}</span>
            <ChevronDown aria-hidden className="size-3.5" />
          </Button>
        }
      />
    </>
  )
}

/** Refresh now. While auto refresh is on, a ring around the button fills
 *  once per interval. It runs on its own clock, so it shows the cadence
 *  rather than the exact moment each query refetches. */
function RefreshButton({ className }: { className?: string }) {
  const { refresh, pollInterval, lastRefresh } = useTimeRange()
  const isFetching = useIsFetching()
  // A new page's queries start their poll timers when they mount.
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  return (
    <Button
      variant="outline"
      size="icon-sm"
      onClick={refresh}
      disabled={isFetching > 0}
      className={cn("relative shrink-0 rounded-full", className)}
    >
      {pollInterval > 0 && (
        <svg
          key={`${pollInterval}-${lastRefresh}-${pathname}`}
          aria-hidden
          viewBox="0 0 36 36"
          className="pointer-events-none absolute inset-0 size-full -rotate-90 motion-reduce:hidden"
        >
          <circle
            cx="18"
            cy="18"
            r="16.5"
            pathLength={100}
            fill="none"
            strokeWidth="2"
            className="refresh-ring stroke-primary"
            style={{ animationDuration: `${pollInterval}ms` }}
          />
        </svg>
      )}
      <RotateCw className={cn("h-4 w-4", isFetching > 0 && "animate-spin")} />
      <span className="sr-only">Refresh data</span>
    </Button>
  )
}
