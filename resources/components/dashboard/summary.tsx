import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Activity, Globe2, FileText, AlertTriangle } from "lucide-react"
import { useSummary } from "@/lib/queries"
import { formatNumber, formatPercent, STATS_TIME_RANGE_PRESETS, type StatsTimeRangeValue } from "@/lib/api"
import { useTimeRange } from "@/lib/time-range-context"
import { cn } from "@/lib/utils"
import { StatCard, StatCardSkeleton } from "@/components/dashboard/statcard"
import { DateTimeRange } from "@/components/dashboard/date-time-range"


export function Summary() {
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