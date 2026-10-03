/**
 * The phone reading surface: the same summary and feed the desktop rail
 * carries, in a sheet the vitals pill opens. Parity is the point - what you
 * learn on one surface you can find in the same order on the other.
 */
import { useState } from "react"
import { usePhoneSheetDirection } from "@/hooks/use-mobile"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
import { useLiveWindow } from "@/lib/live-traffic/context"
import { describeDecisions } from "@/lib/live-traffic/summary"
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
  const decisions = describeDecisions(summary.decisions)
  const direction = usePhoneSheetDirection()

  const summaryBlock = <LiveSummary summary={summary} dense />
  const tabs = (
    <LiveFeedTabs
      lane={lane}
      onLaneChange={setLane}
      total={summary.total}
      threats={summary.threats}
      size="touch"
    />
  )
  const list = (
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
  )
  const decisionsLine = decisions && (
    <div className="shrink-0 border-t px-4 py-2 text-[11px] text-red-400">
      {decisions} in this window
    </div>
  )

  return (
    <Drawer open={open} onOpenChange={onOpenChange} direction={direction}>
      {/* A fixed height rather than the default auto: the feed is the point of
          this sheet, and an auto-height drawer leaves the list whatever the
          summary does not use, which is a row or two on a short phone. A side
          sheet is already full height, and wider than the default so the
          summary can sit beside the feed. */}
      <DrawerContent className="data-[vaul-drawer-direction=bottom]:h-[80vh] data-[vaul-drawer-direction=right]:sm:max-w-2xl">
        <DrawerHeader className="pb-2">
          <DrawerTitle>Live traffic</DrawerTitle>
          <DrawerDescription className="sr-only">
            Requests arriving now, with a separate lane for refused requests and banned IPs.
          </DrawerDescription>
        </DrawerHeader>

        {direction === "right" ? (
          // Landscape is short, so stacking the summary above the feed would
          // leave the list a couple of rows. Side by side, the feed gets the
          // full height.
          <div className="flex min-h-0 flex-1">
            <div className="w-56 shrink-0 overflow-y-auto overscroll-contain pb-3 pl-4">
              {summaryBlock}
            </div>
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="shrink-0 px-4 pb-2">{tabs}</div>
              {list}
              {decisionsLine}
            </div>
          </div>
        ) : (
          <>
            <div className="shrink-0 px-4 pb-3">{summaryBlock}</div>
            <div className="shrink-0 px-4 pb-2">{tabs}</div>
            {list}
            {decisionsLine}
          </>
        )}
      </DrawerContent>
    </Drawer>
  )
}
