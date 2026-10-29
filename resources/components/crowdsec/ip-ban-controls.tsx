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
import { useCrowdsecStatus } from "@/lib/queries"
import { BAN_DURATIONS } from "@/lib/crowdsec"
import { undoIpAction, useIpActions, usePendingIpAction } from "@/lib/pending-ip-actions"

/** Ban/unban dropdown on the IP cell; hidden unless machine credentials
 *  enable write access on the CrowdSec integration. */
export function IpBanAction({ ip, banned }: { ip: string; banned: boolean }) {
  const { data: status } = useCrowdsecStatus()
  const { ban, unban } = useIpActions()
  const [dialogOpen, setDialogOpen] = useState(false)
  const pending = usePendingIpAction(ip)
  const isPending = pending !== null
  // Waiting, not sent yet: the menu offers Undo instead of ban and unban.
  const waiting = pending !== null && !pending.sending
  if (!status?.writeEnabled) return null
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className="ml-1 align-middle text-muted-foreground pointer-coarse:min-h-8 pointer-coarse:min-w-8"
            disabled={isPending && !waiting}
            title={banned ? "Unban this IP" : "Ban this IP"}
          >
            {isPending ? <Loader2 className="animate-spin" /> : <ShieldBan />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {waiting ? (
            <DropdownMenuItem onClick={() => undoIpAction(ip)}>
              {pending.action.kind === "ban" ? "Undo ban" : "Undo unban"}
            </DropdownMenuItem>
          ) : banned ? (
            <DropdownMenuItem onClick={() => unban(ip)}>
              Unban {ip}
            </DropdownMenuItem>
          ) : (
            <>
              <DropdownMenuLabel>Ban {ip}</DropdownMenuLabel>
              {BAN_DURATIONS.map((d) => (
                <DropdownMenuItem key={d.value} onClick={() => ban(ip, d.value, d.label)}>
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
