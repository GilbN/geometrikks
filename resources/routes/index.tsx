import { createFileRoute } from "@tanstack/react-router"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Activity, Globe2, FileText, AlertTriangle, TrendingUp, TrendingDown, Clock } from "lucide-react"
import { useSummary } from "@/lib/queries"
import { formatNumber, formatPercent, STATS_TIME_RANGE_PRESETS, type StatsTimeRangeValue } from "@/lib/api"
import { useTimeRange } from "@/lib/time-range-context"
import { cn } from "@/lib/utils"

export const Route = createFileRoute("/")({
  component: DashboardPage,
})

function StatCardSkeleton() {
  return (
    <Card className="relative overflow-hidden">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-4 rounded" />
      </CardHeader>
      <CardContent>
        <Skeleton className="h-8 w-32 mb-2" />
        <Skeleton className="h-3 w-20" />
      </CardContent>
    </Card>
  )
}

function StatCard({
  title,
  value,
  subtitle,
  icon: Icon,
  trend,
}: {
  title: string
  value: string
  subtitle: string
  icon: React.ComponentType<{ className?: string }>
  trend?: { value: number | null; positive?: boolean }
}) {
  const hasTrend = trend?.value !== null && trend?.value !== undefined
  const isPositive = trend?.positive ?? (trend?.value ?? 0) >= 0

  return (
    <Card className="relative overflow-hidden">
      {/* <div className="absolute top-0 right-0 w-24 h-24 bg-geo-cyan/5 rounded-full -translate-y-8 translate-x-8" /> */}
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {title}
        </CardTitle>
        <Icon className="h-4 w-4 text-geo-cyan" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold tracking-tight">{value}</div>
        <div className="flex items-center gap-2 mt-1">
          <span className="text-xs text-muted-foreground">{subtitle}</span>
          {hasTrend && (
            <span
              className={cn(
                "flex items-center gap-0.5 text-xs font-medium",
                isPositive ? "text-emerald-500" : "text-red-500"
              )}
            >
              {isPositive ? (
                <TrendingUp className="h-3 w-3" />
              ) : (
                <TrendingDown className="h-3 w-3" />
              )}
              {formatPercent(trend.value)}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  )
}



function DateTimeRange({ start, end }: { start: string; end: string }) {
  const startDate = new Date(start)
  const endDate = new Date(end)

  const formatOptions: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    hour12: false,
  }

  const formatTime = (d: Date) => {
    return d.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "UTC",
      hour12: false,
    })
  }

  const formatDate = (d: Date) => {
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      timeZone: "UTC",
    })
  }
  
  const fullFormat = (d: Date) => d.toUTCString();


  const sameDay =
    startDate.getUTCFullYear() === endDate.getUTCFullYear() &&
    startDate.getUTCMonth() === endDate.getUTCMonth() &&
    startDate.getUTCDate() === endDate.getUTCDate()

  return (
    <div className="inline-flex items-center gap-2 rounded-md bg-muted/50 px-2.5 py-1 text-xs font-semibold text-muted-foreground shadow-inner">
      <Clock className="h-4 w-4 text-geo-cyan" />
      <Tooltip>
        <TooltipTrigger asChild>
          <span suppressHydrationWarning className="cursor-default font-mono">
            {sameDay
              ? formatDate(startDate)
              : startDate.toLocaleString(undefined, formatOptions)}
          </span>
        </TooltipTrigger>
        <TooltipContent>
          <p>{fullFormat(startDate)}</p>
        </TooltipContent>
      </Tooltip>

      {sameDay && (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
                <span suppressHydrationWarning className="cursor-default font-mono">
                  {formatTime(startDate)}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              <p>{fullFormat(startDate)}</p>
            </TooltipContent>
          </Tooltip>
            <span className="text-muted-foreground/60">→</span>
            <Tooltip>
            <TooltipTrigger asChild>
              <span suppressHydrationWarning className="cursor-default font-mono">
                  {formatTime(endDate)}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              <p>{fullFormat(endDate)}</p>
            </TooltipContent>
          </Tooltip>
        </>
      )}

      {!sameDay && (
        <>
          <span className="text-muted-foreground/60">→</span>
          <Tooltip>
            <TooltipTrigger asChild>
                <span suppressHydrationWarning className="cursor-default font-mono">
                {endDate.toLocaleString(undefined, formatOptions)}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              <p>{fullFormat(endDate)}</p>
            </TooltipContent>
          </Tooltip>
        </>
      )}
      <span className="ml-1 text-[10px] font-bold text-muted-foreground/80">
        UTC
      </span>
    </div>
  )
}


