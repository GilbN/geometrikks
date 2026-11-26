/**
 * The frame the Analytics traffic charts share: a ComposedChart over time
 * buckets with hourly tick labels, and a cursor that follows the pointer.
 * With a mouse the cursor follows hover. On a touch screen it follows a
 * sideways drag or a held finger, and a vertical swipe still scrolls the page.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import {
  CartesianGrid,
  ComposedChart,
  usePlotArea,
  useXAxisScale,
  useYAxisScale,
  XAxis,
  YAxis,
  ZIndexLayer,
} from "recharts"
import { ChartContainer, type ChartConfig } from "@/components/ui/chart"
import { formatTs } from "@/lib/datetime"
import { cn } from "@/lib/utils"
import { useCursorBucket, type ChartCursor } from "./chart-cursor"
import { hourlyTicks } from "./traffic-series"

type Row = { timestamp: string }

/**
 * What marks the cursor's bucket. Bars: the other bars dim and a dashed line
 * runs down to the bar's top (`top` gives it in y-axis units). Lines: a
 * dashed line across the plot with a dot on each listed series.
 */
export type CursorMarks =
  | { kind: "bar"; top: (row: Row) => number | null }
  | { kind: "line"; dots: ReadonlyArray<{ key: string; color: string }> }

type Geometry = { plotX: number; plotWidth: number; centers: number[] }

/** Held this long without moving, a finger shows the cursor. */
const HOLD_MS = 250
/** Movement that decides between reading the hours and scrolling the page. */
const SLOP_PX = 8

const CURSOR_LINE = {
  stroke: "var(--foreground)",
  strokeOpacity: 0.5,
  strokeDasharray: "3 3",
} as const

function nearestIndex(centers: readonly number[], x: number): number {
  let low = 0
  let high = centers.length - 1
  while (low < high) {
    const mid = (low + high) >> 1
    if (centers[mid] < x) low = mid + 1
    else high = mid
  }
  return low > 0 && x - centers[low - 1] < centers[low] - x ? low - 1 : low
}

function CursorLayer({
  rows,
  cursor,
  marks,
  geometry,
}: {
  rows: readonly Row[]
  cursor: ChartCursor
  marks: CursorMarks
  geometry: React.RefObject<Geometry | null>
}) {
  const plot = usePlotArea()
  const xScale = useXAxisScale()
  const yScale = useYAxisScale()
  const centers = useMemo(
    () =>
      xScale ? rows.map((row) => xScale(row.timestamp, { position: "middle" }) ?? Number.NaN) : [],
    [rows, xScale],
  )
  useLayoutEffect(() => {
    geometry.current = plot ? { plotX: plot.x, plotWidth: plot.width, centers } : null
  })

  const bucket = useCursorBucket(cursor)
  const index = useMemo(
    () => (bucket == null ? -1 : rows.findIndex((row) => Date.parse(row.timestamp) === bucket)),
    [bucket, rows],
  )
  if (!plot || !yScale || index < 0 || !Number.isFinite(centers[index])) return null

  const x = centers[index]
  const top = plot.y
  const bottom = plot.y + plot.height
  const clampY = (y: number) => Math.min(Math.max(y, top), bottom)
  const row = rows[index] as Row & Record<string, unknown>

  if (marks.kind === "bar") {
    const step = plot.width / rows.length
    const value = marks.top(row)
    const barTop = value == null ? bottom : clampY(yScale(value) ?? bottom)
    // Card-colored veils over the other bars read as the other bars dimming.
    const veil = { y: top, height: plot.height, fill: "var(--card)", fillOpacity: 0.45 }
    return (
      <>
        <ZIndexLayer zIndex={450}>
          <rect {...veil} x={plot.x} width={Math.max(0, x - step / 2 - plot.x)} />
          <rect
            {...veil}
            x={x + step / 2}
            width={Math.max(0, plot.x + plot.width - (x + step / 2))}
          />
        </ZIndexLayer>
        {barTop - 3 > top && (
          <ZIndexLayer zIndex={1100}>
            <path d={`M${x},${top}V${barTop - 3}`} {...CURSOR_LINE} />
          </ZIndexLayer>
        )}
      </>
    )
  }

  return (
    <ZIndexLayer zIndex={1100}>
      <path d={`M${x},${top}V${bottom}`} {...CURSOR_LINE} />
      {marks.dots.map(({ key, color }) => {
        const value = row[key]
        const y = typeof value === "number" ? yScale(value) : undefined
        if (y == null || !Number.isFinite(y)) return null
        return (
          <circle
            key={key}
            cx={x}
            cy={clampY(y)}
            r={3.5}
            fill="var(--card)"
            stroke={color}
            strokeWidth={2}
          />
        )
      })}
    </ZIndexLayer>
  )
}

function useElementWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    setWidth(node.getBoundingClientRect().width)
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  return [ref, width]
}

type Touch = { id: number; x: number; y: number; scrubbing: boolean; timer: number }

export function TimeChart({
  config,
  rows,
  granularity,
  cursor,
  marks,
  yAxis,
  stackOffset,
  className,
  children,
}: {
  config: ChartConfig
  rows: readonly Row[]
  granularity: string | undefined
  cursor: ChartCursor
  marks: CursorMarks
  yAxis: React.ComponentProps<typeof YAxis> & { width: number }
  stackOffset?: "expand"
  className?: string
  children: React.ReactNode
}) {
  const [frameRef, width] = useElementWidth<HTMLDivElement>()
  const geometry = useRef<Geometry | null>(null)
  const touch = useRef<Touch | null>(null)

  const ticks = useMemo(
    () =>
      hourlyTicks(
        rows.map((row) => row.timestamp),
        granularity,
        width - yAxis.width - 10,
      ),
    [rows, granularity, width, yAxis.width],
  )

  const bucketAt = (clientX: number): number | null => {
    const frame = frameRef.current
    const shape = geometry.current
    if (!frame || !shape || shape.centers.length !== rows.length || rows.length === 0) return null
    const x = clientX - frame.getBoundingClientRect().left
    const half = shape.plotWidth / rows.length / 2
    if (x < shape.plotX - half || x > shape.plotX + shape.plotWidth + half) return null
    return Date.parse(rows[nearestIndex(shape.centers, x)].timestamp)
  }

  const endTouch = () => {
    if (touch.current) window.clearTimeout(touch.current.timer)
    touch.current = null
    cursor.set(null)
  }

  // A held or sideways finger reads the hours; stop the page scrolling under it.
  // React's touch listeners are passive, so this one is added by hand.
  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    const onTouchMove = (event: TouchEvent) => {
      if (touch.current?.scrubbing && event.cancelable) event.preventDefault()
    }
    frame.addEventListener("touchmove", onTouchMove, { passive: false })
    return () => frame.removeEventListener("touchmove", onTouchMove)
  }, [frameRef])
  useEffect(() => () => window.clearTimeout(touch.current?.timer), [])

  return (
    <div
      ref={frameRef}
      aria-hidden
      className="touch-pan-y select-none"
      onPointerMove={(event) => {
        if (event.pointerType === "mouse") {
          cursor.set(bucketAt(event.clientX))
          return
        }
        const held = touch.current
        if (!held || held.id !== event.pointerId) return
        if (!held.scrubbing) {
          const dx = Math.abs(event.clientX - held.x)
          const dy = Math.abs(event.clientY - held.y)
          if (dy > SLOP_PX && dy >= dx) return endTouch()
          if (dx <= SLOP_PX) return
          window.clearTimeout(held.timer)
          held.scrubbing = true
        }
        cursor.set(bucketAt(event.clientX))
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse") cursor.set(null)
      }}
      onPointerDown={(event) => {
        if (event.pointerType === "mouse") return
        endTouch()
        const { pointerId, clientX, clientY } = event
        const held: Touch = { id: pointerId, x: clientX, y: clientY, scrubbing: false, timer: 0 }
        held.timer = window.setTimeout(() => {
          held.scrubbing = true
          cursor.set(bucketAt(clientX))
        }, HOLD_MS)
        touch.current = held
      }}
      onPointerUp={endTouch}
      onPointerCancel={endTouch}
      // A long press opens the context menu on some phones.
      onContextMenu={(event) => {
        if (touch.current) event.preventDefault()
      }}
    >
      <ChartContainer config={config} className={cn("w-full", className)}>
        <ComposedChart data={rows as Row[]} stackOffset={stackOffset} accessibilityLayer={false}>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="timestamp"
            tickLine={false}
            axisLine={false}
            ticks={ticks?.ticks}
            interval={ticks ? 0 : "preserveEnd"}
            tickFormatter={(value: string) =>
              ticks ? ticks.format(value) : formatTs(value, granularity)
            }
          />
          <YAxis tickLine={false} axisLine={false} niceTicks="snap125" {...yAxis} />
          {children}
          <CursorLayer rows={rows} cursor={cursor} marks={marks} geometry={geometry} />
        </ComposedChart>
      </ChartContainer>
    </div>
  )
}
