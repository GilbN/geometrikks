/**
 * Ban and unban for a MapDetailPanel: a button that opens BanDrawer with the
 * ban durations. Renders nothing without CrowdSec write access.
 */
import { useId, useRef, useState, type ComponentType, type ReactNode, type RefObject } from "react"
import { Loader2, ShieldBan, ShieldOff, Undo2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer"
import { BanIpDialog } from "@/components/security/ban-ip-dialog"
import { DecisionBadge } from "@/components/crowdsec/decision-badge"
import { BAN_DURATIONS, resolveDecision } from "@/lib/crowdsec"
import { undoIpAction, useIpActions, usePendingIpAction } from "@/lib/pending-ip-actions"
import { useBannedIps, useCrowdsecStatus } from "@/lib/queries"
import { usePollingHold } from "@/lib/time-range-context"
import { useOverlayEntry } from "@/lib/overlay-history"
import { useCoverBar } from "@/lib/phone-chrome"
import { cn } from "@/lib/utils"
import { SideDrawerClose, useSideDrawer } from "./SideDrawer"

/** DrawerClose or PopoverClose: closes the container a choice sits in. */
export type CloseSlot = ComponentType<{ asChild?: boolean; children: ReactNode }>

export function PanelBanButton({
  ip,
  initialDecision = null,
  footer = false,
}: {
  ip: string
  /** Known decision type before the banned-IP query has loaded. */
  initialDecision?: string | null
  /** A labelled outline button for the panel's footer, rather than an icon in a row. */
  footer?: boolean
}) {
  const { data: status } = useCrowdsecStatus()
  const { data: bannedIps } = useBannedIps()
  const pending = usePendingIpAction(ip)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  // A refetch that reorders the panel's rows would remount this row and
  // close its sheet.
  usePollingHold(sheetOpen || dialogOpen)
  // The ban dialog opens once the sheet has finished closing. Opened during
  // its close animation, it leaves pointer-events: none on the body.
  const openDialogAfterClose = useRef(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const drawer = useSideDrawer()
  // A rotation remounts the drawer closed (vaul cannot turn it around). Reset
  // during render, so the remounted drawer never mounts open.
  const [direction, setDirection] = useState(drawer.direction)
  if (direction !== drawer.direction) {
    setDirection(drawer.direction)
    setSheetOpen(false)
  }
  const overlayId = useId()
  useOverlayEntry(`ban-drawer-${overlayId}`, sheetOpen, () => setSheetOpen(false))
  useCoverBar(sheetOpen && drawer.side)

  if (!status?.writeEnabled) return null

  const decision = resolveDecision(bannedIps, ip, initialDecision)
  const banned = decision !== null
  const isPending = pending !== null
  const waiting = pending !== null && !pending.sending
  const sending = isPending && !waiting
  const icon = sending ? <Loader2 className="animate-spin" /> : banned ? <ShieldOff /> : <ShieldBan />

  return (
    <>
      <BanDrawer
        ip={ip}
        decision={decision}
        layout={{ key: drawer.direction, ...drawer }}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        onAnimationEnd={(open) => {
          if (open || !openDialogAfterClose.current) return
          openDialogAfterClose.current = false
          triggerRef.current?.focus({ preventScroll: true })
          setDialogOpen(true)
        }}
        onMoreOptions={() => (openDialogAfterClose.current = true)}
        trigger={
          <Button
            ref={triggerRef}
            variant={footer ? "outline" : "ghost"}
            disabled={sending}
            aria-label={banned ? `Unban ${ip}` : `Ban ${ip}`}
            className={cn(
              "[&_svg]:size-5",
              footer
                ? "h-11 flex-1 border-destructive/40 text-destructive hover:text-destructive"
                : "size-11 rounded-full text-muted-foreground",
              isPending && "text-primary hover:text-primary",
            )}
          >
            {icon}
            {footer && (banned ? "Unban" : "Ban")}
          </Button>
        }
      />
      <BanIpDialog open={dialogOpen} onOpenChange={setDialogOpen} initialIp={ip} />
    </>
  )
}

/** Where a ban drawer opens from, as usePhoneDrawer or useSideDrawer gives it. */
export interface BanDrawerLayout {
  /** For the Drawer's `key`: vaul can't change direction while mounted. */
  key: string
  direction: "bottom" | "right"
  contentClassName: string
  side: boolean
}

/**
 * The ban durations for one IP in a drawer, or Undo or Unban when those
 * apply. The caller owns the open state and the layout. Without a `trigger`,
 * `returnFocusTo` takes focus when it closes, since the drawer has no trigger
 * of its own to return it to.
 */
export function BanDrawer({
  ip,
  decision,
  layout,
  open,
  onOpenChange,
  onClosed,
  onAnimationEnd,
  onMoreOptions,
  trigger,
  returnFocusTo,
  badges,
  children,
}: {
  ip: string
  decision: string | null
  layout: BanDrawerLayout
  open: boolean
  onOpenChange: (open: boolean) => void
  onClosed?: () => void
  onAnimationEnd?: (open: boolean) => void
  /** "More options…" closes the drawer; open the ban dialog after it has. */
  onMoreOptions: () => void
  trigger?: ReactNode
  returnFocusTo?: RefObject<HTMLElement | null>
  /** More badges beside the IP, after its decision. */
  badges?: ReactNode
  /** More choices under the IP's own. */
  children?: ReactNode
}) {
  const pending = usePendingIpAction(ip)
  const banned = decision !== null
  const waiting = pending !== null && !pending.sending
  return (
    <Drawer
      key={layout.key}
      direction={layout.direction}
      open={open}
      onOpenChange={onOpenChange}
      onClosed={onClosed}
      onAnimationEnd={onAnimationEnd}
    >
      {trigger && <DrawerTrigger asChild>{trigger}</DrawerTrigger>}
      <DrawerContent
        className={layout.contentClassName}
        onCloseAutoFocus={(event) => {
          if (!returnFocusTo) return
          event.preventDefault()
          returnFocusTo.current?.focus({ preventScroll: true })
        }}
      >
        <DrawerHeader>
          {layout.side ? (
            <div className="flex items-center gap-2">
              <DrawerTitle className="flex min-w-0 flex-1 flex-wrap items-center gap-2 font-mono">
                <span className="min-w-0 break-all">{ip}</span>
                {decision !== null && <DecisionBadge type={decision} className="font-sans" />}
                {badges}
              </DrawerTitle>
              <SideDrawerClose />
            </div>
          ) : (
            <DrawerTitle className="flex flex-wrap items-center justify-center gap-2 font-mono">
              {ip}
              {decision !== null && <DecisionBadge type={decision} className="font-sans" />}
              {badges}
            </DrawerTitle>
          )}
          <DrawerDescription>
            {waiting ? "Waiting to send to CrowdSec" : banned ? "CrowdSec has a decision on this IP" : "Ban this IP in CrowdSec for"}
          </DrawerDescription>
        </DrawerHeader>
        <div className="flex flex-col overflow-y-auto overscroll-contain px-4 pb-6">
          <BanChoices ip={ip} banned={banned} onMoreOptions={onMoreOptions} />
          {children}
        </div>
      </DrawerContent>
    </Drawer>
  )
}

/**
 * What a bottom sheet or popover offers for one IP: Undo while an action
 * waits to be sent, Unban for a banned IP, or the ban durations. Every choice
 * closes its container through `Close`, DrawerClose unless told otherwise.
 */
export function BanChoices({ ip, banned, onMoreOptions, Close = DrawerClose, compact = false }: {
  ip: string
  banned: boolean
  /** "More options…" closes the sheet; open the ban dialog after it has. */
  onMoreOptions: () => void
  /** What closes the surrounding sheet or popover. */
  Close?: CloseSlot
  /** Desktop-sized buttons, for a popover. */
  compact?: boolean
}) {
  const height = compact ? "h-8" : "h-11"
  const { ban, unban } = useIpActions()
  const pending = usePendingIpAction(ip)
  const isPending = pending !== null
  const waiting = pending !== null && !pending.sending
  return waiting ? (
    <Close asChild>
      <Button variant="outline" className={cn(height, "w-full")} onClick={() => undoIpAction(ip)}>
        <Undo2 />
        {pending.action.kind === "ban" ? "Undo ban" : "Undo unban"}
      </Button>
    </Close>
  ) : banned ? (
    <Close asChild>
      <Button
        variant="outline"
        className={cn(height, "w-full border-destructive/40 text-destructive hover:text-destructive")}
        disabled={isPending}
        onClick={() => unban(ip)}
      >
        <ShieldOff />
        Unban IP
      </Button>
    </Close>
  ) : (
    <div className="grid grid-cols-3 gap-2">
      {BAN_DURATIONS.map((duration) => (
        <Close key={duration.value} asChild>
          <Button variant="outline" className={height} disabled={isPending} onClick={() => ban(ip, duration.value, duration.label)}>
            {duration.label}
          </Button>
        </Close>
      ))}
      <Close asChild>
        <Button variant="outline" className={height} onClick={onMoreOptions}>
          More options…
        </Button>
      </Close>
    </div>
  )
}