function DashboardPage() {
  const { statsRange, setStatsRange } = useTimeRange()
  const { data: summary, isLoading, isError, error } = useSummary({
    comparePrevious: true,
  })

  // Get the label for the current stats range
  const rangeLabel = STATS_TIME_RANGE_PRESETS.find((p) => p.value === statsRange)?.label ?? statsRange

  return (
    <TooltipProvider>
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            Summary
          </h1>
          <Select
            value={statsRange}
            onValueChange={(value) => setStatsRange(value as StatsTimeRangeValue)}
          >
            <SelectTrigger size="sm" className="w-20">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATS_TIME_RANGE_PRESETS.map((preset) => (
                <Tooltip key={preset.value}>
                  <TooltipTrigger asChild>
                    <SelectItem value={preset.value}>
                      {preset.label}
                    </SelectItem>
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    <p>{preset.description}</p>
                  </TooltipContent>
                </Tooltip>
              ))}
            </SelectContent>
          </Select>
          {summary && (
            <DateTimeRange start={summary.start_date} end={summary.end_date} />
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          Hourly aggregated metrics aligned to hour boundaries. Unique IP and country counts are exact.
        </p>
      </div>

      {/* Error State */}
      {isError && (
        <Card className="border-destructive/50 bg-destructive/10">
          <CardContent className="pt-6">
            <p className="text-sm text-destructive">
              Failed to load analytics data: {error?.message ?? "Unknown error"}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Make sure the backend server is running on port 8000.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Stats Grid */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {isLoading ? (
          <>
            <StatCardSkeleton />
            <StatCardSkeleton />
            <StatCardSkeleton />
            <StatCardSkeleton />
          </>
        ) : summary ? (
          <>
            <StatCard
              title="Total Requests"
              value={formatNumber(summary.current_period.total_requests)}
              subtitle={`Last ${rangeLabel}`}
              icon={Activity}
              trend={{
                value: summary.percent_changes?.requests ?? null,
                positive: (summary.percent_changes?.requests ?? 0) >= 0,
              }}
            />
            <StatCard
              title="Unique Countries"
              value={formatNumber(summary.current_period.unique_countries)}
              subtitle="Active locations"
              icon={Globe2}
            />
            <StatCard
              title="Geo Events"
              value={formatNumber(summary.current_period.total_geo_events)}
              subtitle={`Last ${rangeLabel}`}
              icon={FileText}
              trend={{
                value: summary.percent_changes?.geo_events ?? null,
                positive: (summary.percent_changes?.geo_events ?? 0) >= 0,
              }}
            />
            <StatCard
              title="Malformed Requests"
              value={formatNumber(summary.current_period.malformed_requests)}
              subtitle="Blocked attempts"
              icon={AlertTriangle}
              trend={{
                value: summary.percent_changes?.error_rate ?? null,
                positive: (summary.percent_changes?.error_rate ?? 0) < 0, // Lower is better
              }}
            />
          </>
        ) : null}
      </div>

      {/* Secondary Stats */}
      {summary && (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Success Rate (2xx)
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-xl font-bold text-emerald-500">
                {summary.current_period.total_requests > 0
                  ? (
                      (summary.current_period.status_2xx /
                        summary.current_period.total_requests) *
                      100
                    ).toFixed(1)
                  : 0}
                %
              </div>
              <p className="text-xs text-muted-foreground">
                {formatNumber(summary.current_period.status_2xx)} requests
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Client Errors (4xx)
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-xl font-bold text-amber-500">
                {formatNumber(summary.current_period.status_4xx)}
              </div>
              <p className="text-xs text-muted-foreground">
                {summary.current_period.total_requests > 0
                  ? (
                      (summary.current_period.status_4xx /
                        summary.current_period.total_requests) *
                      100
                    ).toFixed(1)
                  : 0}
                % of requests
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Server Errors (5xx)
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-xl font-bold text-red-500">
                {formatNumber(summary.current_period.status_5xx)}
              </div>
              <p className="text-xs text-muted-foreground">
                {summary.current_period.total_requests > 0
                  ? (
                      (summary.current_period.status_5xx /
                        summary.current_period.total_requests) *
                      100
                    ).toFixed(1)
                  : 0}
                % of requests
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Unique IPs
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-xl font-bold">
                {formatNumber(summary.current_period.unique_ips)}
              </div>
              <p className="text-xs text-muted-foreground">
                {summary.percent_changes?.unique_ips !== null && (
                  <span
                    className={cn(
                      (summary.percent_changes?.unique_ips ?? 0) >= 0
                        ? "text-emerald-500"
                        : "text-red-500"
                    )}
                  >
                    {formatPercent(summary.percent_changes?.unique_ips)} vs last {rangeLabel}
                  </span>
                )}
              </p>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
    </TooltipProvider>
  )
}
