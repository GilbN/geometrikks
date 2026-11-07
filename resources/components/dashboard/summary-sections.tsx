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

import { StatCard, StatCardSkeleton, StatGrid } from "@/components/dashboard/statcard"
import { SectionHeader } from "@/components/section-header"
import { formatNumber, formatBytes, type SummaryResponse } from "@/lib/api"
import { formatDurationOrNa, timingCoverage, TIMING_HINT } from "@/lib/timing"
import type { OverviewSparklines } from "@/lib/sparklines"

interface SectionProps {
  summary: SummaryResponse | undefined
  isLoading: boolean
  /** Span the values cover, e.g. "Last 24h" or "Last month". */
  rangeSubtitle: string
  /** Wording for a trend against the span before, e.g. "vs last 24h". */
  compareLabel: string
  sparklines: { shown: boolean; drawable: boolean; lines: OverviewSparklines | undefined; drawKey: string }
}

/** A card's chart props. The chart is empty while loading so the card keeps
 *  its height, and absent when the range is too short to draw one. */
function chartFor(sparklines: SectionProps["sparklines"], key: keyof OverviewSparklines) {
  if (!sparklines.drawable) return {}
  return {
    sparkline: sparklines.lines?.[key] ?? [],
    sparklineOpen: sparklines.shown,
    sparklineDrawKey: sparklines.drawKey,
  }
}

/** Header plus grid; skeletons while loading, nothing on error (the page
 *  shows one error card for all summary sections). */
function Section({
  title,
  gridClassName,
  skeletons,
  sparklines,
  isLoading,
  children,
}: {
  title: string
  gridClassName: string
  skeletons: number
  sparklines: boolean
  isLoading: boolean
  children: React.ReactNode | null
}) {
  if (!children && !isLoading) return null
  return (
    <>
      <SectionHeader>{title}</SectionHeader>
      <StatGrid className={gridClassName}>
        {children ??
          Array.from({ length: skeletons }, (_, i) => <StatCardSkeleton key={i} sparkline={sparklines} />)}
      </StatGrid>
    </>
  )
}

const calcPercent = (part: number, total: number) =>
  total > 0 ? ((part / total) * 100).toFixed(1) : "0"

export function TrafficOverviewSection({ summary, isLoading, rangeSubtitle, sparklines }: SectionProps) {
  const cur = summary?.currentPeriod
  const chg = summary?.percentChanges
  return (
    <Section
      title="Traffic Overview"
      gridClassName="lg:grid-cols-4"
      skeletons={4}
      sparklines={sparklines.shown}
      isLoading={isLoading}
    >
      {cur && (
        <>
          <StatCard
            title="Access Log Records"
            value={formatNumber(cur.totalRequests)}
            subtitle={rangeSubtitle}
            icon={Activity}
            {...chartFor(sparklines, "requests")}
            trend={{
              value: chg?.logRecords ?? null,
              positive: (chg?.logRecords ?? 0) >= 0,
            }}
          />
          <StatCard
            title="Geo Event Records"
            value={formatNumber(cur.totalGeoEvents)}
            subtitle={rangeSubtitle}
            icon={FileText}
            {...chartFor(sparklines, "geoEvents")}
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
            {...chartFor(sparklines, "uniqueCountries")}
          />
          <StatCard
            title="Malformed Requests"
            value={formatNumber(cur.malformedRequests)}
            subtitle={rangeSubtitle}
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

export function HttpStatusSection({ summary, isLoading, compareLabel, sparklines }: SectionProps) {
  const cur = summary?.currentPeriod
  const chg = summary?.percentChanges
  return (
    <Section
      title="HTTP Status Codes"
      gridClassName="md:grid-cols-3 lg:grid-cols-5"
      skeletons={5}
      sparklines={sparklines.shown}
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
            {...chartFor(sparklines, "successRate")}
            sparklineClassName="text-emerald-500"
          />
          <StatCard
            title="Redirects (3xx)"
            value={formatNumber(cur.status3xx)}
            subtitle={`${calcPercent(cur.status3xx, cur.totalRequests)}% of requests`}
            icon={CornerUpRight}
            iconClassName="text-blue-500/70"
            valueClassName="text-blue-500"
            {...chartFor(sparklines, "status3xx")}
            sparklineClassName="text-blue-500"
          />
          <StatCard
            title="Client Errors (4xx)"
            value={formatNumber(cur.status4xx)}
            subtitle={`${calcPercent(cur.status4xx, cur.totalRequests)}% of requests`}
            icon={AlertCircle}
            iconClassName="text-amber-500/70"
            valueClassName="text-amber-500"
            {...chartFor(sparklines, "status4xx")}
            sparklineClassName="text-amber-500"
          />
          <StatCard
            title="Server Errors (5xx)"
            value={formatNumber(cur.status5xx)}
            subtitle={`${calcPercent(cur.status5xx, cur.totalRequests)}% of requests`}
            icon={XCircle}
            iconClassName="text-red-500/70"
            valueClassName="text-red-500"
            {...chartFor(sparklines, "status5xx")}
            sparklineClassName="text-red-500"
          />
          <StatCard
            title="Unique IPs"
            value={formatNumber(cur.uniqueIps)}
            subtitle={
              chg?.uniqueIps != null ? compareLabel : "Active visitors"
            }
            icon={Users}
            {...chartFor(sparklines, "uniqueIps")}
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
  if (coverage.state === "empty") return "No requests in this range"
  if (coverage.state === "none") return TIMING_HINT
  if (coverage.state === "partial") return `From ${coverage.percent}% of requests`
  return whenFull
}

export function PerformanceSection({ summary, isLoading, compareLabel, sparklines }: SectionProps) {
  const cur = summary?.currentPeriod
  const chg = summary?.percentChanges
  const coverage = cur ? timingCoverage(cur.timedRequests, cur.totalRequests) : timingCoverage(0, 0)
  return (
    <Section
      title="Performance & Bandwidth"
      gridClassName="lg:grid-cols-4"
      skeletons={4}
      sparklines={sparklines.shown}
      isLoading={isLoading}
    >
      {cur && (
        <>
          <StatCard
            title="Avg Request Time"
            value={formatDurationOrNa(cur.avgRequestTime)}
            subtitle={timingSubtitle(coverage, chg?.avgRequestTime != null ? compareLabel : "Response time")}
            icon={Clock}
            {...chartFor(sparklines, "avgRequestTime")}
            iconClassName="text-primary/70"
            trend={
              coverage.state === "empty" || coverage.state === "none"
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
            {...chartFor(sparklines, "maxRequestTime")}
            sparklineClassName="text-amber-500"
          />
          <StatCard
            title="Total Bandwidth"
            value={formatBytes(cur.totalBytesSent)}
            subtitle={
              chg?.bytesSent != null ? compareLabel : "Data transferred"
            }
            icon={HardDrive}
            {...chartFor(sparklines, "bytesSent")}
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
            {...chartFor(sparklines, "avgRequestSize")}
          />
        </>
      )}
    </Section>
  )
}
