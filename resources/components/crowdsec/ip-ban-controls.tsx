/**
 * Banned badge + ban/unban dropdown for an IP rendered in a table cell.
 * Self-contained: subscribes to the shared banned-IP set and CrowdSec
 * status (TanStack Query dedupes per-row subscriptions), so callers just
 * pass the IP. Renders nothing when the integration is off, and only the
 * badge when it is read-only (no machine credentials).
 */
import { Loader2, ShieldBan } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { toast } from "sonner"
import {
  useBanIp,
  useBannedIps,
  useCrowdsecStatus,
  useUnbanIp,
} from "@/lib/queries"
import { BAN_DURATIONS, crowdsecErrorMessage } from "@/lib/crowdsec"

/** Ban/unban dropdown on the IP cell; hidden unless machine credentials
 *  enable write access on the CrowdSec integration. */
export function IpBanAction({ ip, banned }: { ip: string; banned: boolean }) {
  const { data: status } = useCrowdsecStatus()
  const ban = useBanIp()
  const unban = useUnbanIp()
  const isPending = ban.isPending || unban.isPending
  if (!status?.write_enabled) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          className="ml-1 align-middle text-muted-foreground"
          disabled={isPending}
          title={banned ? "Unban this IP" : "Ban this IP"}
        >
          {isPending ? <Loader2 className="animate-spin" /> : <ShieldBan />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {banned ? (
          <DropdownMenuItem
            onClick={() =>
              unban.mutate(ip, {
                onError: (err) =>
                  toast.error(
                    crowdsecErrorMessage(err, `Unban failed for ${ip}; the LAPI may be unreachable.`),
                  ),
              })
            }
          >
            Unban {ip}
          </DropdownMenuItem>
        ) : (
          <>
            <DropdownMenuLabel>Ban {ip}</DropdownMenuLabel>
            {BAN_DURATIONS.map((d) => (
              <DropdownMenuItem
                key={d.value}
                onClick={() =>
                  ban.mutate(
                    { ip, duration: d.value },
                    {
                      onError: (err) =>
                        toast.error(
                          crowdsecErrorMessage(err, `Ban failed for ${ip}; the LAPI may be unreachable.`),
                        ),
                    },
                  )
                }
              >
                {d.label}
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Banned badge plus the ban/unban dropdown, driven by the shared
 *  banned-IP set. */
export function IpBanControls({ ip }: { ip: string }) {
  const { data: bannedIps } = useBannedIps()
  const banned = !!bannedIps?.has(ip)
  return (
    <>
      {banned && (
        <Badge
          variant="destructive"
          className="ml-2 align-middle"
          title="Active CrowdSec ban decision for this IP"
        >
          Banned
        </Badge>
      )}
      <IpBanAction ip={ip} banned={banned} />
    </>
  )
}
