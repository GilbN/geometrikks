import { useNavigate } from "@tanstack/react-router"
import { LocateFixed } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { formatNumber } from "@/lib/api"
import { useIpInspector } from "@/lib/ip-inspector"
import { useIpLocations } from "@/lib/queries"

/** Every location this IP resolved to, minus the one the sheet was opened
 *  from. "Fly to" lands on the map with that location's popup open. */
export function IpLocationsBlock({ ip }: { ip: string }) {
  const { originLocationId } = useIpInspector()
  const navigate = useNavigate()
  const { data, isLoading } = useIpLocations(ip)
  const rows = (data?.items ?? []).filter((r) => r.locationId !== originLocationId)
  if (!isLoading && rows.length === 0) return null
  return (
    <section className="space-y-1">
      <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Also seen from</h3>
      {isLoading && <Skeleton className="h-10 w-full" />}
      <ul className="space-y-0.5">
        {rows.map((r) => (
          <li key={r.locationId} className="flex items-center justify-between gap-2 text-xs">
            <span className="min-w-0 truncate">{r.city ?? r.countryName}, {r.countryCode}</span>
            <span className="flex shrink-0 items-center gap-1 tabular-nums text-muted-foreground">
              {formatNumber(r.eventCount)}
              <Button
                variant="ghost"
                size="icon-xs"
                title="Fly to on the map"
                aria-label={`Fly to ${r.city ?? r.countryName}`}
                onClick={() =>
                  void navigate({
                    to: "/map",
                    search: { inspect: ip, focus: r.locationId, sources: undefined, countries: undefined, cities: undefined },
                  })
                }
              >
                <LocateFixed />
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
