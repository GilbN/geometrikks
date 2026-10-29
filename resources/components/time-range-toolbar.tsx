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
      <div className="hidden md:flex items-center gap-2">
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
        <div className="md:hidden flex items-center gap-1.5">
          <RefreshButton />
          <TimeRangePicker
            refreshControls={{ chartBuckets: routeHeader.chartBuckets }}
            trigger={
              <Button
                size="sm"
                aria-label={`Time range and refresh, ${rangeLabel}`}
                // Hover and press mix in the page text colour, which sits on
                // the far side of the primary from its label in every theme,
                // so the label's contrast grows instead of fading. Night's
                // primary is its text colour, so the press also shrinks the
                // pill. The focus ring is the primary colour too and needs a
                // gap to show.
                className="shrink-0 gap-1 rounded-full px-3 text-xs font-semibold dark:border-transparent dark:bg-primary dark:text-primary-foreground hover:bg-[color-mix(in_oklab,var(--primary)_85%,var(--foreground))] dark:hover:bg-[color-mix(in_oklab,var(--primary)_85%,var(--foreground))] active:bg-[color-mix(in_oklab,var(--primary)_70%,var(--foreground))] dark:active:bg-[color-mix(in_oklab,var(--primary)_70%,var(--foreground))] active:scale-95 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                <span className="max-w-28 truncate tabular-nums">{rangeLabel}</span>
                <ChevronDown aria-hidden className="size-3.5" />
              </Button>
            }
          />
        </div>
      )}
    </>
  )
}

/** Refresh now. While auto refresh is on, a ring around the button fills
 *  once per interval. It runs on its own clock, so it shows the cadence
 *  rather than the exact moment each query refetches. */
function RefreshButton() {
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
      className="relative shrink-0 rounded-full"
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
