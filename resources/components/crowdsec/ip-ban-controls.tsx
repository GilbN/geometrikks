/**
 * The IP inspector's ban and unban button. Desktop gets a dropdown. A phone
 * gets the ban drawer that the map panels and the IP menu use. It reads the
 * CrowdSec status itself, so callers pass only the IP and its decision.
 */
import { useEffect, useRef, useState } from "react"
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
import { BanDrawer } from "@/components/map/PanelBanButton"
import { BanIpDialog } from "@/components/security/ban-ip-dialog"
import { usePhoneDrawer } from "@/hooks/use-phone-drawer"
import { useCrowdsecStatus } from "@/lib/queries"
import { BAN_DURATIONS } from "@/lib/crowdsec"
import { undoIpAction, useIpActions, usePendingIpAction } from "@/lib/pending-ip-actions"

/** Hidden unless machine credentials enable write access on the CrowdSec
 *  integration. `decision` is the type of the IP's decision, or null. */
export function IpBanAction({ ip, decision }: { ip: string; decision: string | null }) {
  const { data: status } = useCrowdsecStatus()
  const { ban, unban } = useIpActions()
  const [menuOpen, setMenuOpen] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const drawer = usePhoneDrawer("ip-ban", menuOpen, () => setMenuOpen(false))
  // The ban dialog opens once the drawer has finished closing. Opened during
  // its close animation, it leaves pointer-events: none on the body.
  const openDialogAfterClose = useRef(false)
  // Armed for one close: after a turn remounts the drawer, it must not run on a later one.
  useEffect(() => {
    openDialogAfterClose.current = false
  }, [drawer.key])
  const triggerRef = useRef<HTMLButtonElement>(null)
  const pending = usePendingIpAction(ip)
  const banned = decision !== null
  const isPending = pending !== null
  // Waiting, not sent yet: the menu offers Undo instead of ban and unban.
  const waiting = pending !== null && !pending.sending
  if (!status?.writeEnabled) return null

  const trigger = (
    <Button
      ref={triggerRef}
      variant="ghost"
      size="icon-xs"
      className="ml-1 align-middle text-muted-foreground pointer-coarse:min-h-8 pointer-coarse:min-w-8"
      disabled={isPending && !waiting}
      title={banned ? "Unban this IP" : "Ban this IP"}
      aria-label={banned ? `Unban ${ip}` : `Ban ${ip}`}
    >
      {isPending && !waiting ? <Loader2 className="animate-spin" /> : <ShieldBan />}
    </Button>
  )

  return (
    <>
      {drawer.phone ? (
        <BanDrawer
          ip={ip}
          decision={decision}
          layout={drawer}
          open={drawer.open}
          onOpenChange={setMenuOpen}
          onClosed={drawer.onClosed}
          onAnimationEnd={(open) => {
            if (open || !openDialogAfterClose.current) return
            openDialogAfterClose.current = false
            triggerRef.current?.focus({ preventScroll: true })
            setDialogOpen(true)
          }}
          onMoreOptions={() => (openDialogAfterClose.current = true)}
          trigger={trigger}
        />
      ) : (
        <DropdownMenu open={drawer.open} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {waiting ? (
              <DropdownMenuItem onClick={() => undoIpAction(ip)}>
                {pending.action.kind === "ban" ? "Undo ban" : "Undo unban"}
              </DropdownMenuItem>
            ) : banned ? (
              <DropdownMenuItem disabled={isPending} onClick={() => unban(ip)}>
                Unban {ip}
              </DropdownMenuItem>
            ) : (
              <>
                <DropdownMenuLabel>Ban {ip}</DropdownMenuLabel>
                {BAN_DURATIONS.map((d) => (
                  <DropdownMenuItem key={d.value} disabled={isPending} onClick={() => ban(ip, d.value, d.label)}>
                    {d.label}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setDialogOpen(true)}>More options…</DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <BanIpDialog open={dialogOpen} onOpenChange={setDialogOpen} initialIp={ip} returnFocusTo={triggerRef} />
    </>
  )
}
