import { useMemo } from "react"
import { Area, Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts"
import { SignalPanel } from "@/components/data/signal-panel"
import { dataState } from "@/components/data/types"
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart"
import { formatNumber } from "@/lib/api"
import { useChartOptions } from "@/lib/chart-options"
import { scaleSeries } from "@/lib/chart-scale"
import { formatTs } from "@/lib/datetime"
import { useTimeSeries } from "@/lib/queries"
import { ChartLegendRow } from "./chart-legend-row"
import { ChartOptionsMenu, ScaleNotes } from "./chart-options-menu"
import {
  DENSE_BUCKETS,
  formatLogCount,
  formatRate,
  STATUS_OPTIONS,
  statusChartConfig,
  statusErrorRateChartConfig,
} from "./chart-utils"
import { GranularityBadge } from "./granularity-badge"
import { errorRateSeries, SHARE_TICKS, shareLabel, shareRows, STATUS_KEYS, statusTotal } from "./status-series"
import { TimeSeriesTooltip } from "./time-series-tooltip"

const DESCRIPTIONS: Record<string, string> = {
  stacked: "HTTP response classes across the selected request volume.",
  share: "Share of 2xx to 5xx responses per bucket. 1xx is not counted.",
  "error-rate": "Share of requests answered with a 4xx or 5xx status.",
}

export function StatusChart() {
  const { data, error, isLoading, isError, refetch } = useTimeSeries()
  const options = useChartOptions("status", STATUS_OPTIONS)
  const buckets = useMemo(() => data?.data ?? [], [data])
  const view = options.view.id
  const dense = buckets.length > DENSE_BUCKETS
  const stacked = useMemo(
    () => scaleSeries(buckets, STATUS_KEYS, options.scale, { integer: true, clipValues: buckets.map(statusTotal) }),
    [buckets, options.scale],
  )
  const share = useMemo(() => shareRows(buckets), [buckets])
  const rate = useMemo(() => errorRateSeries(buckets, options.scale), [buckets, options.scale])
  const state = dataState(isLoading, isError, buckets.length)

  const config: ChartConfig = view === "error-rate" ? statusErrorRateChartConfig : statusChartConfig
  const rows = view === "share" ? share : view === "error-rate" ? rate.rows : stacked.rows
  const clipMax = view === "stacked" ? stacked.clipMax : view === "error-rate" ? rate.clipMax : null
  const clipLabel = clipMax == null ? null : view === "error-rate" ? formatRate(clipMax) : formatNumber(clipMax)
  const yAxis =
    view === "share"
      ? { domain: [0, 1] as [number, number], ticks: SHARE_TICKS, tickFormatter: formatRate }
      : view === "error-rate"
        ? { ...rate.axis, tickFormatter: formatRate }
        : { ...stacked.axis, tickFormatter: options.scale === "log" ? formatLogCount : (v: number) => formatNumber(v) }

  const stackMarks = STATUS_KEYS.map((key, i) =>
    dense ? (
      <Area
        key={key}
        dataKey={key}
        stackId="s"
        type="monotone"
        fill={`var(--color-${key})`}
        fillOpacity={1}
        stroke="none"
        connectNulls={false}
      />
    ) : (
      // stroke = card surface: the spacer between stacked segments
      <Bar
        key={key}
        dataKey={key}
        stackId="s"
        fill={`var(--color-${key})`}
        stroke="var(--card)"
        strokeWidth={1}
        radius={i === STATUS_KEYS.length - 1 ? [2, 2, 0, 0] : undefined}
      />
    ),
  )
  const lineMarks = STATUS_KEYS.map((key) => (
    <Line
      key={key}
      dataKey={key}
      type="monotone"
      stroke={`var(--color-${key})`}
      strokeWidth={2}
      dot={false}
      connectNulls={false}
    />
  ))
  const marks =
    view === "error-rate" ? (
      <Line
        dataKey="errorRate"
        type="monotone"
        stroke="var(--color-errorRate)"
        strokeWidth={2}
        dot={false}
        connectNulls={false}
      />
    ) : view === "stacked" && options.scale === "log" ? (
      lineMarks
    ) : (
      stackMarks
    )

  return (
    <SignalPanel
      title="Status classes"
      description={DESCRIPTIONS[view]}
      state={state}
      error={error?.message ?? "Failed to load status classes."}
      onRetry={() => void refetch()}
      bodyClassName="min-h-[240px]"
      actions={
        <>
          <ScaleNotes clip={clipLabel} zerosRaised={view === "stacked" ? stacked.zerosRaised : 0} />
          <GranularityBadge granularity={data?.granularity} />
          <ChartOptionsMenu title="Status classes" spec={STATUS_OPTIONS} options={options} />
        </>
      }
      legend={<ChartLegendRow config={config} label="Status chart legend" />}
    >
      {data && (
        <ChartContainer config={config} className="h-[240px] w-full">
          <ComposedChart data={rows} stackOffset={view === "share" ? "expand" : undefined}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="timestamp"
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: string) => formatTs(v, data.granularity)}
            />
            <YAxis tickLine={false} axisLine={false} width={48} {...yAxis} />
            <ChartTooltip
              // Share and error rate keep null entries so empty buckets read "n/a".
              filterNull={view === "stacked"}
              content={
                view === "stacked" ? (
                  <TimeSeriesTooltip granularity={data.granularity} />
                ) : (
                  <TimeSeriesTooltip
                    granularity={data.granularity}
                    formatter={(value, name, item) => (
                      <span className="flex w-full justify-between gap-2">
                        <span className="text-muted-foreground">
                          {config[String(name)]?.label ?? name}
                        </span>
                        <span className="font-mono tabular-nums">
                          {view === "share"
                            ? shareLabel(value, item.payload)
                            : typeof value === "number" ? formatRate(value) : "n/a"}
                        </span>
                      </span>
                    )}
                  />
                )
              }
            />
            {marks}
          </ComposedChart>
        </ChartContainer>
      )}
    </SignalPanel>
  )
}
