/**
 * The four most recent requests, newest on top, fading out as they age.
 * Errors and banned IPs linger longer, because they are the ones worth
 * catching before they scroll away.
 */
import { useEffect, useRef, useState } from "react"
import { useLiveStrips } from "@/lib/live-traffic/context"
import { PACKET_COLORS } from "@/lib/live-traffic/classify"
import type { LiveRequest } from "@/lib/live-traffic/types"
import { cn } from "@/lib/utils"

const ORDINARY_LIFETIME_MS = 8000
const NOTABLE_LIFETIME_MS = 12000
const MAX_STRIPS = 4

function lifetime(request: LiveRequest): number {
  return request.threat || request.statusClass === "5xx"
    ? NOTABLE_LIFETIME_MS
    : ORDINARY_LIFETIME_MS
}

export function LiveStrips({ onSelect }: { onSelect: (request: LiveRequest) => void }) {
  const strips = useLiveStrips(MAX_STRIPS)
  const [now, setNow] = useState(() => Date.now())
  const reducedMotion = useRef(false)

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)")
    const update = () => {
      reducedMotion.current = media.matches
    }
    update()
    media.addEventListener("change", update)
    return () => media.removeEventListener("change", update)
  }, [])

  // One clock for the whole stack; strips only need to fade, not animate.
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(interval)
  }, [])

  const visible = strips.filter((request) => now - request.receivedAt < lifetime(request))
  if (visible.length === 0) return null

  return (
    <div className="pointer-events-none flex w-[min(340px,calc(100vw-8rem))] flex-col gap-1">
      {visible.map((request) => {
        const age = (now - request.receivedAt) / lifetime(request)
        const opacity = reducedMotion.current ? 1 : Math.max(0.25, 1 - age)
        return (
          <button
            key={request.id}
            type="button"
            onClick={() => onSelect(request)}
            style={{ opacity }}
            className={cn(
              "pointer-events-auto flex items-center gap-2 rounded-md border bg-background/80 px-2 py-1",
              "text-left text-[11px] backdrop-blur transition-opacity hover:bg-accent/60",
              request.threat ? "border-red-500/40" : "border-border",
            )}
          >
            <span
              className="rounded px-1 font-mono text-[10px] font-bold"
              style={{ background: `${PACKET_COLORS[request.statusClass]}28`, color: PACKET_COLORS[request.statusClass] }}
            >
              {request.log?.status_code ?? "?"}
            </span>
            <span className="text-muted-foreground">{request.log?.method ?? "-"}</span>
            <span className="flex-1 truncate font-mono">{request.log?.url ?? request.ip}</span>
            <span className="shrink-0 text-muted-foreground">
              {request.countryCode ?? request.city ?? ""}
            </span>
          </button>
        )
      })}
    </div>
  )
}
