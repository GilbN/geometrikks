/**
 * Live-tail view: prepends incoming access-log rows, keeps at most
 * MAX_ROWS, auto-scrolls to top unless the pointer is over the list.
 * Rows are laid out as aligned monospace columns mirroring the access.log
 * fields (time, status, method, url, host, ip, user, bytes, req-time, ver).
 */
import { useEffect, useRef, useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { Pause, Play } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useMediaQuery } from "@/hooks/use-media-query"
import { useLiveEvents } from "@/lib/live-feed-context"
import { formatBytes } from "@/lib/api"
import { statusBadgeClass } from "@/lib/status-badge"
import { formatDurationOrNa } from "@/lib/timing"
import { cn } from "@/lib/utils"
import type { AccessLogData } from "@/lib/websocket"

const MAX_ROWS = 500

/** Column layout shared by the header and every row (aligned via fixed widths). */
const COLS = "flex items-center gap-2 px-3 min-w-max"

export function LiveTail({ enabled }: { enabled: boolean }) {
  const [rows, setRows] = useState<AccessLogData[]>([])
  const [dropped, setDropped] = useState(0)
  // Two pause sources: the explicit button (all devices) and hover (devices
  // with a real hover; touch emits sticky synthetic mouseenter on tap).
  const [manuallyPaused, setManuallyPaused] = useState(false)
  const [hoverPaused, setHoverPaused] = useState(false)
  const canHover = useMediaQuery("(hover: hover)")
  const paused = manuallyPaused || (canHover && hoverPaused)
  // Events received while paused: buffered (newest first, capped) and merged
  // on resume so the visible list stays still but nothing is lost.
  const pausedBufferRef = useRef<AccessLogData[]>([])
  const [pausedCount, setPausedCount] = useState(0)
  const parentRef = useRef<HTMLDivElement>(null)

  useLiveEvents((events, droppedCount) => {
    const logs = events.flatMap((e) => (e.log ? [e.log] : []))
    if (logs.length === 0 && droppedCount === 0) return
    if (droppedCount) setDropped((d) => d + droppedCount)
    if (paused) {
      pausedBufferRef.current = [...logs.reverse(), ...pausedBufferRef.current].slice(0, MAX_ROWS)
      setPausedCount(pausedBufferRef.current.length)
      return
    }
    setRows((prev) => [...logs.reverse(), ...prev].slice(0, MAX_ROWS))
    parentRef.current?.scrollTo({ top: 0 })
  }, enabled)

  useEffect(() => {
    if (paused || pausedBufferRef.current.length === 0) return
    const buffered = pausedBufferRef.current
    pausedBufferRef.current = []
    setPausedCount(0)
    setRows((prev) => [...buffered, ...prev].slice(0, MAX_ROWS))
    parentRef.current?.scrollTo({ top: 0 })
  }, [paused])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 28,
    overscan: 20,
  })

  return (
    <div className="rounded-md border">
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs text-muted-foreground border-b">
        <span>
          {paused
            ? manuallyPaused
              ? "Paused"
              : "Paused (pointer over list)"
            : "Streaming"}
          {" - "}
          {rows.length} rows
          {pausedCount > 0 && `, +${pausedCount} while paused`}
          {dropped > 0 && `, ${dropped} dropped`}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="h-7 pointer-coarse:h-10"
          onClick={() => setManuallyPaused((p) => !p)}
        >
          {manuallyPaused ? (
            <>
              <Play className="h-3.5 w-3.5" /> Resume
            </>
          ) : (
            <>
              <Pause className="h-3.5 w-3.5" /> Pause
            </>
          )}
        </Button>
      </div>
      {/* One scroll element for both axes: the header and the rows share it, so
          a sideways scroll carries every column. Rows stay in normal flow
          (offset by a single translate) rather than absolutely positioned, or
          they would never widen the container past the viewport. */}
      <div
        ref={parentRef}
        className="max-h-[70dvh] overflow-auto font-mono text-xs"
        onMouseEnter={() => canHover && setHoverPaused(true)}
        onMouseLeave={() => setHoverPaused(false)}
      >
        <div className={cn(COLS, "sticky top-0 z-10 border-b bg-card py-1.5 font-sans text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground")}>
          <span className="w-20 shrink-0">Time</span>
          <span className="w-14 shrink-0">Status</span>
          <span className="w-14 shrink-0">Method</span>
          <span className="w-[220px] shrink-0">URL</span>
          <span className="hidden w-[320px] shrink-0 md:block">Referrer</span>
          <span className="w-40 shrink-0">Host</span>
          <span className="w-32 shrink-0">IP</span>
          <span className="hidden w-16 shrink-0 md:block">User</span>
          <span className="w-16 shrink-0 text-right">Bytes</span>
          <span className="w-16 shrink-0 text-right">Req</span>
          <span className="hidden w-16 shrink-0 md:block">HTTP Ver</span>
          <span className="w-16 shrink-0">Country</span>
          <span className="w-16 shrink-0">City</span>
        </div>
        <div style={{ height: virtualizer.getTotalSize() }} className="min-w-max">
          <div style={{ transform: `translateY(${virtualizer.getVirtualItems()[0]?.start ?? 0}px)` }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index]
              return (
                <div
                  key={item.key}
                  className={cn(COLS, "border-b border-border/40")}
                  style={{ height: item.size }}
                >
                  <span className="w-20 shrink-0 text-muted-foreground">
                    {new Date(row.timestamp).toLocaleTimeString()}
                  </span>
                  <span className="w-14 shrink-0">
                    <Badge
                      className={cn("w-10 justify-center tabular-nums border-transparent", statusBadgeClass(row.status_code))}
                    >
                      {row.status_code}
                    </Badge>
                  </span>
                  <span className="w-14 shrink-0">{row.method ?? "-"}</span>
                  <span className="w-[220px] shrink-0 truncate" title={row.url ?? undefined}>
                    {row.url ?? "-"}
                  </span>
                  <span className="hidden w-[320px] shrink-0 truncate md:block" title={row.referrer ?? undefined}>
                    {row.referrer ?? "-"}
                  </span>
                  <span className="w-40 shrink-0 truncate" title={row.host ?? undefined}>
                    {row.host ?? "-"}
                  </span>
                  <span className="w-32 shrink-0 text-muted-foreground">{row.ip_address}</span>
                  <span className="hidden w-16 shrink-0 truncate text-muted-foreground md:block">{row.remote_user ?? "-"}</span>
                  <span className="w-16 shrink-0 text-right tabular-nums">{formatBytes(row.bytes_sent)}</span>
                  <span className="w-16 shrink-0 text-right tabular-nums">{formatDurationOrNa(row.request_time)}</span>
                  <span className="hidden w-16 shrink-0 text-muted-foreground md:block">{row.http_version ?? "-"}</span>
                  <span className="w-16 shrink-0 truncate" title={row.country_code ?? undefined}>
                    {row.country_name ?? row.country_code ?? "-"}
                  </span>
                  <span className="w-16 shrink-0 truncate" title={row.city ?? undefined}>
                    {row.city ?? "-"}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
