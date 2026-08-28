import { DetailSheet } from "@/components/data/detail-sheet"
import { isValidIp } from "@/lib/crowdsec"
import { useIpInspector } from "@/lib/ip-inspector"
import { useTimeRange } from "@/lib/time-range-context"
import { rangeSubtitle } from "@/lib/time-range-labels"

export function IpInspectorSheet() {
  const { ip, close } = useIpInspector()
  const { range } = useTimeRange()
  const open = ip !== undefined
  const valid = open && isValidIp(ip)

  return (
    <DetailSheet
      open={open}
      onOpenChange={(next) => !next && close()}
      title={ip ?? ""}
      description={valid ? rangeSubtitle(range) : "Not a valid IP address"}
      className="sm:w-[min(36rem,100vw)] sm:max-w-xl"
    >
      {valid ? (
        <p className="text-sm text-muted-foreground">Profile blocks arrive in the next tasks.</p>
      ) : (
        <p className="text-sm text-muted-foreground">Not a valid IP address.</p>
      )}
    </DetailSheet>
  )
}
