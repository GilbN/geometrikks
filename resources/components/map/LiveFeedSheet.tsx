/**
 * The phone reading surface. One row per request, newest first, split into
 * everything and the threat lane so scanners do not scroll past in the noise.
 */
import { useEffect, useRef, useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useLiveTrafficStore } from "@/lib/live-traffic/context"
import { PACKET_COLORS } from "@/lib/live-traffic/classify"
import type { LiveRequest } from "@/lib/live-traffic/types"
import { cn } from "@/lib/utils"

const ROW_HEIGHT = 40

export function LiveFeedSheet({
  open,
  onOpenChange,
  onSelect,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (request: LiveRequest) => void
}) {
  const store = useLiveTrafficStore()
  const [lane, setLane] = useState<"all" | "threats">("all")
  const [requests, setRequests] = useState<readonly LiveRequest[]>([])
  const listRef = useRef<HTMLDivElement>(null)

  // Only poll while the sheet is open; a closed sheet costs nothing.
  useEffect(() => {
    if (!open) return
    const tick = () => setRequests(store.getRequests())
    tick()
    const interval = window.setInterval(tick, 1000)
    return () => window.clearInterval(interval)
  }, [open, store])

  const rows = lane === "threats" ? requests.filter((request) => request.threat) : requests
  const threatCount = requests.filter((request) => request.threat).length

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  })

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader className="pb-2">
          <DrawerTitle>Live requests</DrawerTitle>
          <DrawerDescription className="sr-only">
            Requests arriving now, with a separate lane for 4xx responses and banned IPs.
          </DrawerDescription>
        </DrawerHeader>
        <div className="px-4 pb-2">
          <Tabs value={lane} onValueChange={(value) => setLane(value as "all" | "threats")}>
            <TabsList className="w-full">
              <TabsTrigger value="all" className="flex-1">
                All {requests.length}
              </TabsTrigger>
              <TabsTrigger value="threats" className="flex-1">
                Threats {threatCount}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        <div ref={listRef} className="h-[45vh] overflow-y-auto overscroll-contain px-4 pb-6">
          {rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
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
                    onClick={() => {
                      onSelect(request)
                      onOpenChange(false)
                    }}
                    className={cn(
                      "absolute left-0 flex w-full items-center gap-2 border-b border-border/40 px-1 text-left text-xs",
                      request.threat && "bg-red-500/5",
                    )}
                    style={{ top: 0, height: item.size, transform: `translateY(${item.start}px)` }}
                  >
                    <span
                      className="rounded px-1 font-mono text-[10px] font-bold"
                      style={{
                        background: `${PACKET_COLORS[request.statusClass]}28`,
                        color: PACKET_COLORS[request.statusClass],
                      }}
                    >
                      {request.log?.status_code ?? "?"}
                    </span>
                    <span className="flex-1 truncate font-mono">
                      {request.log?.url ?? request.ip}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {request.countryCode ?? request.city ?? ""}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  )
}
