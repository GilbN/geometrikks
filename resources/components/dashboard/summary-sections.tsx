/**
 * The /summary-backed sections of the Overview page. Each one renders its
 * header plus either skeletons or cards in the same grid, so the page has
 * the same shape while loading as when loaded and nothing jumps when a
 * sibling section (Traffic Origin, which has its own query) resolves at a
 * different time.
 */
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

import { StatCard, StatCardSkeleton } from "@/components/dashboard/statcard"
import { SectionHeader } from "@/components/section-header"
import { formatNumber, formatBytes, type SummaryResponse } from "@/lib/api"
import { formatDurationOrNa, timingCoverage, TIMING_HINT } from "@/lib/timing"
import { cn } from "@/lib/utils"

interface SectionProps {
  summary: SummaryResponse | undefined
  isLoading: boolean
  /** Human label of the selected range, e.g. "24 hours". */
  rangeLabel: string
}

/** Header plus grid; skeletons while loading, nothing on error (the page
 *  shows one error card for all summary sections). */
function Section({
  title,
  gridClassName,
  skeletons,
  isLoading,
  children,
}: {
  title: string
  gridClassName: string
  skeletons: number
  isLoading: boolean
  children: React.ReactNode | null
}) {
  if (!children && !isLoading) return null
  return (
    <>
      <SectionHeader>{title}</SectionHeader>
      <div className={cn("grid gap-4", gridClassName)}>
        {children ??
          Array.from({ length: skeletons }, (_, i) => <StatCardSkeleton key={i} />)}
      </div>
    </>
  )
}

const calcPercent = (part: number, total: number) =>
  total > 0 ? ((part / total) * 100).toFixed(1) : "0"

export function TrafficOverviewSection({ summary, isLoading, rangeLabel }: SectionProps) {
  const cur = summary?.currentPeriod
  const chg = summary?.percentChanges
  return (
    <Section
      title="Traffic Overview"
      gridClassName="md:grid-cols-2 lg:grid-cols-4"
      skeletons={4}
      isLoading={isLoading}
    >
      {cur && (
        <>
          <StatCard
            title="Access Log Records"
            value={formatNumber(cur.totalRequests)}
            subtitle={`Last ${rangeLabel}`}
            icon={Activity}
            trend={{
              value: chg?.logRecords ?? null,
              positive: (chg?.logRecords ?? 0) >= 0,
            }}
          />
          <StatCard
            title="Geo Event Records"
            value={formatNumber(cur.totalGeoEvents)}
            subtitle={`Last ${rangeLabel}`}
            icon={FileText}
            trend={{
              value: chg?.geoRecords ?? null,
              positive: (chg?.geoRecords ?? 0) >= 0,
            }}
          />
          <StatCard
            title="Unique Countries"
            value={formatNumber(cur.uniqueCountries)}
            subtitle="Active locations"
            icon={Globe2}
          />
          <StatCard
            title="Malformed Requests"
            value={formatNumber(cur.malformedRequests)}
            subtitle={`Last ${rangeLabel}`}
            icon={AlertTriangle}
            trend={{
              value: chg?.malformedRate ?? null,
              positive: (chg?.malformedRate ?? 0) < 0,
            }}
          />
        </>
      )}
    </Section>
  )
}

export function HttpStatusSection({ summary, isLoading, rangeLabel }: SectionProps) {
  const cur = summary?.currentPeriod
  const chg = summary?.percentChanges
  return (
    <Section
      title="HTTP Status Codes"
      gridClassName="grid-cols-2 md:grid-cols-3 lg:grid-cols-5"
      skeletons={5}
      isLoading={isLoading}
    >
      {cur && (
        <>
          <StatCard
            title="Success (2xx)"
            value={`${calcPercent(cur.status2xx, cur.totalRequests)}%`}
            subtitle={`${formatNumber(cur.status2xx)} requests`}
            icon={CheckCircle2}
            iconClassName="text-emerald-500/70"
            valueClassName="text-emerald-500"
          />
          <StatCard
            title="Redirects (3xx)"
            value={formatNumber(cur.status3xx)}
            subtitle={`${calcPercent(cur.status3xx, cur.totalRequests)}% of requests`}
            icon={CornerUpRight}
            iconClassName="text-blue-500/70"
            valueClassName="text-blue-500"
          />
          <StatCard
            title="Client Errors (4xx)"
            value={formatNumber(cur.status4xx)}
            subtitle={`${calcPercent(cur.status4xx, cur.totalRequests)}% of requests`}
            icon={AlertCircle}
            iconClassName="text-amber-500/70"
            valueClassName="text-amber-500"
          />
          <StatCard
            title="Server Errors (5xx)"
            value={formatNumber(cur.status5xx)}
            subtitle={`${calcPercent(cur.status5xx, cur.totalRequests)}% of requests`}
            icon={XCircle}
            iconClassName="text-red-500/70"
            valueClassName="text-red-500"
          />
          <StatCard
            title="Unique IPs"
            value={formatNumber(cur.uniqueIps)}
            subtitle={
              chg?.uniqueIps != null ? `vs last ${rangeLabel}` : "Active visitors"
            }
            icon={Users}
            iconClassName="text-primary/70"
            valueClassName="text-primary"
            trend={{
              value: chg?.uniqueIps ?? null,
              positive: (chg?.uniqueIps ?? 0) >= 0,
            }}
          />
        </>
      )}
    </Section>
  )
}

function timingSubtitle(coverage: ReturnType<typeof timingCoverage>, whenFull: string): string {
  if (coverage.state === "none") return TIMING_HINT
  if (coverage.state === "partial") return `From ${coverage.percent}% of requests`
  return whenFull
}

export function PerformanceSection({ summary, isLoading, rangeLabel }: SectionProps) {
  const cur = summary?.currentPeriod
  const chg = summary?.percentChanges
  const coverage = cur ? timingCoverage(cur.timedRequests, cur.totalRequests) : timingCoverage(0, 0)
  return (
    <Section
      title="Performance & Bandwidth"
      gridClassName="md:grid-cols-2 lg:grid-cols-4"
      skeletons={4}
      isLoading={isLoading}
    >
      {cur && (
        <>
          <StatCard
            title="Avg Request Time"
            value={formatDurationOrNa(cur.avgRequestTime)}
            subtitle={timingSubtitle(coverage, chg?.avgRequestTime != null ? `vs last ${rangeLabel}` : "Response time")}
            icon={Clock}
            iconClassName="text-primary/70"
            trend={
              coverage.state === "none"
                ? undefined
                : { value: chg?.avgRequestTime ?? null, positive: (chg?.avgRequestTime ?? 0) <= 0 }
            }
          />
          <StatCard
            title="Max Request Time"
            value={formatDurationOrNa(cur.maxRequestTime)}
            subtitle={timingSubtitle(coverage, "Peak latency")}
            icon={Zap}
            iconClassName="text-amber-500/70"
            valueClassName="text-amber-500"
          />
          <StatCard
            title="Total Bandwidth"
            value={formatBytes(cur.totalBytesSent)}
            subtitle={
              chg?.bytesSent != null ? `vs last ${rangeLabel}` : "Data transferred"
            }
            icon={HardDrive}
            iconClassName="text-primary/70"
            trend={{
              value: chg?.bytesSent ?? null,
              positive: (chg?.bytesSent ?? 0) >= 0,
            }}
          />
          <StatCard
            title="Avg Request Size"
            value={formatBytes(cur.avgBytesPerRequest)}
            subtitle="Per request"
            icon={ArrowRightLeft}
          />
        </>
      )}
    </Section>
  )
}
