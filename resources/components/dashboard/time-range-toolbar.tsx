"use client"

import { RotateCw, Filter } from "lucide-react"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

import { Button } from "@/components/ui/button"
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
import { TIME_RANGE_PRESETS, POLL_INTERVAL_OPTIONS } from "@/lib/api"
import { cn } from "@/lib/utils"
import { useIsFetching } from "@tanstack/react-query"

export function TimeRangeToolbar() {
  const { range, pollInterval, setRange, setPollInterval, refresh } = useTimeRange()
  const isFetching = useIsFetching()

  return (
    <div className="flex items-center gap-2">
      {/* Time Range Dropdown Menu */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="flex items-center gap-2">
            <Filter className="w-4 h-4" />
            <span className="text-xs">
              {TIME_RANGE_PRESETS.find((p) => p.value === range)?.label || "Range"}
            </span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
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
    </div>
  )
}
