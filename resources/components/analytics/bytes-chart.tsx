import { useMemo, useState } from "react"
import { Area, Bar } from "recharts"
import { SignalPanel } from "@/components/data/signal-panel"
import { dataState } from "@/components/data/types"
import type { TimeSeriesDataPoint } from "@/generated/api/types.gen"
import { formatBytes } from "@/lib/api"
import { useChartOptions } from "@/lib/chart-options"
import { scaleSeries, type YAxisScaleProps } from "@/lib/chart-scale"
import { formatTs } from "@/lib/datetime"
import { useTimeSeries } from "@/lib/queries"
import { GranularityBadge } from "@/components/chart-buckets-menu"
import { ChartOptionsMenu, ScaleNotes } from "./chart-options-menu"
import { ChartReadout, CursorStamp, spokenReadout, useCursorRow } from "./chart-readout"
import { createChartCursor, type ChartCursor } from "./chart-cursor"
import { barSpacer, BYTES_OPTIONS, bytesChartConfig } from "./chart-utils"
import { useTrafficBuckets } from "./use-traffic-buckets"
import { TimeChart } from "./time-chart"
import { byteTicks, chartRangeText, hoursSince } from "./traffic-series"

const TITLE = "Bandwidth"
const SERIES = ["totalBytesSent"] as const

function BytesReadout({
  cursor,
  buckets,
  granularity,
  since,
  ready,
}: {
  cursor: ChartCursor
  buckets: readonly TimeSeriesDataPoint[]
  granularity?: string
  /** "since Sep 28" when the hours before it have expired. */
  since: string | null
  ready: boolean
}) {
  const total = useMemo(
    () => buckets.reduce((sum, bucket) => sum + bucket.totalBytesSent, 0),
    [buckets],
  )
  const row = useCursorRow(cursor, buckets)
  return (
    <ChartReadout
      items={[
        {
          key: "totalBytesSent",
          label: String(bytesChartConfig.totalBytesSent.label),
          color: bytesChartConfig.totalBytesSent.color,
          value: ready ? formatBytes(row ? row.totalBytesSent : total) : null,
        },
      ]}
      stamp={row ? formatTs(row.timestamp, granularity) : null}
      note={ready && !row ? since : null}
    />
  )
}

export function BytesChart() {
  const { data, error, isLoading, isError, refetch } = useTimeSeries()
  const options = useChartOptions("bytes", BYTES_OPTIONS)
  const [cursor] = useState(createChartCursor)
  const buckets = useTrafficBuckets(data)
  const bytesByTime = useMemo(
    () => new Map(buckets.map((row) => [Date.parse(row.timestamp), row.totalBytesSent])),
    [buckets],
  )
  const series = useMemo(
    () => scaleSeries(buckets, SERIES, options.scale, { base: 1024, integer: true }),
    [buckets, options.scale],
  )
  // Log keeps its power-of-1024 axis; linear axes step in whole KB, MB or GB,
  // and a clipped axis ends on the tick above the clip line.
  const axis = useMemo((): YAxisScaleProps & { clippedAt: number | null } => {
    if (options.scale === "log") return { ...series.axis, clippedAt: null }
    const largest = Math.max(0, ...buckets.map((bucket) => bucket.totalBytesSent))
    const { ticks, domain } = byteTicks(series.clipMax ?? largest)
    // Rounding the clip up to a whole unit can lift the axis over the largest bucket.
    const clipped = series.clipMax != null && domain[1] < largest
    if (series.clipMax != null && !clipped) {
      return { ...byteTicks(largest), clippedAt: null }
    }
    return { ticks, domain, allowDataOverflow: clipped, clippedAt: clipped ? domain[1] : null }
  }, [buckets, options.scale, series])
  const state = dataState(isLoading, isError, buckets.length)
  const bars = options.view.id === "bars"

  return (
    <SignalPanel
      title={TITLE}
      state={state}
      error={error?.message ?? "Failed to load bandwidth."}
      onRetry={() => void refetch()}
      bodyClassName="min-h-[196px] max-md:min-h-[170px]"
      actions={
        <>
          <ScaleNotes
            clip={axis.clippedAt != null ? formatBytes(axis.clippedAt) : null}
            zerosRaised={series.zerosRaised}
          />
          <CursorStamp cursor={cursor} rows={buckets} granularity={data?.granularity} />
          <GranularityBadge granularity={data?.granularity} />
          <ChartOptionsMenu title={TITLE} spec={BYTES_OPTIONS} options={options} />
        </>
      }
      readout={
        <BytesReadout
          cursor={cursor}
          buckets={buckets}
          granularity={data?.granularity}
          since={hoursSince(buckets, data?.startDate, data?.granularity)}
          ready={state === "ready"}
        />
      }
    >
      {data && (
        <TimeChart
          label={TITLE}
          summary={`${options.view.label} of response bytes sent, ${chartRangeText(buckets, data.granularity)}.`}
          describe={(bucket) =>
            spokenReadout(formatTs(bucket, data.granularity), [
              {
                key: "totalBytesSent",
                label: String(bytesChartConfig.totalBytesSent.label),
                color: bytesChartConfig.totalBytesSent.color,
                value: formatBytes(bytesByTime.get(bucket) ?? 0),
              },
            ])
          }
          config={bytesChartConfig}
          rows={series.rows}
          granularity={data.granularity}
          cursor={cursor}
          marks={
            bars
              ? { kind: "bar", top: (row) => (row as TimeSeriesDataPoint).totalBytesSent }
              : {
                  kind: "line",
                  dots: [{ key: "totalBytesSent", color: "var(--color-totalBytesSent)" }],
                }
          }
          yAxis={{
            width: 64,
            tickFormatter: (v: number) => formatBytes(v),
            scale: axis.scale,
            domain: axis.domain,
            ticks: axis.ticks,
            allowDataOverflow: axis.allowDataOverflow,
          }}
          className="h-[196px] max-md:h-[170px]"
        >
          {bars ? (
            <Bar
              dataKey="totalBytesSent"
              fill="var(--color-totalBytesSent)"
              radius={[2, 2, 0, 0]}
              {...barSpacer(buckets.length)}
            />
          ) : (
            <Area
              activeDot={false}
              dataKey="totalBytesSent"
              type="linear"
              fill="var(--color-totalBytesSent)"
              fillOpacity={0.2}
              stroke="var(--color-totalBytesSent)"
              strokeWidth={2}
            />
          )}
        </TimeChart>
      )}
    </SignalPanel>
  )
}
