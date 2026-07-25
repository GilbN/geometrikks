/**
 * Five minutes of traffic as a seismograph. Bar height is requests in that
 * bin, colour is the worst status it contained, and a red cap marks a bin
 * that included a banned IP.
 *
 * One-second buckets are aggregated into display bins wide enough to read
 * and to hover (see wire.ts). Hovering raises a detail card for the bin's
 * most notable request; clicking replays that request's arc on the map;
 * pressing and dragging scrubs through the window, the card following each
 * moment's timestamp even where nothing happened.
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

function draw(
  canvas: HTMLCanvasElement,
  bins: WireBin[],
  hovered: number | null,
  scrubbing: boolean,
): void {
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

  // Scrub cursor: a full-height line marking the moment being inspected.
  if (scrubbing && hovered !== null) {
    const center = ((hovered + 0.5) * width) / bins.length
    context.fillStyle = "rgba(34, 211, 238, 0.9)"
    context.fillRect(center - 0.5, 0, 1, HEIGHT)
  }
}

export function LiveWire({ onSelect }: { onSelect: (request: LiveRequest) => void }) {
  const buckets = useLiveBuckets()
  const store = useLiveTrafficStore()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [width, setWidth] = useState(0)
  // The bin's start second, not its index - see wire.ts.
  const [hoveredStart, setHoveredStart] = useState<number | null>(null)
  // Press-and-drag scrubs through the window; pointer capture keeps the
  // sweep alive when the cursor drifts off the canvas. A release that
  // travelled further than a click's wobble must not fire the replay.
  const [scrubbing, setScrubbing] = useState(false)
  const dragTravelRef = useRef(0)
  const lastClientXRef = useRef(0)

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
    if (canvasRef.current) draw(canvasRef.current, bins, hovered, scrubbing)
  }, [bins, hovered, scrubbing, width])

  const binStartAt = useCallback(
    (clientX: number): number | null => {
      const canvas = canvasRef.current
      if (!canvas || bins.length === 0) return null
      const rect = canvas.getBoundingClientRect()
      // Clamp so a captured scrub past either edge pins to the first or
      // last bin instead of losing the selection.
      const raw = Math.floor(((clientX - rect.left) / rect.width) * bins.length)
      const index = Math.min(bins.length - 1, Math.max(0, raw))
      return bins[index].startSecond
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
      {/* While scrubbing the card follows every moment, timestamp included,
          even through quiet stretches; on a plain hover it appears only when
          there is a request to describe. */}
      {hoveredBin && (hoveredRequest || scrubbing) && (
        <div
          className="pointer-events-none absolute bottom-full z-10 mb-1.5 w-64 -translate-x-1/2 rounded-md border bg-background/95 px-2.5 py-2 text-[11px] shadow-lg backdrop-blur"
          style={{ left: cardLeft }}
        >
          {hoveredRequest ? (
            <>
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
                <span className="shrink-0">{scrubbing ? "Release, then click to replay" : "Click to replay"}</span>
              </div>
            </>
          ) : (
            <div className="flex items-center justify-between text-muted-foreground">
              <span>No requests</span>
              <span className="text-[10px] tabular-nums">
                {new Date(hoveredBin.startSecond * 1000).toLocaleTimeString()}
              </span>
            </div>
          )}
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
        style={{
          width: "100%",
          height: HEIGHT,
          touchAction: "none",
          cursor: scrubbing ? "grabbing" : "crosshair",
        }}
        aria-label="Requests over the last five minutes"
        onPointerDown={(event) => {
          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
          dragTravelRef.current = 0
          lastClientXRef.current = event.clientX
          setScrubbing(true)
          setHoveredStart(binStartAt(event.clientX))
        }}
        onPointerMove={(event) => {
          if (scrubbing) {
            dragTravelRef.current += Math.abs(event.clientX - lastClientXRef.current)
            lastClientXRef.current = event.clientX
          }
          setHoveredStart(binStartAt(event.clientX))
        }}
        onPointerUp={(event) => {
          event.currentTarget.releasePointerCapture(event.pointerId)
          setScrubbing(false)
        }}
        onPointerCancel={() => setScrubbing(false)}
        onPointerLeave={() => {
          if (!scrubbing) setHoveredStart(null)
        }}
        onClick={() => {
          // A sweep that travelled is a scrub, not a request to replay.
          if (dragTravelRef.current > 5) return
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
