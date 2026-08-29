import { useRouterState } from "@tanstack/react-router"
import { RotateCw, Filter, Timer, BarChart3 } from "lucide-react"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu"

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
import { POLL_INTERVAL_OPTIONS, type ChartGranularity } from "@/lib/api"
import { cn } from "@/lib/utils"
import { useIsFetching } from "@tanstack/react-query"

const GRANULARITY_OPTIONS: { label: string; value: ChartGranularity }[] = [
  { label: "Auto", value: "auto" },
  { label: "Hourly", value: "hourly" },
  { label: "Daily", value: "daily" },
]

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
        {/* Time Range Drawer (bottom sheet on phones, see TimeRangePicker) */}
        <TimeRangePicker
          trigger={
            <Button variant="outline" size="icon-sm" className="shrink-0 pointer-coarse:size-10">
              <Filter className="h-4 w-4" />
              <span className="sr-only">Time Range</span>
            </Button>
          }
        />

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
              <Timer className="h-4 w-4" />
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
