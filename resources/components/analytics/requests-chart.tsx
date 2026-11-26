/**
 * Requests over the range, stacked by status class. Views: stacked bars
 * (default), stacked area, share of responses and error rate.
 */
import { useMemo, useState } from "react"
import { Area, Bar, Line } from "recharts"
import { SignalPanel } from "@/components/data/signal-panel"
import { dataState } from "@/components/data/types"
import type { TimeSeriesDataPoint } from "@/generated/api/types.gen"
import type { ChartConfig } from "@/components/ui/chart"
import { formatNumber } from "@/lib/api"
import { useChartOptions } from "@/lib/chart-options"
import { scaleSeries } from "@/lib/chart-scale"
import { formatTs } from "@/lib/datetime"
import { useTimeSeries } from "@/lib/queries"
import { GranularityBadge } from "@/components/chart-buckets-menu"
import { ChartOptionsMenu, ScaleNotes } from "./chart-options-menu"
import { ChartReadout, CursorStamp, useCursorRow, type ReadoutItem } from "./chart-readout"
import { createChartCursor, type ChartCursor } from "./chart-cursor"
import {
  barSpacer,
  formatLogCount,
  formatRate,
  REQUESTS_OPTIONS,
  statusChartConfig,
  statusErrorRateChartConfig,
} from "./chart-utils"
import {
  errorRateSeries,
  otherChartConfig,
  SHARE_TICKS,
  shareRows,
  STATUS_KEYS,
  statusTotal,
  withOther,
  type CountRow,
} from "./status-series"
import { useTrafficBuckets } from "./use-traffic-buckets"
import { isolatedDot, TimeChart, type CursorMarks } from "./time-chart"
import { chartRangeText, trafficTotals } from "./traffic-series"

const TITLE = "Requests"
const COUNT_CONFIG = { ...statusChartConfig, ...otherChartConfig }
const COUNT_KEYS = [...STATUS_KEYS, "statusOther"] as const

function RequestsReadout({
  cursor,
  buckets,
  view,
  granularity,
  ready,
  hasOther,
}: {
  cursor: ChartCursor
  buckets: readonly CountRow[]
  view: string
  granularity?: string
  /** Before the data arrives the legend shows its labels alone. */
  ready: boolean
  /** Adds the requests outside 2xx to 5xx to the count views' legend. */
  hasOther: boolean
}) {
  const totals = useMemo(() => {
    const sums = trafficTotals(buckets)
    return { ...sums, statusOther: Math.max(0, sums.totalRequests - statusTotal(sums)) }
  }, [buckets])
  const row = useCursorRow(cursor, buckets)
  const source = row ?? totals
  const requests = source.totalRequests
  const classes = statusTotal(source)
  const lead = ready ? (
    <>
      <b className="font-semibold text-foreground">{formatNumber(requests)}</b> requests
    </>
  ) : undefined
  const items: ReadoutItem[] =
    view === "error-rate"
      ? [
          {
            key: "errorRate",
            label: String(statusErrorRateChartConfig.errorRate.label),
            short: "Error rate",
            color: statusErrorRateChartConfig.errorRate.color,
            value: !ready
              ? null
              : requests > 0
                ? formatRate((source.status4xx + source.status5xx) / requests)
                : "n/a",
          },
        ]
      : (view !== "share" && hasOther ? COUNT_KEYS : STATUS_KEYS).map((key) => ({
          key,
          label: String(COUNT_CONFIG[key].label),
          short: key === "statusOther" ? "Other" : String(COUNT_CONFIG[key].label).slice(0, 3),
          color: COUNT_CONFIG[key].color,
          value: !ready
            ? null
            : view === "share"
              ? classes > 0
                ? formatRate(source[key] / classes)
                : "n/a"
              : formatNumber(source[key]),
        }))
  const stamp = row ? formatTs(row.timestamp, granularity) : null
  return <ChartReadout lead={lead} items={items} stamp={stamp} />
}

