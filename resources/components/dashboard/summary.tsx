import { TooltipProvider } from "@/components/ui/tooltip"
import { Card, CardContent } from "@/components/ui/card"

import {
  Activity,
  Globe2,
  FileText,
  AlertTriangle,
  Clock,
  Zap,
  HardDrive,
  ArrowRightLeft,
  Users,
  CheckCircle2,
  XCircle,
  AlertCircle,
  CornerUpRight,
} from "lucide-react"
import { useSummary } from "@/lib/queries"
import {
  formatNumber,
  formatPercent,
  formatBytes,
  formatDuration,
  TIME_RANGE_PRESETS,
} from "@/lib/api"
import { useTimeRange } from "@/lib/time-range-context"
import { cn } from "@/lib/utils"
import { StatCard, StatCardSkeleton } from "@/components/dashboard/statcard"
import { DateTimeRange } from "@/components/dashboard/date-time-range"

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {children}
      </h2>
      <div className="flex-1 h-px bg-border/50" />
    </div>
  )
}

export function Summary() {
  const { range } = useTimeRange()
  const { data: summary, isLoading, isError, error } = useSummary({
    comparePrevious: true,
  })

  // Get the label for the current stats range
  const rangeLabel =
    TIME_RANGE_PRESETS.find((p) => p.value === range)?.label ?? range

  // Calculate percentages helper
  const calcPercent = (part: number, total: number) =>
    total > 0 ? ((part / total) * 100).toFixed(1) : "0"

  return (
    <TooltipProvider>
      <div className="p-4 md:p-6 space-y-6">
        {/* Header */}
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">Summary</h1>

            {summary && (
              <DateTimeRange start={summary.start_date} end={summary.end_date} />
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            Overview of live analytics data for your application.
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

        {/* Loading State */}
        {isLoading && (
          <div className="space-y-6">
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              <StatCardSkeleton />
              <StatCardSkeleton />
              <StatCardSkeleton />
              <StatCardSkeleton />
            </div>
            <div className="grid gap-4 md:grid-cols-3 lg:grid-cols-5">
              <StatCardSkeleton />
              <StatCardSkeleton />
              <StatCardSkeleton />
              <StatCardSkeleton />
              <StatCardSkeleton />
            </div>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              <StatCardSkeleton />
              <StatCardSkeleton />
              <StatCardSkeleton />
              <StatCardSkeleton />
            </div>
          </div>
        )}

        {/* Data Display */}
        {!isLoading && summary && (
          <div className="space-y-6">
            {/* Section 1: Primary KPIs */}
            <SectionHeader>Traffic Overview</SectionHeader>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              <StatCard
                title="Access Log Records"
                value={formatNumber(summary.current_period.total_requests)}
                subtitle={`Last ${rangeLabel}`}
                icon={Activity}
                trend={{
                  value: summary.percent_changes?.log_records ?? null,
                  positive: (summary.percent_changes?.log_records ?? 0) >= 0,
                }}
              />
              <StatCard
                title="Geo Event Records"
                value={formatNumber(summary.current_period.total_geo_events)}
                subtitle={`Last ${rangeLabel}`}
                icon={FileText}
                trend={{
                  value: summary.percent_changes?.geo_records ?? null,
                  positive: (summary.percent_changes?.geo_records ?? 0) >= 0,
                }}
              />
              <StatCard
                title="Unique Countries"
                value={formatNumber(summary.current_period.unique_countries)}
                subtitle="Active locations"
                icon={Globe2}
              />
              <StatCard
                title="Malformed Requests"
                value={formatNumber(summary.current_period.malformed_requests)}
                subtitle={`Last ${rangeLabel}`}
                icon={AlertTriangle}
                trend={{
                  value: summary.percent_changes?.malformed_rate ?? null,
                  positive: (summary.percent_changes?.malformed_rate ?? 0) < 0,
                }}
              />
            </div>

            {/* Section 2: HTTP Status Codes */}
            <SectionHeader>HTTP Status Codes</SectionHeader>
            <div className="grid gap-4 grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
              <StatCard
                title="Success (2xx)"
                value={`${calcPercent(summary.current_period.status_2xx, summary.current_period.total_requests)}%`}
                subtitle={`${formatNumber(summary.current_period.status_2xx)} requests`}
                icon={CheckCircle2}
                iconClassName="text-emerald-500/70"
                valueClassName="text-emerald-500"
              />
              <StatCard
                title="Redirects (3xx)"
                value={formatNumber(summary.current_period.status_3xx)}
                subtitle={`${calcPercent(summary.current_period.status_3xx, summary.current_period.total_requests)}% of requests`}
                icon={CornerUpRight}
                iconClassName="text-blue-500/70"
                valueClassName="text-blue-500"
              />
              <StatCard
                title="Client Errors (4xx)"
                value={formatNumber(summary.current_period.status_4xx)}
                subtitle={`${calcPercent(summary.current_period.status_4xx, summary.current_period.total_requests)}% of requests`}
                icon={AlertCircle}
                iconClassName="text-amber-500/70"
                valueClassName="text-amber-500"
              />
              <StatCard
                title="Server Errors (5xx)"
                value={formatNumber(summary.current_period.status_5xx)}
                subtitle={`${calcPercent(summary.current_period.status_5xx, summary.current_period.total_requests)}% of requests`}
                icon={XCircle}
                iconClassName="text-red-500/70"
                valueClassName="text-red-500"
              />
              <StatCard
                title="Unique IPs"
                value={formatNumber(summary.current_period.unique_ips)}
                subtitle={
                  summary.percent_changes?.unique_ips !== null ? (
                    <span
                      className={cn(
                        (summary.percent_changes?.unique_ips ?? 0) >= 0
                          ? "text-emerald-500"
                          : "text-red-500"
                      )}
                    >
                      {formatPercent(summary.percent_changes?.unique_ips)} vs last {rangeLabel}
                    </span>
                  ) : (
                    "Active visitors"
                  )
                }
                icon={Users}
                iconClassName="text-geo-cyan/70"
                valueClassName="text-geo-cyan"
              />
            </div>

            {/* Section 3: Performance & Bandwidth */}
            <SectionHeader>Performance & Bandwidth</SectionHeader>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              <StatCard
                title="Avg Request Time"
                value={formatDuration(summary.current_period.avg_request_time)}
                subtitle={
                  summary.percent_changes?.avg_request_time !== null ? (
                    <span
                      className={cn(
                        (summary.percent_changes?.avg_request_time ?? 0) <= 0
                          ? "text-emerald-500"
                          : "text-red-500"
                      )}
                    >
                      {formatPercent(summary.percent_changes?.avg_request_time)} vs last {rangeLabel}
                    </span>
                  ) : (
                    "Response time"
                  )
                }
                icon={Clock}
                iconClassName="text-geo-cyan/70"
              />
              <StatCard
                title="Max Request Time"
                value={formatDuration(summary.current_period.max_request_time)}
                subtitle="Peak latency"
                icon={Zap}
                iconClassName="text-amber-500/70"
                valueClassName="text-amber-500"
              />
              <StatCard
                title="Total Bandwidth"
                value={formatBytes(summary.current_period.total_bytes_sent)}
                subtitle={
                  summary.percent_changes?.bytes_sent !== null ? (
                    <span
                      className={cn(
                        (summary.percent_changes?.bytes_sent ?? 0) >= 0
                          ? "text-emerald-500"
                          : "text-red-500"
                      )}
                    >
                      {formatPercent(summary.percent_changes?.bytes_sent)} vs last {rangeLabel}
                    </span>
                  ) : (
                    "Data transferred"
                  )
                }
                icon={HardDrive}
                iconClassName="text-geo-cyan/70"
              />
              <StatCard
                title="Avg Request Size"
                value={formatBytes(summary.current_period.avg_bytes_per_request)}
                subtitle="Per request"
                icon={ArrowRightLeft}
              />
            </div>
          </div>
        )}
      </div>
    </TooltipProvider>
  )
}
