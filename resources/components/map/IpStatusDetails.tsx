/**
 * Why an IP on the map is tinted or outlined: its CrowdSec decisions, its
 * DROP listing and the actions for it. Clicking the IP opens them, in a
 * bottom sheet on a phone and a popover elsewhere, since a phone has no hover
 * for the tooltip the tables use. An IP with neither renders as it is.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react"
import { Loader2, ScanSearch, ShieldBan, ShieldOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer"
import { DecisionBadge } from "@/components/crowdsec/decision-badge"
import { DropBadge } from "@/components/drop/drop-badge"
import { SblRecordLink } from "@/components/drop/sbl-record-link"
import { IpLabel } from "@/components/ip-actions/ip-label"
import { CopyIpButton } from "@/components/ip-actions/ip-actions-menu"
import { BanIpDialog } from "@/components/security/ban-ip-dialog"
import type { DecisionRef } from "@/components/security/alert-detail-sheet"
import type { DecisionView } from "@/generated/api/types.gen"
import { crowdsecErrorMessage, decisionLabel, resolveDecision } from "@/lib/crowdsec"
import { decisionHasAlert, formatTimeLeft, isBlocklistOrigin } from "@/lib/crowdsec-alerts"
import { useIpInspectorActions } from "@/lib/ip-inspector"
import { useIpActions, usePendingIpAction } from "@/lib/pending-ip-actions"
import { useBannedIps, useCrowdsecStatus, useDropNetwork, useIpDecisions } from "@/lib/queries"
import { scenarioText } from "@/lib/scenario-name"
import { usePollingHold } from "@/lib/time-range-context"
import { cn } from "@/lib/utils"
import { SideDrawerClose, usePanelPhone, useSideDrawer } from "./SideDrawer"
import { BanChoices, type CloseSlot } from "./PanelBanButton"
import { useOverlayEntry } from "@/lib/overlay-history"

const ORIGIN_TEXT: Record<string, string> = {
  crowdsec: "Your CrowdSec engine detected it",
  cscli: "Added by hand with cscli",
  geometrikks: "Banned from GeoMetrikks",
  CAPI: "CrowdSec community blocklist",
  lists: "A blocklist you subscribe to",
}

function decisionTone(type: string): string {
  if (type === "ban") return "text-destructive"
  if (type === "captcha") return "text-amber-500"
  return "text-foreground"
}

/** "Banned · On DROP · " ahead of a row's other details, or nothing. */
export function IpStatusWords({ ip }: { ip: string }) {
  const { data: bannedIps } = useBannedIps()
  const dropNetwork = useDropNetwork(ip)
  const decision = bannedIps?.get(ip) ?? null
  return (
    <>
      {decision !== null && <><span className={cn("font-semibold", decisionTone(decision))}>{decisionLabel(decision)}</span> · </>}
      {dropNetwork !== null && <><span className="font-semibold text-destructive">On DROP</span> · </>}
    </>
  )
}

/** Phone and popover type sizes for the status blocks. */
function blockStyles(compact: boolean) {
  return {
    block: cn("rounded-xl border border-border", compact ? "p-2" : "p-3"),
    heading: cn("flex items-center gap-2 font-semibold", compact ? "text-xs" : "text-sm"),
    list: cn(
      "mt-2 grid items-baseline gap-x-3 gap-y-1",
      compact ? "grid-cols-[4.5rem_minmax(0,1fr)] text-xs" : "grid-cols-[5.5rem_minmax(0,1fr)] text-sm",
    ),
  }
}

function DecisionBlock({ decision, ip, onOpenAlert, Close, compact }: {
  decision: DecisionView
  ip: string
  Close: CloseSlot
  compact: boolean
  /** Set when the alert behind the decision can be opened. */
  onOpenAlert?: (decision: DecisionRef) => void
}) {
  const scenario = decision.scenario ? scenarioText(decision.scenario) : "No scenario given"
  const blocklist = isBlocklistOrigin(decision.origin)
  const styles = blockStyles(compact)
  return (
    <section className={styles.block}>
      <h3 className={styles.heading}>
        <DecisionBadge type={decision.type} />
        by CrowdSec
      </h3>
      <dl className={styles.list}>
        <dt className="text-muted-foreground">Scenario</dt>
        <dd className="[overflow-wrap:anywhere]">
          {onOpenAlert ? (
            <Close asChild>
              <Button
                variant="link"
                className={cn("h-auto whitespace-normal p-0 text-left underline decoration-primary/40 decoration-dotted", compact ? "text-xs" : "min-h-8 text-sm")}
                onClick={() => onOpenAlert({ id: decision.id!, ip, scenario: decision.scenario })}
              >
                {scenario}
              </Button>
            </Close>
          ) : scenario}
        </dd>
        <dt className="text-muted-foreground">Origin</dt>
        <dd>{ORIGIN_TEXT[decision.origin] ?? decision.origin}</dd>
        <dt className="text-muted-foreground">Time left</dt>
        <dd>{formatTimeLeft(decision.duration)}</dd>
      </dl>
      {decision.type === "captcha" && (
        <p className="mt-2 text-xs text-muted-foreground">
          A bouncer that supports captchas asks visitors from this IP to solve one instead of blocking them.
        </p>
      )}
      {blocklist && (
        <p className="mt-2 text-xs text-muted-foreground">
          CrowdSec pulls blocklist decisions in bulk, so this one has no alert of its own to open.
        </p>
      )}
    </section>
  )
}

