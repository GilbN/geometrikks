import { useMemo } from "react"
import { Area, Line } from "recharts"
import { SignalPanel } from "@/components/data/signal-panel"
import { dataState } from "@/components/data/types"
import type { TimeSeriesDataPoint } from "@/generated/api/types.gen"
import { useChartOptions } from "@/lib/chart-options"
import { scaleSeries } from "@/lib/chart-scale"
import { formatTs } from "@/lib/datetime"
import { useTimeSeries } from "@/lib/queries"
import { formatDurationOrNa, TIMING_HINT } from "@/lib/timing"
import { GranularityBadge } from "@/components/chart-buckets-menu"
import { ChartOptionsMenu, ScaleNotes } from "./chart-options-menu"
import {
  ChartReadout,
  CursorStamp,
  spokenReadout,
  useCursorRow,
  type ReadoutItem,
} from "./chart-readout"
import { useChartCursor, type ChartCursor } from "./chart-cursor"
import { LATENCY_OPTIONS, latencyBandChartConfig, latencyChartConfig } from "./chart-utils"
import { bandRows, LATENCY_KEYS } from "./latency-series"
import { useTrafficBuckets } from "./use-traffic-buckets"
import { isolatedDot, TimeChart } from "./time-chart"
import { chartRangeText } from "./traffic-series"

const TITLE = "Request latency"

/**
 * The legend entries for one bucket, or labels alone with no bucket: a range
 * has no single percentile to show.
 */
function latencyItems(row: TimeSeriesDataPoint | null, band: boolean): ReadoutItem[] {
  const time = (value: number | null | undefined) =>
    row ? formatDurationOrNa(value ?? null) : null
  return band
    ? [
        {
          key: "band",
          label: String(latencyBandChartConfig.band.label),
          color: latencyBandChartConfig.band.color,
          value:
            row && (row.p50RequestTime != null || row.p95RequestTime != null)
              ? `${formatDurationOrNa(row.p50RequestTime)} to ${formatDurationOrNa(row.p95RequestTime)}`
              : time(null),
        },
        {
          key: "p99RequestTime",
          label: String(latencyChartConfig.p99RequestTime.label),
          color: latencyChartConfig.p99RequestTime.color,
          value: time(row?.p99RequestTime),
        },
        {
          key: "avgRequestTime",
          label: String(latencyChartConfig.avgRequestTime.label),
          color: latencyChartConfig.avgRequestTime.color,
          value: time(row?.avgRequestTime),
        },
      ]
    : LATENCY_KEYS.map((key) => ({
        key,
        label: String(latencyChartConfig[key].label),
        color: latencyChartConfig[key].color,
        value: time(row?.[key]),
      }))
}

function LatencyReadout({
  cursor,
  buckets,
  band,
  granularity,
}: {
  cursor: ChartCursor
  buckets: readonly TimeSeriesDataPoint[]
  band: boolean
  granularity?: string
}) {
  const row = useCursorRow(cursor, buckets)
  const items = latencyItems(row, band)
  return <ChartReadout items={items} stamp={row ? formatTs(row.timestamp, granularity) : null} />
}

export function LatencyChart() {
  const { data, error, isLoading, isError, refetch } = useTimeSeries()
  const options = useChartOptions("latency", LATENCY_OPTIONS)
  const cursor = useChartCursor()
  const buckets = useTrafficBuckets(data)
  const bucketsByTime = useMemo(
    () => new Map(buckets.map((row) => [Date.parse(row.timestamp), row])),
    [buckets],
  )
  const hasTimings = buckets.some((d) => d.timedRequests > 0)
  const noTimings = buckets.length > 0 && !hasTimings
  const series = useMemo(() => {
    const scaled = scaleSeries(buckets, LATENCY_KEYS, options.scale)
    return { ...scaled, rows: bandRows(scaled.rows) }
  }, [buckets, options.scale])
  const valuesOf = (key: (typeof LATENCY_KEYS)[number]) => series.rows.map((row) => row[key])
  const band = options.view.id === "band"
  const config = band ? latencyBandChartConfig : latencyChartConfig
  const state = dataState(isLoading, isError, noTimings ? 0 : buckets.length)

  return (
    <SignalPanel
      title={TITLE}
      state={state}
      error={error?.message ?? "Failed to load request latency."}
      empty={noTimings ? `No timing data in this range. ${TIMING_HINT}` : undefined}
      onRetry={() => void refetch()}
      bodyClassName="min-h-[196px] max-md:min-h-[170px]"
      actions={
        <>
          <ScaleNotes
            clip={series.clipMax != null ? formatDurationOrNa(series.clipMax) : null}
            zerosRaised={series.zerosRaised}
          />
          <CursorStamp cursor={cursor} rows={buckets} granularity={data?.granularity} />
          <GranularityBadge granularity={data?.granularity} />
          <ChartOptionsMenu title={TITLE} spec={LATENCY_OPTIONS} options={options} />
        </>
      }
      readout={
        <LatencyReadout
          cursor={cursor}
          buckets={buckets}
          band={band}
          granularity={data?.granularity}
        />
      }
    >
      {data && (
        <TimeChart
          id="latency"
          label={TITLE}
          summary={`${band ? "Average, p99, and a p50 to p95 band" : "Average, p50, p95 and p99"} of response time, ${chartRangeText(buckets, data.granularity)}.`}
          describe={(bucket) => {
            const row = bucketsByTime.get(bucket) ?? null
            return spokenReadout(formatTs(bucket, data.granularity), latencyItems(row, band))
          }}
          config={config}
          rows={series.rows}
          granularity={data.granularity}
          cursor={cursor}
          marks={{
            kind: "line",
            dots: (band ? (["p99RequestTime", "avgRequestTime"] as const) : LATENCY_KEYS).map(
              (key) => ({ key, color: `var(--color-${key})` }),
            ),
          }}
          // request_time is seconds; formatDurationOrNa takes seconds
          yAxis={{
            width: 56,
            tickFormatter: (v: number) => (v === 0 ? "0ms" : formatDurationOrNa(v)),
            ...series.axis,
          }}
          className="h-[196px] max-md:h-[170px]"
        >
          {band
            ? [
                <Area
                  activeDot={false}
                  key="band"
                  dataKey="band"
                  type="linear"
                  fill="var(--color-band)"
                  fillOpacity={0.25}
                  stroke="none"
                  connectNulls={false}
                />,
                <Line
                  activeDot={false}
                  key="p99"
                  dataKey="p99RequestTime"
                  type="linear"
                  stroke="var(--color-p99RequestTime)"
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                  dot={isolatedDot(valuesOf("p99RequestTime"), "var(--color-p99RequestTime)")}
                  connectNulls={false}
                />,
                <Line
                  activeDot={false}
                  key="avg"
                  dataKey="avgRequestTime"
                  type="linear"
                  stroke="var(--color-avgRequestTime)"
                  strokeWidth={2}
                  dot={isolatedDot(valuesOf("avgRequestTime"), "var(--color-avgRequestTime)")}
                  connectNulls={false}
                />,
              ]
            : LATENCY_KEYS.map((key) => (
                <Line
                  activeDot={false}
                  key={key}
                  dataKey={key}
                  type="linear"
                  stroke={`var(--color-${key})`}
                  strokeWidth={2}
                  dot={isolatedDot(valuesOf(key), `var(--color-${key})`)}
                  connectNulls={false}
                />
              ))}
        </TimeChart>
      )}
    </SignalPanel>
  )
}
