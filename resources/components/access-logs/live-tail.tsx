/**
 * Live-tail view: prepends incoming access_log events, keeps at most
 * MAX_ROWS, auto-scrolls to top unless the pointer is over the list.
 * Rows are laid out as aligned monospace columns mirroring the access.log
 * fields (time, status, method, url, host, ip, user, bytes, req-time, ver).
 */
import { useRef, useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { Badge } from "@/components/ui/badge"
import { useLiveEvents } from "@/lib/live-feed-context"
import { formatBytes, formatDuration } from "@/lib/api"
import { cn } from "@/lib/utils"
import type { LiveEvent } from "@/lib/websocket"

const MAX_ROWS = 500

type AccessLogEvent = Extract<LiveEvent, { type: "access_log" }>["data"]

/** Tailwind classes for the status badge, by response class. */
function statusBadgeClass(code: number): string {
  if (code >= 500) return "bg-red-500/15 text-red-600 dark:text-red-400"
  if (code >= 400) return "bg-amber-500/15 text-amber-600 dark:text-amber-400"
  if (code >= 300) return "bg-sky-500/15 text-sky-600 dark:text-sky-400"
  return "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
}

/** Column layout shared by the header and every row (aligned via fixed widths). */
const COLS = "flex items-center gap-2 px-3 min-w-max"

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
    estimateSize: () => 28,
    overscan: 20,
  })

  return (
    <div className="rounded-md border">
      <div className="flex items-center justify-between px-3 py-1.5 text-xs text-muted-foreground border-b">
        <span>
          {paused ? "Paused (pointer over list)" : "Streaming"} — {rows.length} rows
          {dropped > 0 && `, ${dropped} dropped`}
        </span>
      </div>
      <div className="overflow-x-auto">
        {/* Column header — aligns with the row layout below. */}
        <div className={cn(COLS, "border-b py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground")}>
          <span className="w-20 shrink-0">Time</span>
          <span className="w-10 shrink-0">Status</span>
          <span className="w-14 shrink-0">Method</span>
          <span className="w-[220px] shrink-0">URL</span>
          <span className="w-[320px] shrink-0">Referrer</span>
          <span className="w-40 shrink-0">Host</span>
          <span className="w-32 shrink-0">IP</span>
          <span className="w-16 shrink-0">User</span>
          <span className="w-16 shrink-0 text-right">Bytes</span>
          <span className="w-16 shrink-0 text-right">Req</span>
          <span className="w-16 shrink-0">HTTP Ver</span>
          <span className="w-16 shrink-0">Country</span>
          <span className="w-16 shrink-0">City</span>
        </div>
        <div
          ref={parentRef}
          className="overflow-y-auto overflow-x-hidden font-mono text-xs"
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
        >
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index]
              return (
                <div
                  key={item.key}
                  className={cn(COLS, "absolute left-0 border-b border-border/40")}
                  style={{ top: 0, height: item.size, transform: `translateY(${item.start}px)` }}
                >
                  <span className="w-20 shrink-0 text-muted-foreground">
                    {new Date(row.timestamp).toLocaleTimeString()}
                  </span>
                  <Badge
                    className={cn("w-10 shrink-0 justify-center tabular-nums border-transparent", statusBadgeClass(row.status_code))}
                  >
                    {row.status_code}
                  </Badge>
                  <span className="w-14 shrink-0">{row.method ?? "-"}</span>
                  <span className="w-[220px] shrink-0 truncate" title={row.url ?? undefined}>
                    {row.url ?? "-"}
                  </span>
                  <span className="w-[320px] shrink-0 truncate" title={row.referrer ?? undefined}>
                    {row.referrer ?? "-"}
                  </span>
                  <span className="w-40 shrink-0 truncate" title={row.host ?? undefined}>
                    {row.host ?? "-"}
                  </span>
                  <span className="w-32 shrink-0 text-muted-foreground">{row.ip_address}</span>
                  <span className="w-16 shrink-0 truncate text-muted-foreground">{row.remote_user ?? "-"}</span>
                  <span className="w-16 shrink-0 text-right tabular-nums">{formatBytes(row.bytes_sent)}</span>
                  <span className="w-16 shrink-0 text-right tabular-nums">{formatDuration(row.request_time * 1000)}</span>
                  <span className="w-16 shrink-0 text-muted-foreground">{row.http_version ?? "-"}</span>
                  <span className="w-16 shrink-0 truncate" title={row.country_code ?? undefined}>
                    {row.country_name ?? "-"}
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
