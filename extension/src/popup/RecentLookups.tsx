import { useEffect, useState } from "react"
import { CountryFlag } from "@/components/country-flag"
import { Card } from "@/components/ui/card"
import { agoText } from "@/lib/abuseipdb"
import { getRecent, type RecentLookup } from "../lib/storage"
import { IpChip } from "./IpChip"
import type { PopupSession } from "./open-context"

/** Screen 3: the last five lookups on this server, with the marks they had then. */
export function RecentLookups({
  session,
  noTrafficHost,
  onLookup,
  version = 0,
}: {
  session: PopupSession
  /** Set only after a successful 7-day check found no requests for the tab's host. */
  noTrafficHost: string | null
  onLookup: (ip: string) => void
  /** A new value reads the list again. */
  version?: number
}) {
  const [recent, setRecent] = useState<RecentLookup[] | null>(null)
  const { origin, savedAt } = session.stored

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const items = await getRecent({ origin, savedAt })
      if (!cancelled) setRecent(items)
    })()
    return () => {
      cancelled = true
    }
  }, [origin, savedAt, version])

  const now = Date.now()
  return (
    <>
      {recent !== null && (
        <Card className="gap-0 rounded-[10px] px-3 py-3">
          <h2 className="mb-1.5 text-[11px] font-normal tracking-[.06em] text-muted-foreground uppercase">
            Recent lookups
          </h2>
          {recent.length === 0 ? (
            <p className="px-1.5 py-1 text-xs text-muted-foreground">IPs you look up show here.</p>
          ) : (
            <ul className="grid grid-cols-[minmax(0,1fr)] gap-1">
              {recent.map((lookup) => (
                <li key={lookup.ip}>
                  <button
                    type="button"
                    className="flex min-h-[26px] w-full cursor-pointer items-center gap-2 rounded-md px-1.5 py-[5px] text-left text-[12.5px] hover:bg-[var(--control-hover-bg)] focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                    onClick={() => onLookup(lookup.ip)}
                    title="Look up"
                  >
                    <CountryFlag code={lookup.countryCode} />
                    <IpChip ip={lookup.ip} mark={lookup} className="min-w-0 truncate" />
                    <span className="max-w-[60%] flex-[1_0_auto] truncate text-[11.5px] text-muted-foreground">
                      {lookup.asn !== null && `AS${lookup.asn} ${lookup.asOrganization ?? ""}`}
                    </span>
                    <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">
                      {agoText(new Date(lookup.at).toISOString(), now)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
      {noTrafficHost !== null && (
        <p className="px-2.5 pt-1.5 pb-0.5 text-center text-xs text-muted-foreground">
          No requests logged for <span className="font-mono">{noTrafficHost}</span> in the last 7
          days
        </p>
      )}
    </>
  )
}
