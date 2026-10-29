/**
 * Ban/unban dropdown for one IP, used by the IP inspector. Subscribes to
 * the CrowdSec status, so callers pass only the IP and whether it is banned.
 */
import { useState } from "react"
import { Loader2, ShieldBan } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { BanIpDialog } from "@/components/security/ban-ip-dialog"
import { toast } from "sonner"
import {
  useBanIp,
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
  const [dialogOpen, setDialogOpen] = useState(false)
  const isPending = ban.isPending || unban.isPending
  if (!status?.writeEnabled) return null
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className="ml-1 align-middle text-muted-foreground pointer-coarse:min-h-8 pointer-coarse:min-w-8"
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
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setDialogOpen(true)}>More options…</DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <BanIpDialog open={dialogOpen} onOpenChange={setDialogOpen} initialIp={ip} />
    </>
  )
}
