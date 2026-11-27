/**
 * The frame the Analytics traffic charts share: a ComposedChart over time
 * buckets with hourly tick labels, and a cursor that follows the pointer.
 * With a mouse the cursor follows hover. On a touch screen it follows a
 * sideways drag or a held finger, and a vertical swipe still scrolls the page.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react"
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
import { isIsolated } from "./status-series"
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

/**
 * A line's dot renderer that marks only values with empty buckets on both
 * sides: a line through one point draws nothing, so a lone busy hour would
 * not show at all.
 */
export function isolatedDot(values: ReadonlyArray<number | null | undefined>, color: string) {
  return function IsolatedDot(props: {
    key?: React.Key | null
    index: number
    cx?: number
    cy?: number
  }) {
    return isIsolated(values, props.index) ? (
      <circle key={props.key ?? undefined} cx={props.cx} cy={props.cy} r={2.5} fill={color} />
    ) : (
      <g key={props.key ?? undefined} />
    )
  }
}

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

  const indexByTime = useMemo(
    () => new Map(rows.map((row, index) => [Date.parse(row.timestamp), index])),
    [rows],
  )
  const bucket = useCursorBucket(cursor)
  const index = bucket == null ? -1 : (indexByTime.get(bucket) ?? -1)
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

type Touch = {
  id: number
  x: number
  y: number
  /** Where the finger is now; a hold reads this bucket, not the one it landed on. */
  lastX: number
  scrubbing: boolean
  timer: number
}

/** The next bucket for a key; with none marked, an arrow marks the latest. */
const STEP_KEYS: Record<string, (index: number, last: number) => number> = {
  ArrowLeft: (index, last) => (index < 0 ? last : Math.max(0, index - 1)),
  ArrowRight: (index, last) => (index < 0 ? last : Math.min(last, index + 1)),
  Home: () => 0,
  End: (_, last) => last,
}

export function TimeChart({
  label,
  summary,
  describe,
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
  /** The chart's accessible name, such as "Requests". */
  label: string
  /** What the chart draws and over which time, for a screen reader. */
  summary: string
  /** What a screen reader hears for a bucket picked with the keyboard. */
  describe: (bucketMs: number) => string
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
  // Written straight to the node: state here would redraw the whole chart on every key press.
  const spoken = useRef<HTMLSpanElement>(null)
  const speak = (text: string) => {
    if (spoken.current) spoken.current.textContent = text
  }
  const summaryId = useId()
  // A held finger reads its bucket after HOLD_MS, from the rows of that moment.
  const latestRows = useRef(rows)
  useLayoutEffect(() => {
    latestRows.current = rows
  })

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
    const rows = latestRows.current
    const frame = frameRef.current
    const shape = geometry.current
    if (!frame || !shape || shape.centers.length !== rows.length || rows.length === 0) return null
    const x = clientX - frame.getBoundingClientRect().left
    if (x < shape.plotX || x > shape.plotX + shape.plotWidth) return null
    return Date.parse(rows[nearestIndex(shape.centers, x)].timestamp)
  }

  const startScrub = (frame: HTMLElement, held: Touch) => {
    held.scrubbing = true
    try {
      frame.setPointerCapture(held.id)
    } catch {
      // The pointer is already gone; its pointerup or pointercancel ends the touch.
    }
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
      // A second finger is a pinch, which belongs to the browser.
      if (event.touches.length > 1) {
        if (touch.current) window.clearTimeout(touch.current.timer)
        touch.current = null
        cursor.set(null)
        return
      }
      if (touch.current?.scrubbing && event.cancelable) event.preventDefault()
    }
    frame.addEventListener("touchmove", onTouchMove, { passive: false })
    return () => frame.removeEventListener("touchmove", onTouchMove)
  }, [frameRef, cursor])

  const step = (event: React.KeyboardEvent) => {
    // Alt+Left and Cmd+Left are the browser's Back; modified keys are not ours.
    if (event.altKey || event.ctrlKey || event.metaKey) return
    if (event.key === "Escape") {
      cursor.set(null)
      speak("")
      return
    }
    const move = STEP_KEYS[event.key]
    if (!move || rows.length === 0) return
    event.preventDefault()
    const current = cursor.get()
    const index = rows.findIndex((row) => Date.parse(row.timestamp) === current)
    const bucket = Date.parse(rows[move(index, rows.length - 1)].timestamp)
    cursor.set(bucket)
    speak(describe(bucket))
  }
  // A chart that unmounts under the pointer, such as on a range change, sends no pointerleave.
  useEffect(
    () => () => {
      window.clearTimeout(touch.current?.timer)
      cursor.set(null)
    },
    [cursor],
  )

  return (
    <div
      ref={frameRef}
      tabIndex={0}
      // The application role keeps screen readers out of browse mode, so the arrow keys reach the chart.
      role="application"
      aria-roledescription="chart"
      aria-describedby={summaryId}
      aria-label={`${label}. Arrow keys read one bucket at a time.`}
      className="touch-pan-y touch-pinch-zoom rounded-md outline-none select-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      onKeyDown={step}
      onBlur={() => {
        cursor.set(null)
        speak("")
      }}
      onPointerMove={(event) => {
        if (event.pointerType === "mouse") {
          cursor.set(bucketAt(event.clientX))
          return
        }
        const held = touch.current
        if (!held || held.id !== event.pointerId) return
        held.lastX = event.clientX
        if (!held.scrubbing) {
          const dx = Math.abs(event.clientX - held.x)
          const dy = Math.abs(event.clientY - held.y)
          if (dy > SLOP_PX && dy >= dx) return endTouch()
          if (dx <= SLOP_PX) return
          window.clearTimeout(held.timer)
          startScrub(event.currentTarget, held)
        }
        cursor.set(bucketAt(event.clientX))
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse") cursor.set(null)
        // A pen has no implicit capture, so its pointerup can land outside the chart.
        else if (
          touch.current?.id === event.pointerId &&
          !event.currentTarget.hasPointerCapture(event.pointerId)
        ) {
          endTouch()
        }
      }}
      onPointerDown={(event) => {
        if (event.pointerType === "mouse") return
        endTouch()
        if (!event.isPrimary) return
        const { pointerId, clientX, clientY } = event
        const held: Touch = {
          id: pointerId,
          x: clientX,
          y: clientY,
          lastX: clientX,
          scrubbing: false,
          timer: 0,
        }
        const frame = event.currentTarget
        held.timer = window.setTimeout(() => {
          startScrub(frame, held)
          cursor.set(bucketAt(held.lastX))
        }, HOLD_MS)
        touch.current = held
      }}
      onPointerUp={(event) => {
        if (touch.current?.id === event.pointerId) endTouch()
      }}
      onPointerCancel={(event) => {
        if (touch.current?.id === event.pointerId) endTouch()
      }}
      // A long press opens the context menu on some phones.
      onContextMenu={(event) => {
        if (touch.current) event.preventDefault()
      }}
    >
      {/* The frame handles the pointer; Recharts' own hover state would only draw its active dots. */}
      <ChartContainer
        aria-hidden
        config={config}
        className={cn("pointer-events-none w-full", className)}
      >
        <ComposedChart data={rows as Row[]} stackOffset={stackOffset} accessibilityLayer={false}>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="timestamp"
            // Line-only charts would otherwise run edge to edge; a band puts every
            // chart's hours in the middle of their slots, so the three line up.
            scale="band"
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
      {/* Only keyboard steps speak; hover and touch stay silent. */}
      <p id={summaryId} className="sr-only">
        {summary}
      </p>
      <span ref={spoken} className="sr-only" aria-live="polite" />
    </div>
  )
}
