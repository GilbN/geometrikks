/**
 * Five minutes of traffic as a seismograph. Bar height is requests in that
 * second, colour is the worst status it contained, and a red cap marks a
 * second that included a banned IP.
 *
 * Canvas rather than 300 SVG nodes: the whole strip is redrawn every second.
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { useLiveBuckets, useLiveTrafficStore } from "@/lib/live-traffic/context"
import { BANNED_RING_COLOR, PACKET_COLORS } from "@/lib/live-traffic/classify"
import type { LiveRequest, SecondBucket } from "@/lib/live-traffic/types"

const HEIGHT = 46
const BAR_GAP = 1

/** The one request in a second most worth showing: banned, then 4xx, then 5xx, then newest. */
function notableRequest(bucket: SecondBucket, lookup: (id: string) => LiveRequest | undefined) {
  const requests = bucket.requestIds.map(lookup).filter((r): r is LiveRequest => r !== undefined)
  return (
    requests.find((r) => r.banned) ??
    requests.find((r) => r.statusClass === "4xx") ??
    requests.find((r) => r.statusClass === "5xx") ??
    requests.at(-1)
  )
}

function draw(canvas: HTMLCanvasElement, buckets: SecondBucket[], hovered: number | null): void {
  const context = canvas.getContext("2d")
  if (!context || buckets.length === 0) return

  const ratio = window.devicePixelRatio || 1
  const width = canvas.clientWidth
  canvas.width = width * ratio
  canvas.height = HEIGHT * ratio
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  context.clearRect(0, 0, width, HEIGHT)

  const barWidth = Math.max(1, width / buckets.length - BAR_GAP)
  const peak = Math.max(1, ...buckets.map((bucket) => bucket.total))

  buckets.forEach((bucket, index) => {
    const x = (index * width) / buckets.length
    if (index === hovered) {
      context.fillStyle = "rgba(34, 211, 238, 0.14)"
      context.fillRect(x - BAR_GAP, 0, barWidth + BAR_GAP * 2, HEIGHT)
    }
    if (bucket.total === 0) return

    const barHeight = Math.max(2, (bucket.total / peak) * HEIGHT)
    context.fillStyle = PACKET_COLORS[bucket.worstStatus]
    context.fillRect(x, HEIGHT - barHeight, barWidth, barHeight)

    if (bucket.banned > 0) {
      context.fillStyle = BANNED_RING_COLOR
      context.fillRect(x, HEIGHT - barHeight, barWidth, 2)
    }
  })
}

export function LiveWire({ onSelect }: { onSelect: (request: LiveRequest) => void }) {
  const buckets = useLiveBuckets()
  const store = useLiveTrafficStore()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [hovered, setHovered] = useState<number | null>(null)

  useEffect(() => {
    if (canvasRef.current) draw(canvasRef.current, buckets, hovered)
  }, [buckets, hovered])

  const bucketAt = useCallback(
    (clientX: number): number | null => {
      const canvas = canvasRef.current
      if (!canvas || buckets.length === 0) return null
      const rect = canvas.getBoundingClientRect()
      const index = Math.floor(((clientX - rect.left) / rect.width) * buckets.length)
      return index >= 0 && index < buckets.length ? index : null
    },
    [buckets.length],
  )

  const hoveredBucket = hovered === null ? null : buckets[hovered]
  const hoveredRequest =
    hoveredBucket && hoveredBucket.total > 0
      ? notableRequest(hoveredBucket, (id) => store.getRequest(id))
      : undefined

  return (
    <div className="pointer-events-auto rounded-md border bg-background/85 px-2 py-1.5 backdrop-blur">
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
        aria-label="Requests per second over the last five minutes"
        onMouseMove={(event) => setHovered(bucketAt(event.clientX))}
        onMouseLeave={() => setHovered(null)}
        onClick={() => {
          if (hoveredRequest) onSelect(hoveredRequest)
        }}
      />
      <div className="flex justify-between px-0.5 text-[9px] text-muted-foreground">
        <span>Bar height is requests per second, colour is the worst status</span>
        {hoveredRequest ? (
          <span className="font-mono">
            {hoveredRequest.log?.status_code ?? "?"} {hoveredRequest.log?.url ?? hoveredRequest.ip}
          </span>
        ) : (
          <span>{buckets.reduce((total, bucket) => total + bucket.threats, 0)} threats</span>
        )}
      </div>
    </div>
  )
}
