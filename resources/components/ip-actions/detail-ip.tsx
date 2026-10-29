/**
 * The IP of a record sheet: a block at the top of the body with the IP, its
 * decision, location and network, and footer actions that inspect it, show
 * it on the map, or open the IP actions menu for the rest.
 */
import { useNavigate } from "@tanstack/react-router"
import { LocateFixed, ScanSearch } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DecisionBadge } from "@/components/crowdsec/decision-badge"
import { CopyIpButton, IpActionsMenu, IpContext } from "@/components/ip-actions/ip-actions-menu"
import type { IpRowValues } from "@/lib/ip-filter-targets"
import { useIpInspectorActions } from "@/lib/ip-inspector"
import { flyToSearch } from "@/lib/map-filters"
import { useBannedIps } from "@/lib/queries"

/** Sits first in a DetailSheet body; the negative margins take it to the
 *  body's edges so its rule meets the sheet's sides. */
export function DetailIpBlock({ values, children }: { values: IpRowValues; children?: React.ReactNode }) {
  const { data: bannedIps } = useBannedIps()
  const decision = bannedIps?.get(values.ip) ?? null
  return (
    <div className="-mx-4 -mt-4 mb-2 border-b border-border/50 px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 break-all font-mono text-xl">{values.ip}</span>
        {decision !== null && <DecisionBadge type={decision} />}
        <span className="ml-auto flex shrink-0 items-center">
          {children}
          <CopyIpButton ip={values.ip} />
        </span>
      </div>
      <div className="mt-1 flex flex-col gap-0.5 text-sm text-muted-foreground">
        <IpContext values={values} decision={decision} wrap />
      </div>
    </div>
  )
}

/** Footer row for a DetailSheet. `onNavigate` closes the sheet; the inspector
 *  and the map both take over from it. */
export function DetailIpActions({
  values,
  locationId,
  showOnMap = true,
  onNavigate,
}: {
  values: IpRowValues
  /** Where the inspector starts and where Show on map lands. */
  locationId?: number
  showOnMap?: boolean
  onNavigate: () => void
}) {
  const { open: inspect } = useIpInspectorActions()
  const navigate = useNavigate()
  return (
    <div className="flex gap-2">
      <Button
        variant="outline"
        size="lg"
        className="min-w-0 flex-1"
        onClick={() => {
          inspect(values.ip, locationId)
          onNavigate()
        }}
      >
        <ScanSearch data-icon="inline-start" />
        <span className="truncate">Inspect IP</span>
      </Button>
      {showOnMap && (
        <Button
          variant="outline"
          size="lg"
          className="min-w-0 flex-1"
          onClick={() => {
            void navigate({
              to: "/map",
              search: (prev: Record<string, unknown>) => ({ ...prev, ...flyToSearch(values.ip, locationId) }),
            })
            onNavigate()
          }}
        >
          <LocateFixed data-icon="inline-start" />
          <span className="truncate">Show on map</span>
        </Button>
      )}
      <IpActionsMenu {...values} locationId={locationId} footer onFilter={onNavigate} />
    </div>
  )
}