export function RequestsChart({ className }: { className?: string }) {
  const { data, error, isLoading, isError, refetch } = useTimeSeries()
  // The Status classes chart's key: its view ids carry over, the old Requests chart's do not.
  const options = useChartOptions("status", REQUESTS_OPTIONS)
  const [cursor] = useState(createChartCursor)
  const buckets = useTrafficBuckets(data)
  const view = options.view.id
  const lines = (view === "stacked" || view === "area") && options.scale === "log"
  const counted = useMemo(() => withOther(buckets), [buckets])
  const hasOther = counted.some((row) => row.statusOther > 0)
  const countKeys = hasOther ? COUNT_KEYS : STATUS_KEYS
  const stacked = useMemo(
    () =>
      scaleSeries(counted, countKeys, options.scale, {
        integer: true,
        clipValues: counted.map((row) => row.totalRequests),
      }),
    [counted, countKeys, options.scale],
  )
  const share = useMemo(() => shareRows(buckets), [buckets])
  const rate = useMemo(() => errorRateSeries(buckets, options.scale), [buckets, options.scale])
  const state = dataState(isLoading, isError, buckets.length)

  const config: ChartConfig =
    view === "error-rate"
      ? statusErrorRateChartConfig
      : view === "share" || !hasOther
        ? statusChartConfig
        : COUNT_CONFIG
  const rows = view === "share" ? share : view === "error-rate" ? rate.rows : stacked.rows
  const clipMax = view === "share" ? null : view === "error-rate" ? rate.clipMax : stacked.clipMax
  const clipLabel =
    clipMax == null ? null : view === "error-rate" ? formatRate(clipMax) : formatNumber(clipMax)
  const yAxis =
    view === "share"
      ? { domain: [0, 1] as [number, number], ticks: SHARE_TICKS, tickFormatter: formatRate }
      : view === "error-rate"
        ? { ...rate.axis, tickFormatter: formatRate }
        : {
            ...stacked.axis,
            tickFormatter:
              options.scale === "log" ? formatLogCount : (v: number) => formatNumber(v),
          }

  const rates = rate.rows.map((row) => row.errorRate)
  const marks: CursorMarks =
    view === "error-rate"
      ? { kind: "line", dots: [{ key: "errorRate", color: "var(--color-errorRate)" }] }
      : lines
        ? { kind: "line", dots: countKeys.map((key) => ({ key, color: `var(--color-${key})` })) }
        : view === "area"
          ? { kind: "line", dots: [] }
          : view === "share"
            ? {
                kind: "bar",
                top: (row) => (statusTotal(row as TimeSeriesDataPoint) > 0 ? 1 : null),
              }
            : { kind: "bar", top: (row) => (row as TimeSeriesDataPoint).totalRequests }

  const series =
    view === "error-rate" ? (
      <Line
        activeDot={false}
        dataKey="errorRate"
        type="linear"
        stroke="var(--color-errorRate)"
        strokeWidth={2}
        dot={isolatedDot(rates, "var(--color-errorRate)")}
        connectNulls={false}
      />
    ) : lines ? (
      countKeys.map((key) => (
        <Line
          activeDot={false}
          key={key}
          dataKey={key}
          type="linear"
          stroke={`var(--color-${key})`}
          strokeWidth={2}
          dot={false}
          connectNulls={false}
        />
      ))
    ) : view === "area" ? (
      countKeys.map((key) => (
        <Area
          activeDot={false}
          key={key}
          dataKey={key}
          stackId="s"
          type="linear"
          fill={`var(--color-${key})`}
          fillOpacity={0.45}
          stroke={`var(--color-${key})`}
          strokeWidth={1.5}
          connectNulls={false}
        />
      ))
    ) : (
      (view === "share" ? STATUS_KEYS : countKeys).map((key, i, keys) => (
        // stroke = card surface: the spacer between stacked segments, dropped when dense
        <Bar
          key={key}
          dataKey={key}
          stackId="s"
          fill={`var(--color-${key})`}
          {...barSpacer(buckets.length)}
          radius={i === keys.length - 1 ? [2, 2, 0, 0] : undefined}
        />
      ))
    )

  return (
    <SignalPanel
      title={TITLE}
      className={className}
      state={state}
      error={error?.message ?? "Failed to load request volume."}
      onRetry={() => void refetch()}
      bodyClassName="min-h-[232px] max-md:min-h-[170px]"
      actions={
        <>
          <ScaleNotes
            clip={clipLabel}
            zerosRaised={view === "share" || view === "error-rate" ? 0 : stacked.zerosRaised}
          />
          <CursorStamp cursor={cursor} rows={buckets} granularity={data?.granularity} />
          <GranularityBadge granularity={data?.granularity} />
          <ChartOptionsMenu title={TITLE} spec={REQUESTS_OPTIONS} options={options} />
        </>
      }
      readout={
        <RequestsReadout
          cursor={cursor}
          buckets={counted}
          hasOther={hasOther}
          view={view}
          granularity={data?.granularity}
          ready={state === "ready"}
        />
      }
    >
      {data && (
        <>
          <p className="sr-only">
            {`${options.view.label} of requests by status class, ${chartRangeText(buckets, data.granularity)}.`}
          </p>
          <TimeChart
            config={config}
            rows={rows}
            granularity={data.granularity}
            cursor={cursor}
            marks={marks}
            yAxis={{ width: 48, ...yAxis }}
            stackOffset={view === "share" ? "expand" : undefined}
            className="h-[232px] max-md:h-[170px]"
          >
            {series}
          </TimeChart>
        </>
      )}
    </SignalPanel>
  )
}