function StatusBody({ ip, banned, onOpenAlert, Close, compact }: {
  ip: string
  banned: boolean
  Close: CloseSlot
  compact: boolean
  onOpenAlert?: (decision: DecisionRef) => void
}) {
  const { data: status } = useCrowdsecStatus()
  const writeEnabled = status?.writeEnabled === true
  const crowdsecEnabled = status?.enabled === true
  const decisions = useIpDecisions(ip)
  const dropNetwork = useDropNetwork(ip)
  const active = decisions.data?.filter((decision) => decision.scope === "Ip") ?? []
  const styles = blockStyles(compact)
  return (
    <div className="flex flex-col gap-3">
      {banned && decisions.isPending && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading the CrowdSec decision...
        </p>
      )}
      {decisions.isError && (
        <p role="alert" className="text-sm text-destructive">
          {crowdsecErrorMessage(decisions.error, "Could not load the CrowdSec decision.")}
        </p>
      )}
      {active.map((decision) => (
        <DecisionBlock
          key={decision.id ?? `${decision.origin}:${decision.scenario}:${decision.duration}`}
          decision={decision}
          ip={ip}
          Close={Close}
          compact={compact}
          onOpenAlert={onOpenAlert && writeEnabled && decisionHasAlert(decision.scope, decision) ? onOpenAlert : undefined}
        />
      ))}
      {dropNetwork !== null && (
        <section className={styles.block}>
          <h3 className={styles.heading}>
            <DropBadge variant="short" />
            Spamhaus DROP list
          </h3>
          <dl className={styles.list}>
            <dt className="text-muted-foreground">Network</dt>
            <dd className="flex items-center gap-1 font-mono">
              {dropNetwork.cidr}
              <CopyIpButton ip={dropNetwork.cidr} what="network" className={compact ? "ml-0" : "ml-0 -my-2.5 size-11"} />
            </dd>
            {dropNetwork.sblId && (
              <>
                <dt className="text-muted-foreground">Entry</dt>
                <dd><SblRecordLink sblId={dropNetwork.sblId} className="text-primary" /></dd>
              </>
            )}
          </dl>
          <p className="mt-2 text-xs text-muted-foreground">
            DROP stands for Don't Route Or Peer. Spamhaus lists networks run by spam and cybercrime operations, so
            traffic from them is almost never legitimate.{!banned && " GeoMetrikks has not blocked this IP."}
          </p>
        </section>
      )}
      {!banned && crowdsecEnabled && (
        <p className={cn("text-muted-foreground", compact ? "text-xs" : "text-sm")}>No CrowdSec decision on this IP.</p>
      )}
    </div>
  )
}

type IpStatusDetailsProps = {
  ip: string
  /** Location and network, under the IP in the header. */
  context?: ReactNode
  /** Known decision type before the banned-IP query has loaded. */
  initialDecision?: string | null
  /** Where the IP inspector starts. */
  fromLocationId?: number
  onOpenAlert?: (decision: DecisionRef) => void
  /** The IP as the panel or popup shows it; it becomes the trigger. */
  children: ReactNode
}

export function IpStatusDetails(props: IpStatusDetailsProps) {
  const { data: bannedIps } = useBannedIps()
  const dropNetwork = useDropNetwork(props.ip)
  const decision = resolveDecision(bannedIps, props.ip, props.initialDecision ?? null)
  // The open state and its polling hold live in MarkedIpStatus, so they go
  // with it when a decision expires or is lifted while the details are open.
  if (decision === null && dropNetwork === null) return <>{props.children}</>
  return <MarkedIpStatus {...props} decision={decision} />
}

