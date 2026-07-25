/**
 * Five minutes of traffic as a seismograph. Bar height is requests in that
 * bin, colour is the worst status it contained, and a red cap marks a bin
 * that included a banned IP.
 *
 * One-second buckets are aggregated into display bins wide enough to read
 * and to hover (see wire.ts). Hovering raises a detail card for the bin's
 * most notable request; clicking replays that request's arc on the map.
 *
 * Canvas rather than SVG nodes: the whole strip is redrawn every second.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useLiveBuckets, useLiveTrafficStore } from "@/lib/live-traffic/context"
import { BANNED_RING_COLOR, PACKET_COLORS } from "@/lib/live-traffic/classify"
import { WINDOW_SECONDS } from "@/lib/live-traffic/store"
import { binBuckets, binSecondsFor, notableRequest, resolveHoveredBin, type WireBin } from "@/lib/live-traffic/wire"
import type { LiveRequest } from "@/lib/live-traffic/types"

const HEIGHT = 64
const BAR_GAP = 1
const FALLBACK_WIDTH = 760

function draw(canvas: HTMLCanvasElement, bins: WireBin[], hovered: number | null): void {
  const context = canvas.getContext("2d")
  if (!context || bins.length === 0) return

  const ratio = window.devicePixelRatio || 1
  const width = canvas.clientWidth
  // Resizing the backing store clears it, so only do that when the size
  // actually changed.
  if (canvas.width !== width * ratio || canvas.height !== HEIGHT * ratio) {
    canvas.width = width * ratio
    canvas.height = HEIGHT * ratio
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  context.clearRect(0, 0, width, HEIGHT)

  const barWidth = Math.max(1, width / bins.length - BAR_GAP)
  const peak = Math.max(1, ...bins.map((bin) => bin.total))

  bins.forEach((bin, index) => {
    const x = (index * width) / bins.length
    if (index === hovered) {
      context.fillStyle = "rgba(34, 211, 238, 0.14)"
      context.fillRect(x - BAR_GAP, 0, barWidth + BAR_GAP * 2, HEIGHT)
    }
    if (bin.total === 0) return

    const barHeight = Math.max(2, (bin.total / peak) * (HEIGHT - 4))
    context.fillStyle = PACKET_COLORS[bin.worstStatus]
    context.fillRect(x, HEIGHT - barHeight, barWidth, barHeight)

    if (bin.banned > 0) {
      context.fillStyle = BANNED_RING_COLOR
      context.fillRect(x, HEIGHT - barHeight, barWidth, 2)
    }
  })
}

export function LiveWire({ onSelect }: { onSelect: (request: LiveRequest) => void }) {
  const buckets = useLiveBuckets()
  const store = useLiveTrafficStore()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [width, setWidth] = useState(0)
  // The bin's start second, not its index - see wire.ts.
  const [hoveredStart, setHoveredStart] = useState<number | null>(null)

  // Track the rendered width so bin sizing follows the actual canvas, and a
  // window resize re-bins immediately instead of on the next tick.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const observer = new ResizeObserver(() => setWidth(canvas.clientWidth))
    observer.observe(canvas)
    setWidth(canvas.clientWidth)
    return () => observer.disconnect()
  }, [])

  const binSeconds = binSecondsFor(width || FALLBACK_WIDTH, WINDOW_SECONDS)
  const bins = useMemo(() => binBuckets(buckets, binSeconds), [buckets, binSeconds])
  const hovered = resolveHoveredBin(bins, hoveredStart)

  useEffect(() => {
    if (canvasRef.current) draw(canvasRef.current, bins, hovered)
  }, [bins, hovered, width])

  const binStartAt = useCallback(
    (clientX: number): number | null => {
      const canvas = canvasRef.current
      if (!canvas || bins.length === 0) return null
      const rect = canvas.getBoundingClientRect()
      const index = Math.floor(((clientX - rect.left) / rect.width) * bins.length)
      return index >= 0 && index < bins.length ? bins[index].startSecond : null
    },
    [bins],
  )

  const hoveredBin = hovered === null ? null : bins[hovered]
  const hoveredRequest =
    hoveredBin && hoveredBin.total > 0
      ? notableRequest(hoveredBin, (id) => store.getRequest(id))
      : undefined

  // Anchor the hover card over the hovered column, clamped to the panel.
  const cardLeft =
    hovered === null || bins.length === 0 || width === 0
      ? 0
      : Math.min(Math.max(((hovered + 0.5) * width) / bins.length, 130), width - 130)

  return (
    <div className="pointer-events-auto relative rounded-md border bg-background/85 px-2 py-1.5 backdrop-blur">
      {hoveredRequest && (
        <div
          className="pointer-events-none absolute bottom-full z-10 mb-1.5 w-64 -translate-x-1/2 rounded-md border bg-background/95 px-2.5 py-2 text-[11px] shadow-lg backdrop-blur"
          style={{ left: cardLeft }}
        >
          <div className="flex items-center gap-2">
            <span
              className="rounded px-1 font-mono text-[10px] font-bold"
              style={{
                background: `${PACKET_COLORS[hoveredRequest.statusClass]}28`,
                color: PACKET_COLORS[hoveredRequest.statusClass],
              }}
            >
              {hoveredRequest.log?.status_code ?? "?"}
            </span>
            <span className="text-muted-foreground">{hoveredRequest.log?.method ?? "-"}</span>
            <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">
              {new Date(hoveredRequest.timestamp).toLocaleTimeString()}
            </span>
          </div>
          <div className="mt-1 truncate font-mono">
            {hoveredRequest.log?.url ?? hoveredRequest.ip}
          </div>
          <div className="mt-0.5 flex justify-between text-[10px] text-muted-foreground">
            <span className="truncate">
              {hoveredRequest.ip}
              {hoveredRequest.countryCode ? ` · ${hoveredRequest.countryCode}` : ""}
            </span>
            <span className="shrink-0">Click to replay</span>
          </div>
        </div>
      )}

      <div className="flex justify-between px-0.5 text-[9px] text-muted-foreground">
        <span>-5 min</span>
        <span>-4</span>
        <span>-3</span>
        <span>-2</span>
        <span>-1</span>
        <span className="text-geo-cyan">now</span>
      </div>
      <canvas
        ref={canvasRef}
        style={{ width: "100%", height: HEIGHT }}
        aria-label="Requests over the last five minutes"
        onMouseMove={(event) => setHoveredStart(binStartAt(event.clientX))}
        onMouseLeave={() => setHoveredStart(null)}
        onClick={() => {
          if (hoveredRequest) onSelect(hoveredRequest)
        }}
      />
      <div className="flex justify-between px-0.5 text-[9px] text-muted-foreground">
        <span>Bar height is requests, colour is the worst status</span>
        <span>{buckets.reduce((total, bucket) => total + bucket.threats, 0)} threats</span>
      </div>
    </div>
  )
}
