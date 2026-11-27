/**
 * The Analytics page's Traffic section: the three charts under one cursor,
 * drag to zoom, and Zoom out on the section line.
 */
import { useMemo } from "react"
import { JumpTarget } from "@/components/jump-bar"
import { SectionHeader } from "@/components/section-header"
import { useChartZoomStack, zoomFits, type ZoomStep } from "@/lib/chart-zoom"
import { useTimeRange } from "@/lib/time-range-context"
import { BytesChart } from "./bytes-chart"
import { ChartCursorProvider, useChartCursor, type ChartZoom } from "./chart-cursor"
import { LatencyChart } from "./latency-chart"
import { RequestsChart } from "./requests-chart"
import { useKeptSinceMs } from "./use-traffic-buckets"
import { ZoomOutButton } from "./zoom-out-button"

function TrafficHeader({
  back,
  zoomOut,
  last,
}: {
  back: ZoomStep["from"] | null
  zoomOut: () => void
  /** True when this Zoom out empties the stack, so the button goes away. */
  last: boolean
}) {
  const cursor = useChartCursor()
  return (
    <SectionHeader
      actions={
        back && (
          <ZoomOutButton
            back={back}
            onClick={() => {
              // The hour under the pointer can sit in the wider range too, far from the pointer.
              cursor.set(null)
              zoomOut()
              // The button leaves with the last zoom; keep focus on the range it changed.
              if (last) {
                document.querySelector<HTMLElement>('button[aria-label^="Time range"]')?.focus()
              }
            }}
          />
        )
      }
    >
      Traffic
    </SectionHeader>
  )
}

export function TrafficSection() {
  const { granularity } = useTimeRange()
  const { zoomTo, zoomOut, back, depth } = useChartZoomStack()
  const keptSinceMs = useKeptSinceMs()
  const zoom = useMemo<ChartZoom>(
    () => ({
      fits: (startMs, endMs) => zoomFits(startMs, endMs, granularity, keptSinceMs),
      to: zoomTo,
    }),
    [granularity, keptSinceMs, zoomTo],
  )

  return (
    <ChartCursorProvider zoom={zoom}>
      <TrafficHeader back={back} zoomOut={zoomOut} last={depth === 1} />
      <div className="grid gap-4 lg:grid-cols-2">
        <JumpTarget id="requests">
          <RequestsChart className="lg:col-span-2" />
        </JumpTarget>
        <JumpTarget id="bandwidth">
          <BytesChart />
        </JumpTarget>
        <JumpTarget id="latency">
          <LatencyChart />
        </JumpTarget>
      </div>
    </ChartCursorProvider>
  )
}
