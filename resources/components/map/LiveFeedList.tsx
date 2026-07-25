/**
 * The feed half of the live surfaces: every request in the window, newest
 * first, with threats on their own lane so scanners do not scroll past in the
 * noise. Shared by the desktop rail and the phone sheet.
 *
 * Virtualised because the window holds up to a couple of thousand rows and
 * both surfaces keep the list mounted while traffic arrives.
 */
import { useEffect, useRef } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PACKET_COLORS } from "@/lib/live-traffic/classify"
import { formatNumber } from "@/lib/api"
import { cn } from "@/lib/utils"
import type { LiveRequest } from "@/lib/live-traffic/types"

export type FeedLane = "all" | "threats"

export function LiveFeedTabs({
  lane,
  onLaneChange,
  total,
  threats,
  size = "compact",
}: {
  lane: FeedLane
  onLaneChange: (lane: FeedLane) => void
  total: number
  threats: number
  size?: "compact" | "touch"
}) {
  return (
    <Tabs value={lane} onValueChange={(value) => onLaneChange(value as FeedLane)}>
      <TabsList className={cn("w-full", size === "compact" ? "h-7" : "pointer-coarse:h-10")}>
        <TabsTrigger value="all" className={cn("flex-1", size === "compact" && "text-[11px]")}>
          All {formatNumber(total)}
        </TabsTrigger>
        <TabsTrigger value="threats" className={cn("flex-1", size === "compact" && "text-[11px]")}>
          Threats {formatNumber(threats)}
        </TabsTrigger>
      </TabsList>
    </Tabs>
  )
}

export function LiveFeedList({
  rows,
  lane,
  onSelect,
  size = "compact",
  className,
}: {
  rows: readonly LiveRequest[]
  lane: FeedLane
  onSelect: (request: LiveRequest) => void
  /** "touch" gives phone-sized rows and legible type; "compact" suits the rail. */
  size?: "compact" | "touch"
  className?: string
}) {
  const touch = size === "touch"
  const rowHeight = touch ? 46 : 34
  const listRef = useRef<HTMLDivElement>(null)

  // Switching lanes swaps in a much shorter list; keeping the old scrollTop
  // can land the container past the new content, reading as blank. Reset on
  // lane change only, so it never fights new rows arriving at the top.
  useEffect(() => {
    listRef.current?.scrollTo({ top: 0 })
  }, [lane])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => rowHeight,
    overscan: 10,
  })

  return (
    <div ref={listRef} className={cn("overflow-y-auto overscroll-contain", className)}>
      {rows.length === 0 ? (
        <p className={cn("px-1 py-6 text-center text-muted-foreground", touch ? "text-sm" : "text-[11px]")}>
          {lane === "threats" ? "No threats yet." : "Waiting for traffic."}
        </p>
      ) : (
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((item) => {
            const request = rows[item.index]
            return (
              <button
                key={request.id}
                type="button"
                onClick={() => onSelect(request)}
                className={cn(
                  "absolute left-0 flex w-full flex-col justify-center gap-0.5 px-1 text-left",
                  // A neutral wash, not the cyan accent: the accent is bright
                  // enough in dark mode to swallow the row's own text.
                  "border-b border-border/30 hover:bg-foreground/[0.07]",
                  request.threat && "bg-red-500/5",
                )}
                style={{ top: 0, height: item.size, transform: `translateY(${item.start}px)` }}
              >
                <span className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      "rounded px-1 font-mono font-bold",
                      touch ? "text-[10px]" : "text-[9px]",
                    )}
                    style={{
                      background: `${PACKET_COLORS[request.statusClass]}28`,
                      color: PACKET_COLORS[request.statusClass],
                    }}
                  >
                    {request.log?.status_code ?? "?"}
                  </span>
                  <span className={cn("flex-1 truncate font-mono", touch ? "text-xs" : "text-[10px]")}>
                    {request.log?.url ?? request.ip}
                  </span>
                </span>
                <span
                  className={cn(
                    "truncate pl-0.5 text-muted-foreground",
                    touch ? "text-[10px]" : "text-[9px]",
                  )}
                >
                  {[request.city, request.countryCode].filter(Boolean).join(", ") || request.ip}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
