import { TooltipProvider } from "@/components/ui/tooltip"

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
  formatBytes,
  formatDuration,
  TIME_RANGE_PRESETS,
} from "@/lib/api"
import { useTimeRange } from "@/lib/time-range-context"
import { StatCard, StatCardSkeleton } from "@/components/dashboard/statcard"
import { DateTimeRange } from "@/components/dashboard/date-time-range"
import { PageHeader } from "@/components/page-header"
import { SectionHeader } from "@/components/section-header"
import { ErrorBanner } from "@/components/error-banner"

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
        <PageHeader
          title="Summary"
          subtitle="Overview of live analytics data for your application."
          meta={
            summary && (
              <DateTimeRange start={summary.startDate} end={summary.endDate} />
            )
          }
        />

        {isError && (
          <ErrorBanner
            title={`Failed to load analytics data: ${error?.message ?? "Unknown error"}`}
            detail="Make sure the backend server is running on port 8000."
          />
        )}

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

        {!isLoading && summary && (
          <div className="space-y-6">
            {/* Section 1: Primary KPIs */}
            <SectionHeader>Traffic Overview</SectionHeader>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              <StatCard
                title="Access Log Records"
                value={formatNumber(summary.currentPeriod.totalRequests)}
                subtitle={`Last ${rangeLabel}`}
                icon={Activity}
                trend={{
                  value: summary.percentChanges?.logRecords ?? null,
                  positive: (summary.percentChanges?.logRecords ?? 0) >= 0,
                }}
              />
              <StatCard
                title="Geo Event Records"
                value={formatNumber(summary.currentPeriod.totalGeoEvents)}
                subtitle={`Last ${rangeLabel}`}
                icon={FileText}
                trend={{
                  value: summary.percentChanges?.geoRecords ?? null,
                  positive: (summary.percentChanges?.geoRecords ?? 0) >= 0,
                }}
              />
              <StatCard
                title="Unique Countries"
                value={formatNumber(summary.currentPeriod.uniqueCountries)}
                subtitle="Active locations"
                icon={Globe2}
              />
              <StatCard
                title="Malformed Requests"
                value={formatNumber(summary.currentPeriod.malformedRequests)}
                subtitle={`Last ${rangeLabel}`}
                icon={AlertTriangle}
                trend={{
                  value: summary.percentChanges?.malformedRate ?? null,
                  positive: (summary.percentChanges?.malformedRate ?? 0) < 0,
                }}
              />
            </div>

            {/* Section 2: HTTP Status Codes */}
            <SectionHeader>HTTP Status Codes</SectionHeader>
            <div className="grid gap-4 grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
              <StatCard
                title="Success (2xx)"
                value={`${calcPercent(summary.currentPeriod.status2xx, summary.currentPeriod.totalRequests)}%`}
                subtitle={`${formatNumber(summary.currentPeriod.status2xx)} requests`}
                icon={CheckCircle2}
                iconClassName="text-emerald-500/70"
                valueClassName="text-emerald-500"
              />
              <StatCard
                title="Redirects (3xx)"
                value={formatNumber(summary.currentPeriod.status3xx)}
                subtitle={`${calcPercent(summary.currentPeriod.status3xx, summary.currentPeriod.totalRequests)}% of requests`}
                icon={CornerUpRight}
                iconClassName="text-blue-500/70"
                valueClassName="text-blue-500"
              />
              <StatCard
                title="Client Errors (4xx)"
                value={formatNumber(summary.currentPeriod.status4xx)}
                subtitle={`${calcPercent(summary.currentPeriod.status4xx, summary.currentPeriod.totalRequests)}% of requests`}
                icon={AlertCircle}
                iconClassName="text-amber-500/70"
                valueClassName="text-amber-500"
              />
              <StatCard
                title="Server Errors (5xx)"
                value={formatNumber(summary.currentPeriod.status5xx)}
                subtitle={`${calcPercent(summary.currentPeriod.status5xx, summary.currentPeriod.totalRequests)}% of requests`}
                icon={XCircle}
                iconClassName="text-red-500/70"
                valueClassName="text-red-500"
              />
              <StatCard
                title="Unique IPs"
                value={formatNumber(summary.currentPeriod.uniqueIps)}
                subtitle={
                  summary.percentChanges?.uniqueIps != null
                    ? `vs last ${rangeLabel}`
                    : "Active visitors"
                }
                icon={Users}
                iconClassName="text-primary/70"
                valueClassName="text-primary"
                trend={{
                  value: summary.percentChanges?.uniqueIps ?? null,
                  positive: (summary.percentChanges?.uniqueIps ?? 0) >= 0,
                }}
              />
            </div>

            {/* Section 3: Performance & Bandwidth */}
            <SectionHeader>Performance & Bandwidth</SectionHeader>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              <StatCard
                title="Avg Request Time"
                value={formatDuration(summary.currentPeriod.avgRequestTime)}
                subtitle={
                  summary.percentChanges?.avgRequestTime != null
                    ? `vs last ${rangeLabel}`
                    : "Response time"
                }
                icon={Clock}
                iconClassName="text-primary/70"
                trend={{
                  value: summary.percentChanges?.avgRequestTime ?? null,
                  positive: (summary.percentChanges?.avgRequestTime ?? 0) <= 0,
                }}
              />
              <StatCard
                title="Max Request Time"
                value={formatDuration(summary.currentPeriod.maxRequestTime)}
                subtitle="Peak latency"
                icon={Zap}
                iconClassName="text-amber-500/70"
                valueClassName="text-amber-500"
              />
              <StatCard
                title="Total Bandwidth"
                value={formatBytes(summary.currentPeriod.totalBytesSent)}
                subtitle={
                  summary.percentChanges?.bytesSent != null
                    ? `vs last ${rangeLabel}`
                    : "Data transferred"
                }
                icon={HardDrive}
                iconClassName="text-primary/70"
                trend={{
                  value: summary.percentChanges?.bytesSent ?? null,
                  positive: (summary.percentChanges?.bytesSent ?? 0) >= 0,
                }}
              />
              <StatCard
                title="Avg Request Size"
                value={formatBytes(summary.currentPeriod.avgBytesPerRequest)}
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