function MarkedIpStatus({
  ip,
  context,
  decision,
  fromLocationId,
  onOpenAlert,
  children,
}: IpStatusDetailsProps & { decision: string | null }) {
  const isMobile = usePanelPhone()
  const drawer = useSideDrawer()
  const { data: status } = useCrowdsecStatus()
  const { unban } = useIpActions()
  const pending = usePendingIpAction(ip)
  const { open: openInspector } = useIpInspectorActions()
  const [open, setOpen] = useState(false)
  const [choosingBan, setChoosingBan] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  usePollingHold(open || dialogOpen)
  // A rotation remounts the drawer closed (vaul cannot turn it around).
  useEffect(() => setOpen(false), [drawer.direction])
  const overlayId = useId()
  useOverlayEntry(`ip-status-${overlayId}`, isMobile && open, () => setOpen(false))
  // On a phone the inspector, the alert sheet and the ban dialog open once
  // the sheet has finished closing. Opened during its close animation, they
  // leave pointer-events: none on the body. A popover is not modal, so they
  // open straight away.
  const afterClose = useRef<(() => void) | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const banned = decision !== null
  const writeEnabled = status?.writeEnabled === true
  const waiting = pending !== null && !pending.sending
  const showChoices = writeEnabled && (choosingBan || waiting)
  const Close: CloseSlot = isMobile ? DrawerClose : PopoverClose
  const button = isMobile ? "h-11" : "h-8"
  const later = (action: () => void) => {
    if (isMobile) afterClose.current = action
    else action()
  }
  // Reset on open, not on close, so the content does not swap while it animates out.
  const changeOpen = (next: boolean) => {
    setOpen(next)
    if (next) setChoosingBan(false)
  }

  const trigger = (
    <button ref={triggerRef} type="button" className="max-w-full cursor-pointer text-left" aria-haspopup="dialog">
      {children}
    </button>
  )
  const details = (
    <>
      <StatusBody ip={ip} banned={banned} Close={Close} compact={!isMobile} onOpenAlert={onOpenAlert && ((ref) => later(() => onOpenAlert(ref)))} />
      {showChoices ? (
        <div className="flex flex-col gap-2">
          {!waiting && <p className="text-sm">Ban this IP in CrowdSec for</p>}
          <BanChoices
            ip={ip}
            banned={banned}
            Close={Close}
            compact={!isMobile}
            onMoreOptions={() => later(() => setDialogOpen(true))}
          />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <Close asChild>
            <Button variant="outline" className={button} onClick={() => later(() => openInspector(ip, fromLocationId))}>
              <ScanSearch className={isMobile ? "size-5" : undefined} />
              Inspect
            </Button>
          </Close>
          {writeEnabled && (banned ? (
            <Close asChild>
              <Button
                variant="outline"
                className={cn(button, "border-destructive/40 text-destructive hover:text-destructive")}
                disabled={pending !== null}
                onClick={() => unban(ip)}
              >
                <ShieldOff className={isMobile ? "size-5" : undefined} />
                Unban
              </Button>
            </Close>
          ) : (
            <Button
              variant="outline"
              className={cn(button, "border-destructive/40 text-destructive hover:text-destructive")}
              onClick={() => setChoosingBan(true)}
            >
              <ShieldBan className={isMobile ? "size-5" : undefined} />
              Ban
            </Button>
          ))}
        </div>
      )}
    </>
  )

  return (
    <>
      {isMobile ? (
        <Drawer
          key={drawer.direction}
          direction={drawer.direction}
          open={open}
          onOpenChange={changeOpen}
          onAnimationEnd={(isOpen) => {
            if (isOpen || !afterClose.current) return
            const run = afterClose.current
            afterClose.current = null
            triggerRef.current?.focus({ preventScroll: true })
            run()
          }}
        >
          <DrawerTrigger asChild>{trigger}</DrawerTrigger>
          <DrawerContent className={drawer.contentClassName}>
            <DrawerHeader className="text-left md:text-left group-data-[vaul-drawer-direction=bottom]/drawer-content:text-left">
              <div className="flex items-center gap-1">
                <DrawerTitle>
                  <IpLabel ip={ip} className="text-xl break-all" />
                </DrawerTitle>
                <CopyIpButton ip={ip} className="size-11 [&_svg:not([class*='size-'])]:size-5" />
                {drawer.side && <span className="ml-auto"><SideDrawerClose /></span>}
              </div>
              <DrawerDescription className={cn(!context && "sr-only")}>
                {context ?? "Why this IP is marked"}
              </DrawerDescription>
            </DrawerHeader>
            <div className={cn("flex flex-col gap-3 overflow-y-auto overscroll-contain px-4 pb-6", drawer.side ? "min-h-0 flex-1" : "max-h-[60vh]")}>{details}</div>
          </DrawerContent>
        </Drawer>
      ) : (
        <Popover open={open} onOpenChange={changeOpen}>
          <PopoverTrigger asChild>{trigger}</PopoverTrigger>
          <PopoverContent
            aria-label={`Why ${ip} is marked`}
            align="start"
            collisionPadding={8}
            className="flex max-h-(--radix-popover-content-available-height) w-80 flex-col gap-2 overflow-y-auto overscroll-contain p-3 text-xs"
          >
            {context && <p className="text-xs text-muted-foreground">{context}</p>}
            {details}
          </PopoverContent>
        </Popover>
      )}
      {writeEnabled && <BanIpDialog open={dialogOpen} onOpenChange={setDialogOpen} initialIp={ip} />}
    </>
  )
}
