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
import { SectionHeader } from "@/components/dashboard/section-header"
import {
  formatNumber,
  formatPercent,
  formatBytes,
  formatDuration,
  type SummaryResponse,
} from "@/lib/api"
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

/** "+12.3% vs last 24 hours" colored by direction; `goodWhenUp` flips the
 *  palette for metrics where growth is bad (latency). */
function ChangeSubtitle({
  change,
  rangeLabel,
  fallback,
  goodWhenUp = true,
}: {
  change: number | null | undefined
  rangeLabel: string
  fallback: string
  goodWhenUp?: boolean
}) {
  if (change === null || change === undefined) return <>{fallback}</>
  const good = goodWhenUp ? change >= 0 : change <= 0
  return (
    <span className={cn(good ? "text-emerald-500" : "text-red-500")}>
      {formatPercent(change)} vs last {rangeLabel}
    </span>
  )
}

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
              <ChangeSubtitle
                change={chg?.uniqueIps}
                rangeLabel={rangeLabel}
                fallback="Active visitors"
              />
            }
            icon={Users}
            iconClassName="text-geo-cyan/70"
            valueClassName="text-geo-cyan"
          />
        </>
      )}
    </Section>
  )
}

export function PerformanceSection({ summary, isLoading, rangeLabel }: SectionProps) {
  const cur = summary?.currentPeriod
  const chg = summary?.percentChanges
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
            value={formatDuration(cur.avgRequestTime)}
            subtitle={
              <ChangeSubtitle
                change={chg?.avgRequestTime}
                rangeLabel={rangeLabel}
                fallback="Response time"
                goodWhenUp={false}
              />
            }
            icon={Clock}
            iconClassName="text-geo-cyan/70"
          />
          <StatCard
            title="Max Request Time"
            value={formatDuration(cur.maxRequestTime)}
            subtitle="Peak latency"
            icon={Zap}
            iconClassName="text-amber-500/70"
            valueClassName="text-amber-500"
          />
          <StatCard
            title="Total Bandwidth"
            value={formatBytes(cur.totalBytesSent)}
            subtitle={
              <ChangeSubtitle
                change={chg?.bytesSent}
                rangeLabel={rangeLabel}
                fallback="Data transferred"
              />
            }
            icon={HardDrive}
            iconClassName="text-geo-cyan/70"
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
