/**
 * Live-tail view: prepends incoming access_log events, keeps at most
 * MAX_ROWS, auto-scrolls to top unless the pointer is over the list.
 */
import { useRef, useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { Badge } from "@/components/ui/badge"
import { useLiveEvents } from "@/lib/live-feed-context"
import type { LiveEvent } from "@/lib/websocket"

const MAX_ROWS = 500

type AccessLogEvent = Extract<LiveEvent, { type: "access_log" }>["data"]

export function LiveTail({ enabled }: { enabled: boolean }) {
  const [rows, setRows] = useState<AccessLogEvent[]>([])
  const [dropped, setDropped] = useState(0)
  const [paused, setPaused] = useState(false)
  const parentRef = useRef<HTMLDivElement>(null)

  useLiveEvents((events, droppedCount) => {
    if (paused) return
    const logs = events
      .filter((e): e is Extract<LiveEvent, { type: "access_log" }> => e.type === "access_log")
      .map((e) => e.data)
    if (logs.length === 0 && droppedCount === 0) return
    setRows((prev) => [...logs.reverse(), ...prev].slice(0, MAX_ROWS))
    if (droppedCount) setDropped((d) => d + droppedCount)
    parentRef.current?.scrollTo({ top: 0 })
  }, enabled)

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 32,
    overscan: 20,
  })

  return (
    <div className="rounded-md border">
      <div className="flex items-center justify-between px-3 py-1.5 text-xs text-muted-foreground border-b">
        <span>{paused ? "Paused (pointer over list)" : "Streaming"} — {rows.length} rows{dropped > 0 && `, ${dropped} dropped`}</span>
      </div>
      <div
        ref={parentRef}
        className="h-[600px] overflow-auto font-mono text-xs"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
      >
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index]
            return (
              <div
                key={item.key}
                className="absolute left-0 w-full flex items-center gap-2 px-3 border-b border-border/40"
                style={{ top: 0, height: item.size, transform: `translateY(${item.start}px)` }}
              >
                <span className="text-muted-foreground shrink-0">
                  {new Date(row.timestamp).toLocaleTimeString()}
                </span>
                <Badge
                  variant={row.status_code >= 500 ? "destructive" : row.status_code >= 400 ? "outline" : "secondary"}
                  className="tabular-nums shrink-0"
                >
                  {row.status_code}
                </Badge>
                <span className="shrink-0 w-12">{row.method ?? "-"}</span>
                <span className="truncate flex-1">{row.url ?? "-"}</span>
                <span className="text-muted-foreground shrink-0">{row.ip_address}</span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
