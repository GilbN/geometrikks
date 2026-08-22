/**
 * The desktop live surface: a glass column over the map's left edge carrying
 * the whole live picture. Rate and trend on top, then how the responses split,
 * then where they come from, then the feed with threats on their own lane.
 *
 * It floats rather than docks so the map still runs edge to edge behind it,
 * matching the controls panel and the popups. Its height is bounded: the
 * summary stays put and the feed scrolls inside the rail.
 */
import { useState } from "react"
import { useLiveWindow } from "@/lib/live-traffic/context"
import { formatNumber } from "@/lib/api"
import { LiveSummary } from "./LiveSummary"
import { LiveFeedList, LiveFeedTabs, type FeedLane } from "./LiveFeedList"
import type { LiveRequest } from "@/lib/live-traffic/types"
import { MapOverlay } from "./MapOverlay"

export function LiveRail({ onSelect }: { onSelect: (request: LiveRequest) => void }) {
  const { requests, summary } = useLiveWindow()
  const [lane, setLane] = useState<FeedLane>("all")
  const rows = lane === "threats" ? requests.filter((request) => request.threat) : requests

  return (
    <MapOverlay placement="top-left" role="complementary" aria-label="Live traffic" className="w-60">
      <div className="px-3 pt-3">
        <LiveSummary summary={summary} />
      </div>

      <div className="px-3 pb-2 pt-3">
        <LiveFeedTabs
          lane={lane}
          onLaneChange={setLane}
          total={summary.total}
          threats={summary.threats}
        />
      </div>

      <LiveFeedList
        rows={rows}
        lane={lane}
        onSelect={onSelect}
        className="min-h-0 flex-1 px-2"
      />

      {summary.bannedIps > 0 && (
        <div className="border-t px-3 py-1.5 text-[10px] text-red-400">
          Banned, {formatNumber(summary.bannedIps)}{" "}
          {summary.bannedIps === 1 ? "IP" : "IPs"} in this window
        </div>
      )}
    </MapOverlay>
  )
}
