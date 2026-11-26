import { useEffect, useRef, useState } from "react"
import { useRouterState } from "@tanstack/react-router"
import { CalendarDays, ChevronDown, RotateCw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { TimeRangePicker, timeRangeLabel } from "@/components/time-range-picker"
import { timeRangeName, timeRangeSpan } from "@/lib/time-range-label"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useTimeRange } from "@/lib/time-range-context"
import { useRouteHeader } from "@/lib/route-header"
import { useTimeFormat } from "@/lib/table-view"
import { POLL_INTERVAL_OPTIONS } from "@/lib/api"
import { cn } from "@/lib/utils"
import { useIsFetching } from "@tanstack/react-query"
import { usePhoneLayout } from "@/hooks/use-phone-map"
import { useShortcutAction } from "@/components/shortcuts/keyboard-shortcuts"

export function TimeRangeToolbar() {
  const routeHeader = useRouteHeader()
  if (!routeHeader.timeRange) return null
  return (
    <>
      <div className="hidden items-center gap-2 md:flex phone:hidden">
        <RangeButton />
        <RefreshSplitButton />
      </div>
      {/* Phones: a refresh button and a range pill that opens one drawer
          for the range, auto refresh and chart buckets. */}
      <div className="md:hidden phone:flex flex items-center gap-1.5">
        <PhoneTimeRangeControls />
      </div>
    </>
  )
}

/** "Last 7 days" with the span it covers, opening the range menu. T opens it too. */
function RangeButton() {
  const { range, customRange, lastRefresh, pollInterval } = useTimeRange()
  const [timeFormat] = useTimeFormat()
  const phone = usePhoneLayout()
  const [open, setOpen] = useState(false)
  // Polling queries take a fresh "now" each time, so the span follows the clock
  // while auto refresh runs. Without it the data stays at the last refresh.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    if (pollInterval <= 0) return
    const timer = window.setInterval(() => setNow(Date.now()), Math.max(pollInterval, 30_000))
    return () => window.clearInterval(timer)
  }, [lastRefresh, pollInterval])
  // The desktop menu unmounts on a phone layout. Closing it here stops it reopening on widening.
  useEffect(() => {
    if (phone) setOpen(false)
  }, [phone])
  // T opens the menu from wherever focus is, such as a table row, and closing goes back there.
  const focusBeforeShortcut = useRef<HTMLElement | null>(null)
  useShortcutAction(
    "time-range",
    phone
      ? null
      : () => {
          const active = document.activeElement
          focusBeforeShortcut.current =
            active instanceof HTMLElement && active !== document.body ? active : null
          setOpen(true)
        },
  )
  const name = range === "custom" ? null : timeRangeName(range)
  const span = timeRangeSpan(range, customRange, now, timeFormat)
  return (
    <TimeRangePicker
      align="end"
      open={open}
      onOpenChange={setOpen}
      onCloseAutoFocus={(event) => {
        const target = focusBeforeShortcut.current
        focusBeforeShortcut.current = null
        if (!target?.isConnected) return
        event.preventDefault()
        target.focus({ preventScroll: true })
      }}
      trigger={
        <Button
          variant="outline"
          className="h-9 max-w-full gap-2 px-3 text-[13px] @max-2xl:max-w-52"
          aria-label={`Time range: ${[name, span].filter(Boolean).join(", ")}`}
        >
          <CalendarDays aria-hidden className="size-4 text-muted-foreground" />
          {name && <span className="font-semibold">{name}</span>}
          {/* A narrow bar drops the dates to keep the page name whole. A custom range is all dates. */}
          <span
            className={cn(
              "min-w-0 truncate tabular-nums",
              name && "hidden text-muted-foreground @2xl:inline",
            )}
          >
            {span}
          </span>
          <ChevronDown aria-hidden className="size-3.5 text-muted-foreground" />
        </Button>
      }
    />
  )
}

/** Refresh now, and auto refresh as a menu beside it. */
function RefreshSplitButton() {
  const { refresh, pollInterval, setPollInterval } = useTimeRange()
  const isFetching = useIsFetching()
  const interval = POLL_INTERVAL_OPTIONS.find((option) => option.value === pollInterval)
  const autoLabel = pollInterval > 0 ? `Auto ${interval?.label ?? ""}`.trim() : "Auto off"
  return (
    <ButtonGroup>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            className="size-9"
            onClick={refresh}
            disabled={isFetching > 0}
          >
            <RotateCw className={cn("size-4", isFetching > 0 && "animate-spin")} />
            <span className="sr-only">Refresh data</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>Refresh now</TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            className="h-9 gap-1.5 px-3 text-[13px]"
            aria-label={`${autoLabel}, auto refresh`}
          >
            {autoLabel}
            <ChevronDown aria-hidden className="size-3.5 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-36">
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            Auto refresh
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={String(pollInterval)}
            onValueChange={(value) => setPollInterval(Number(value))}
          >
            {POLL_INTERVAL_OPTIONS.map((option) => (
              <DropdownMenuRadioItem
                key={option.value}
                value={String(option.value)}
                className="text-[13px]"
              >
                {option.value === 0 ? "Off" : `Every ${option.label}`}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
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
        refreshControls={{
          chartBuckets: routeHeader.chartBuckets,
          cardCharts: routeHeader.cardCharts,
        }}
        trigger={
          <Button
            size="sm"
            aria-label={`Time range and refresh, ${rangeLabel}`}
            // The focus ring is the primary colour too and needs a gap to
            // show against the light theme's filled pill.
            className={cn(
              "shrink-0 gap-1 rounded-full px-3 text-xs font-semibold not-dark:hover:bg-[color-mix(in_oklab,var(--primary)_85%,var(--primary-state-mix))] not-dark:active:bg-[color-mix(in_oklab,var(--primary)_70%,var(--primary-state-mix))] focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              chip && cn(CHIP_RANGE, "min-w-0 shrink"),
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
