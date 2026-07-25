/**
 * The phone reading surface: the same summary and feed the desktop rail
 * carries, in a sheet the vitals pill opens. Parity is the point - what you
 * learn on one surface you can find in the same order on the other.
 */
import { useState } from "react"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
import { useLiveWindow } from "@/lib/live-traffic/context"
import { formatNumber } from "@/lib/api"
import { LiveSummary } from "./LiveSummary"
import { LiveFeedList, LiveFeedTabs, type FeedLane } from "./LiveFeedList"
import type { LiveRequest } from "@/lib/live-traffic/types"

export function LiveFeedSheet({
  open,
  onOpenChange,
  onSelect,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (request: LiveRequest) => void
}) {
  // A closed sheet should not pay for a snapshot it will not render.
  const { requests, summary } = useLiveWindow(open)
  const [lane, setLane] = useState<FeedLane>("all")
  const rows = lane === "threats" ? requests.filter((request) => request.threat) : requests

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      {/* A fixed height rather than the default auto: the feed is the point of
          this sheet, and an auto-height drawer leaves the list whatever the
          summary does not use, which is a row or two on a short phone. */}
      <DrawerContent className="h-[80vh]">
        <DrawerHeader className="pb-2">
          <DrawerTitle>Live traffic</DrawerTitle>
          <DrawerDescription className="sr-only">
            Requests arriving now, with a separate lane for refused requests and banned IPs.
          </DrawerDescription>
        </DrawerHeader>

        <div className="shrink-0 px-4 pb-3">
          <LiveSummary summary={summary} dense />
        </div>

        <div className="shrink-0 px-4 pb-2">
          <LiveFeedTabs
            lane={lane}
            onLaneChange={setLane}
            total={summary.total}
            threats={summary.threats}
            size="touch"
          />
        </div>

        <LiveFeedList
          rows={rows}
          lane={lane}
          onSelect={(request) => {
            onSelect(request)
            onOpenChange(false)
          }}
          size="touch"
          className="min-h-0 flex-1 px-4"
        />

        {summary.bannedIps > 0 && (
          <div className="shrink-0 border-t px-4 py-2 text-[11px] text-red-400">
            Banned, {formatNumber(summary.bannedIps)}{" "}
            {summary.bannedIps === 1 ? "IP" : "IPs"} in this window
          </div>
        )}
      </DrawerContent>
    </Drawer>
  )
}
