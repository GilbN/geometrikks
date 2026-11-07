/**
 * The controls after an IP in a table cell: a copy button, and a menu that
 * copies, inspects and flies to the IP, filters on the row's IP, host,
 * server, country or ASN, bans or unbans, and reports to AbuseIPDB. They
 * replace the separate inspect, fly-to and ban buttons. Desktop gets a
 * dropdown menu. Phones get the same actions in a drawer, like the Filters
 * drawer: from the bottom, or from the right on a phone held sideways. On a
 * phone, Ban opens a second drawer with the durations, the one the map
 * panels use.
 */
import { Fragment, createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react"
import { useNavigate } from "@tanstack/react-router"
import { Check, Copy, EllipsisVertical, Eye, EyeOff, Filter, FilterX, Flag, Loader2, LocateFixed, ScanSearch, ShieldBan, ShieldOff, Undo2 } from "lucide-react"
import { toast } from "sonner"
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { stopRowActivation } from "@/components/data/row-activation"
import { CountryFlag } from "@/components/country-flag"
import { DecisionBadge } from "@/components/crowdsec/decision-badge"
import { DropBadge } from "@/components/drop/drop-badge"
import { BanIpDialog } from "@/components/security/ban-ip-dialog"
import { AbuseIpdbReportDialog } from "@/components/abuseipdb/abuseipdb-report-dialog"
import { SideDrawerClose } from "@/components/map/SideDrawer"
import { BanDrawer } from "@/components/map/PanelBanButton"
import { IpFilterToggles } from "@/components/ip-actions/ip-filter-toggles"
import { usePhoneDrawer } from "@/hooks/use-phone-drawer"
import { usePollingHold } from "@/lib/time-range-context"
import { reportedItemState } from "@/lib/abuseipdb"
import { copyText } from "@/lib/clipboard"
import { BAN_DURATIONS, crowdsecErrorMessage, winningDecision } from "@/lib/crowdsec"
import { timeLeftText } from "@/lib/crowdsec-alerts"
import { scenarioText } from "@/lib/scenario-name"
import { countryLabel, type FilterTarget, type IpRowValues } from "@/lib/ip-filter-targets"
import { useIpInspectorActions } from "@/lib/ip-inspector"
import { flyToSearch } from "@/lib/map-filters"
import {
  DROP_NETWORK_STATUS_UNKNOWN_TEXT,
  dropBanReason,
  dropNetworkBannedText,
  dropNetworkBanState,
  dropNetworkUnbannedText,
  type DropNetworkMatch,
} from "@/lib/drop-lists"
import {
  useAbuseIpdbStatus,
  useBanIp,
  useBannedIps,
  useBannedRanges,
  useCrowdsecStatus,
  useDropNetwork,
  useIpDecisions,
  useReportedIps,
  useUnbanIp,
} from "@/lib/queries"
import { undoIpAction, useIpActions, usePendingIpAction } from "@/lib/pending-ip-actions"
import { cn } from "@/lib/utils"

type FilterTargetsFor = (values: IpRowValues) => FilterTarget[]

const FilterTargetsContext = createContext<FilterTargetsFor | null>(null)

/** Gives every IP actions menu inside it the page's filters. Without one
 *  the menu has no filter items. */
export function IpFilterTargetsProvider({
  targetsFor,
  children,
}: {
  targetsFor: FilterTargetsFor
  children: ReactNode
}) {
  return <FilterTargetsContext.Provider value={targetsFor}>{children}</FilterTargetsContext.Provider>
}

export interface IpAction {
  key: string
  icon: ReactNode
  label: string
  /** A host or server value shown beside the label. */
  detail?: string
  /** `source` is the clicked element; the copy fallback needs it. */
  run: (source: HTMLElement) => void
  /** Opens a sheet or dialog, so it waits for the menu or drawer to close. */
  opensDialog?: boolean
}

/** `heading` is what the menu already names, so a target with that value
 *  needs no detail beside its label. */
export function filterActions(heading: string, target: FilterTarget): IpAction[] {
  const key = `${target.noun}:${target.value}`
  // The IP already heads the menu; a host or server needs its value shown.
  const detail = target.value === heading ? undefined : target.value
  if (target.state === "include") {
    return [{ key: `${key}:remove`, icon: <FilterX />, label: `Stop filtering by ${target.noun}`, detail, run: target.remove }]
  }
  if (target.state === "exclude") {
    return [{ key: `${key}:remove`, icon: <Eye />, label: `Stop excluding ${target.noun}`, detail, run: target.remove }]
  }
  const actions: IpAction[] = []
  if (target.include) {
    actions.push({ key: `${key}:include`, icon: <Filter />, label: `Filter by ${target.noun}`, detail, run: target.include })
  }
  if (target.exclude) {
    actions.push({ key: `${key}:exclude`, icon: <EyeOff />, label: `Exclude ${target.noun}`, detail, run: target.exclude })
  }
  return actions
}

function ActionDetail({ value }: { value?: string }) {
  if (value === undefined) return null
  return (
    <span className="ml-auto max-w-48 truncate pl-4 font-mono text-xs text-muted-foreground" title={value}>
      {value}
    </span>
  )
}

type BanDuration = (typeof BAN_DURATIONS)[number]

/** Bans and unbans the IP's DROP network, sent at once with a toast. */
function useDropNetworkBan(dropNetwork: DropNetworkMatch | null, active: boolean) {
  const bannedRanges = useBannedRanges(active)
  const banNetwork = useBanIp()
  const unbanNetwork = useUnbanIp()
  const cidr = dropNetwork?.cidr ?? ""
  const state = dropNetworkBanState(cidr, bannedRanges)
  return {
    // Pending shows the ban rows, disabled until the first read answers.
    state: state === "pending" ? "unbanned" : state,
    busy: state === "pending" || banNetwork.isPending || unbanNetwork.isPending,
    // mutate's own callbacks never run once a table refresh unmounts the
    // row, so the toasts hang off mutateAsync.
    ban: (duration: BanDuration) => {
      if (dropNetwork === null) return
      banNetwork
        .mutateAsync({ ip: cidr, duration: duration.value, reason: dropBanReason(dropNetwork.sblId) })
        .then(
          () => toast.success(dropNetworkBannedText(cidr, duration.label)),
          (error: unknown) =>
            toast.error(crowdsecErrorMessage(error, `Ban failed for ${cidr}; the LAPI may be unreachable.`)),
        )
    },
    unban: () => {
      unbanNetwork.mutateAsync(cidr).then(
        () => toast.success(dropNetworkUnbannedText(cidr)),
        (error: unknown) =>
          toast.error(crowdsecErrorMessage(error, `Unban failed for ${cidr}; the LAPI may be unreachable.`)),
      )
    },
  }
}

/** The DROP network's ban under the IP's in the phone ban drawer: its
 *  durations, Unban, or why neither is offered. Sent at once, without Undo. */
function DropNetworkChoices({
  cidr,
  networkBan,
  onMoreOptions,
}: {
  cidr: string
  networkBan: ReturnType<typeof useDropNetworkBan>
  onMoreOptions: () => void
}) {
  const labelId = useId()
  if (networkBan.state === "unknown") {
    return (
      <Button variant="outline" className="mt-4 h-11 gap-3" disabled>
        <ShieldBan />
        {DROP_NETWORK_STATUS_UNKNOWN_TEXT}
        <ActionDetail value={cidr} />
      </Button>
    )
  }
  if (networkBan.state === "banned") {
    return (
      <DrawerClose asChild>
        <Button
          variant="outline"
          className="mt-4 h-11 border-destructive/40 text-destructive hover:text-destructive"
          disabled={networkBan.busy}
          onClick={networkBan.unban}
        >
          <ShieldOff />
          Unban DROP network
          <span className="min-w-0 truncate font-mono">{cidr}</span>
        </Button>
      </DrawerClose>
    )
  }
  return (
    <div role="group" aria-labelledby={labelId} className="flex flex-col gap-2 pt-4">
      <span id={labelId} className="flex items-center gap-2 text-sm text-muted-foreground">
        <ShieldBan className="size-4 shrink-0" />
        <span>
          Ban DROP network <span className="font-mono text-foreground [overflow-wrap:anywhere]">{cidr}</span> for
        </span>
      </span>
      <div className="grid grid-cols-3 gap-2">
        {BAN_DURATIONS.map((duration) => (
          <DrawerClose key={duration.value} asChild>
            <Button variant="outline" className="h-11" disabled={networkBan.busy} onClick={() => networkBan.ban(duration)}>
              {duration.label}
            </Button>
          </DrawerClose>
        ))}
        <DrawerClose asChild>
          <Button variant="outline" className="h-11" disabled={networkBan.busy} onClick={onMoreOptions}>
            More options…
          </Button>
        </DrawerClose>
      </div>
    </div>
  )
}

/** Copies the IP in one click; the icon turns into a check for a moment. */
export function CopyIpButton({ ip, what = "IP", className }: {
  ip: string
  /** What the tooltip says it copies, as in "Copy network" for a CIDR. */
  what?: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(resetTimer.current), [])

  async function copy(button: HTMLElement) {
    // Inside a sheet the fallback textarea has to live in it, or its focus
    // trap steals the selection before the copy runs.
    if (!(await copyText(ip, { container: button.closest<HTMLElement>("[role=dialog]") }))) {
      toast.error("The browser blocked the copy.")
      return
    }
    setCopied(true)
    clearTimeout(resetTimer.current)
    resetTimer.current = setTimeout(() => setCopied(false), 1500)
  }

  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className={cn("ml-1 align-middle text-muted-foreground pointer-coarse:min-h-8 pointer-coarse:min-w-8", className)}
      title={copied ? "Copied" : `Copy ${what}`}
      aria-label={copied ? `Copied ${ip}` : `Copy ${ip}`}
      onClick={(event) => void copy(event.currentTarget)}
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  )
}

/** Scenario and time left for the IP's decision. The menu mounts it only
 *  while it is open on a banned IP, so a table of IPs makes no lookups. */
function DecisionDetail({ ip, wrap }: { ip: string; wrap: boolean }) {
  const decision = winningDecision(useIpDecisions(ip).data)
  if (decision === null) return null
  if (wrap) {
    return (
      <span className="min-w-0 [overflow-wrap:anywhere]">
        <span title={decision.scenario}>{scenarioText(decision.scenario)}</span>{" "}
        <span className="whitespace-nowrap">· {timeLeftText(decision.duration)}</span>
      </span>
    )
  }
  return (
    <span className="flex max-w-80 gap-1">
      <span className="truncate" title={decision.scenario}>{scenarioText(decision.scenario)}</span>
      <span className="shrink-0">· {timeLeftText(decision.duration)}</span>
    </span>
  )
}

/** The lines under the IP: its decision, then where the row places it.
 *  `wrap` lets long lines wrap instead of truncating, for a full-width sheet. */
export function IpContext({
  values,
  decision,
  wrap = false,
}: {
  values: IpRowValues
  decision: string | null
  wrap?: boolean
}) {
  const { ip, countryCode, countryName, city, asn, asOrganization } = values
  const place = [city, countryCode ? countryLabel(countryCode, countryName) : null].filter(Boolean).join(", ")
  const network = [asn != null ? `AS${asn}` : null, asOrganization].filter(Boolean).join(" ")
  const where = [place, network].filter(Boolean).join(" · ")
  return (
    <>
      {decision !== null && <DecisionDetail ip={ip} wrap={wrap} />}
      {where && (
        <span className={cn("flex items-center gap-1.5", wrap ? "min-w-0" : "max-w-80")}>
          <CountryFlag code={countryCode} name={countryName} />
          <span className={wrap ? "min-w-0 [overflow-wrap:anywhere]" : "truncate"} title={where}>{where}</span>
        </span>
      )}
    </>
  )
}

export function IpActionsMenu({
  locationId,
  className,
  footer = false,
  onFilter,
  ...values
}: IpRowValues & {
  /** Where Fly to lands; without it the map picks the IP's busiest location. */
  locationId?: number
  className?: string
  /** For a record sheet's footer: a full-size button. The menu leaves out
   *  Copy, Inspect and Fly to, since the sheet has its own buttons for them. */
  footer?: boolean
  /** Runs after a filter action, so a sheet can close over the filtered table. */
  onFilter?: () => void
}) {
  const { ip } = values
  const { open: inspect } = useIpInspectorActions()
  const navigate = useNavigate()
  const targetsFor = useContext(FilterTargetsContext)
  const { data: status } = useCrowdsecStatus()
  const { data: bannedIps } = useBannedIps()
  const dropNetwork = useDropNetwork(ip)
  const ipActions = useIpActions()
  const pendingAction = usePendingIpAction(ip)
  const [banDialogOpen, setBanDialogOpen] = useState(false)
  const [banDialogTarget, setBanDialogTarget] = useState<{ ip: string; reason: string }>({ ip, reason: "" })
  const [reportDialogOpen, setReportDialogOpen] = useState(false)
  // Auto refresh waits while this row's menu, ban drawer or one of its dialogs
  // is open, so new rows can't push the row, and the open menu with it, off the page.
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuOpenedAt, setMenuOpenedAt] = useState(() => Date.now())
  const changeMenuOpen = (next: boolean) => {
    if (next) setMenuOpenedAt(Date.now())
    setMenuOpen(next)
  }
  const { data: abuseStatus } = useAbuseIpdbStatus()
  const reportingEnabled = abuseStatus?.reportingEnabled === true
  const { data: reportedIps } = useReportedIps(menuOpen)
  const reportState = reportedItemState(reportedIps?.get(ip), menuOpenedAt)
  const [banDrawerOpen, setBanDrawerOpen] = useState(false)
  // The ban drawer unmounts when write access goes. Its history entry and
  // polling hold live here, so close it rather than leave them on. The hook
  // gets `banDrawerShown`. With `banDrawerOpen`, the render that calls the
  // setter would show it the drawer open, and it would then wait for an
  // onClosed that never comes.
  if (banDrawerOpen && !status?.writeEnabled) setBanDrawerOpen(false)
  const banDrawerShown = banDrawerOpen && status?.writeEnabled === true
  // A rotation swaps the drawer for the dropdown, or turns it around, without
  // an onOpenChange(false). The hook closes it instead, or the hold stays on.
  const drawer = usePhoneDrawer("ip-actions", menuOpen, () => setMenuOpen(false))
  const banDrawer = usePhoneDrawer("ip-ban", banDrawerShown, () => setBanDrawerOpen(false))
  // Ban was tapped and the ban drawer waits for this drawer to close. A turn
  // drops the queued action, so the line below drops this too. Otherwise
  // turning back to the same layout would bring the hold back.
  const [banQueuedIn, setBanQueuedIn] = useState<string | null>(null)
  if (banQueuedIn !== null && banQueuedIn !== drawer.key) setBanQueuedIn(null)
  const [reportQueuedIn, setReportQueuedIn] = useState<string | null>(null)
  if (reportQueuedIn !== null && reportQueuedIn !== drawer.key) setReportQueuedIn(null)
  usePollingHold(
    menuOpen || banDialogOpen || banDrawerShown || banQueuedIn !== null || reportDialogOpen || reportQueuedIn !== null,
  )
  // An action that opens a sheet or dialog runs once the menu or drawer has
  // closed and focus is back on the trigger. The sheet takes the focused
  // element as the one to return to, and a dialog opened during the drawer's
  // close animation leaves pointer-events: none on the body after it is
  // dismissed. vaul only reports the end of a close it made itself, so every
  // drawer action closes it through DrawerClose rather than by setting menuOpen.
  const afterClose = useRef<(() => void) | null>(null)
  // Armed for one close: after a turn remounts the drawer, it must not run on a later one.
  useEffect(() => {
    afterClose.current = null
  }, [drawer.key])
  // What the ban drawer's More options opens once that drawer has closed.
  const afterBanClose = useRef<(() => void) | null>(null)
  useEffect(() => {
    afterBanClose.current = null
  }, [banDrawer.key])
  const triggerRef = useRef<HTMLButtonElement>(null)
  const banLabelId = useId()
  const dropBanLabelId = useId()
  const runAfterClose = (slot = afterClose) => {
    const run = slot.current
    slot.current = null
    if (run === null) return false
    triggerRef.current?.focus({ preventScroll: true })
    run()
    return true
  }
  const select = (action: IpAction, source: HTMLElement) => {
    if (action.opensDialog) afterClose.current = () => action.run(source)
    else action.run(source)
  }
  const decision = bannedIps?.get(ip) ?? null
  const banned = decision !== null
  const isPending = pendingAction !== null
  // While an action waits to be sent, the menu offers Undo in place of ban
  // and unban: the toast's Undo is out of reach inside a sheet's focus trap.
  const waiting = pendingAction !== null && !pendingAction.sending
  const undoLabel = pendingAction?.action.kind === "ban" ? "Undo ban" : "Undo unban"

  async function copy(source: HTMLElement) {
    // The fallback textarea has to live inside the menu or drawer, or its
    // focus trap steals the selection before the copy runs.
    const container = source.closest<HTMLElement>("[role=menu], [role=dialog]")
    if (await copyText(ip, { container })) toast.success(`Copied ${ip}`)
    else toast.error("The browser blocked the copy.")
  }

  const banFor = (duration: BanDuration) => ipActions.ban(ip, duration.value, duration.label)
  const unbanIp = () => ipActions.unban(ip)
  const dropBanShown = status?.writeEnabled === true && dropNetwork !== null
  const dropNetworkBan = useDropNetworkBan(dropNetwork, dropBanShown)
  // `slot` is the close it waits for: the menu's, or the ban drawer's.
  const openBanDialog = (target: { ip: string; reason: string }, slot = afterClose) => {
    slot.current = () => {
      setBanDialogTarget(target)
      setBanDialogOpen(true)
    }
  }
  const openIpBanDialog = (slot = afterClose) => openBanDialog({ ip, reason: "" }, slot)
  const openDropBanDialog = (slot = afterClose) =>
    dropNetwork && openBanDialog({ ip: dropNetwork.cidr, reason: dropBanReason(dropNetwork.sblId) }, slot)
  const queueReportDialog = () => {
    setReportQueuedIn(drawer.key)
    afterClose.current = () => {
      setReportQueuedIn(null)
      setReportDialogOpen(true)
    }
  }
  const queueBanDrawer = () => {
    setBanQueuedIn(drawer.key)
    afterClose.current = () => {
      setBanQueuedIn(null)
      setBanDrawerOpen(true)
    }
  }

  const copyAction: IpAction = { key: "copy", icon: <Copy />, label: "Copy IP", run: (source) => void copy(source) }
  const inspectAction: IpAction = { key: "inspect", icon: <ScanSearch />, label: "Inspect IP", run: () => inspect(ip), opensDialog: true }
  const flyToAction: IpAction = {
    key: "fly-to",
    icon: <LocateFixed />,
    label: "Fly to on the map",
    run: () =>
      void navigate({
        to: "/map",
        search: (prev: Record<string, unknown>) => ({ ...prev, ...flyToSearch(ip, locationId) }),
      }),
  }
  const navigation: IpAction[] = footer ? [] : [copyAction, inspectAction, flyToAction]
  const targets = targetsFor?.(values) ?? []
  const filters = targets
    .flatMap((target) => filterActions(ip, target))
    .map((action): IpAction => {
      if (!onFilter) return action
      return {
        ...action,
        run: (source) => {
          action.run(source)
          onFilter()
        },
      }
    })
  const sections = [navigation, filters].filter((section) => section.length > 0)
  if (footer && sections.length === 0 && !status?.writeEnabled && !reportingEnabled) return null
  // Report shares the ban rows' section, so it needs a separator only when they are gone.
  const reportSeparated = !status?.writeEnabled && sections.length > 0

  const trigger = (
    <Button
      ref={triggerRef}
      variant={footer ? "outline" : "ghost"}
      size={footer ? "icon-lg" : "icon-xs"}
      className={cn(!footer && "align-middle text-muted-foreground pointer-coarse:min-h-8 pointer-coarse:min-w-8", className)}
      title="IP actions"
      aria-label={`Actions for ${ip}`}
    >
      {isPending && !waiting ? <Loader2 className="animate-spin" /> : <EllipsisVertical />}
    </Button>
  )

  return (
    // A sheet footer sits in no row, and stopping its keydowns would keep Tab
    // from reaching the sheet's focus trap.
    <span {...(footer ? {} : stopRowActivation)}>
      {!footer && <CopyIpButton ip={ip} />}
      {drawer.phone ? (
        <Drawer
          key={drawer.key}
          direction={drawer.direction}
          open={drawer.open}
          onOpenChange={changeMenuOpen}
          onClosed={drawer.onClosed}
          onAnimationEnd={(open) => {
            if (!open) runAfterClose()
          }}
        >
          <DrawerTrigger asChild>{trigger}</DrawerTrigger>
          <DrawerContent className={drawer.contentClassName}>
            {drawer.side ? (
              <DrawerHeader className="flex-row items-start gap-2">
                <div className="min-w-0 flex-1 space-y-1">
                  <DrawerTitle className="flex flex-wrap items-center gap-2 font-mono">
                    <span className="[overflow-wrap:anywhere]">{ip}</span>
                    {decision !== null && <DecisionBadge type={decision} className="font-sans" />}
                    {dropNetwork !== null && <DropBadge variant="long" sblId={dropNetwork.sblId} className="font-sans" />}
                  </DrawerTitle>
                  <DrawerDescription className="flex flex-col gap-0.5">
                    <IpContext values={values} decision={decision} wrap />
                  </DrawerDescription>
                </div>
                <SideDrawerClose />
              </DrawerHeader>
            ) : (
              <DrawerHeader>
                <DrawerTitle className="flex flex-wrap items-center justify-center gap-2 font-mono">
                  {ip}
                  {decision !== null && <DecisionBadge type={decision} className="font-sans" />}
                  {dropNetwork !== null && <DropBadge variant="long" sblId={dropNetwork.sblId} className="font-sans" />}
                </DrawerTitle>
                <DrawerDescription className="flex flex-col items-center justify-center gap-0.5">
                  <IpContext values={values} decision={decision} />
                </DrawerDescription>
              </DrawerHeader>
            )}
            <div className="flex flex-col gap-3 overflow-y-auto overscroll-contain px-2 pb-6">
              {(!footer || status?.writeEnabled) && (
                <div className="flex gap-2 px-2 [&_svg:not([class*='size-'])]:size-5">
                  {!footer && (
                    <>
                      <DrawerClose asChild>
                        <Button
                          variant="outline"
                          size="icon"
                          className="size-11 shrink-0"
                          aria-label={copyAction.label}
                          title={copyAction.label}
                          onClick={(event) => select(copyAction, event.currentTarget)}
                        >
                          {copyAction.icon}
                        </Button>
                      </DrawerClose>
                      {[
                        { action: inspectAction, text: "Inspect" },
                        { action: flyToAction, text: "Fly to" },
                      ].map(({ action, text }) => (
                        <DrawerClose key={action.key} asChild>
                          <Button
                            variant="outline"
                            className="h-11 min-w-0 flex-1 px-2"
                            aria-label={action.label}
                            onClick={(event) => select(action, event.currentTarget)}
                          >
                            {action.icon}
                            {text}
                          </Button>
                        </DrawerClose>
                      ))}
                    </>
                  )}
                  {status?.writeEnabled && (
                    <DrawerClose asChild>
                      {waiting ? (
                        <Button variant="outline" className="h-11 min-w-0 flex-1 px-2" aria-label={undoLabel} onClick={() => undoIpAction(ip)}>
                          <Undo2 />
                          Undo
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          className="h-11 min-w-0 flex-1 border-destructive/40 px-2 text-destructive hover:text-destructive"
                          aria-label={banned ? "Unban IP" : "Ban IP"}
                          disabled={isPending}
                          // With a DROP network the ban drawer offers the network
                          // too, so Unban goes there rather than unbanning at once.
                          onClick={banned && !dropBanShown ? unbanIp : queueBanDrawer}
                        >
                          {banned ? <ShieldOff /> : <ShieldBan />}
                          {banned ? "Unban" : "Ban"}
                        </Button>
                      )}
                    </DrawerClose>
                  )}
                </div>
              )}
              {targets.length > 0 && <IpFilterToggles heading={ip} targets={targets} onFilter={onFilter} />}
              {reportingEnabled && (
                <div className="px-2">
                  <DrawerClose asChild>
                    <Button
                      variant="outline"
                      className="h-11 w-full justify-start gap-2 px-3 [&_svg:not([class*='size-'])]:size-5"
                      disabled={reportState.disabled}
                      onClick={queueReportDialog}
                    >
                      <Flag />
                      Report to AbuseIPDB…
                      <ActionDetail value={reportState.detail ?? undefined} />
                    </Button>
                  </DrawerClose>
                </div>
              )}
            </div>
          </DrawerContent>
        </Drawer>
      ) : (
        <DropdownMenu open={drawer.open} onOpenChange={changeMenuOpen}>
          <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
          <DropdownMenuContent
            align={footer ? "end" : "start"}
            side={footer ? "top" : undefined}
            className={cn("w-auto min-w-48", footer && "max-w-[calc(100vw-2rem)]")}
            onCloseAutoFocus={(event) => {
              if (runAfterClose()) event.preventDefault()
            }}
          >
            {/* In a sheet the IP block above already says all this. */}
            {!footer && (
              <DropdownMenuLabel className="flex flex-col items-start justify-start gap-0.5">
                <span className="flex max-w-80 flex-wrap items-center gap-x-2 gap-y-1 font-mono">
                  <span className="[overflow-wrap:anywhere]">{ip}</span>
                  {decision !== null && <DecisionBadge type={decision} className="font-sans" />}
                  {dropNetwork !== null && <DropBadge variant="long" sblId={dropNetwork.sblId} className="font-sans" />}
                </span>
                <IpContext values={values} decision={decision} />
              </DropdownMenuLabel>
            )}
            {sections.map((section, index) => (
              <Fragment key={index}>
                {index > 0 && <DropdownMenuSeparator />}
                {section.map((action) => (
                  <DropdownMenuItem key={action.key} onSelect={(event) => select(action, event.target as HTMLElement)}>
                    {action.icon}
                    {action.label}
                    <ActionDetail value={action.detail} />
                  </DropdownMenuItem>
                ))}
              </Fragment>
            ))}
            {status?.writeEnabled && (
              <>
                {sections.length > 0 && <DropdownMenuSeparator />}
                {waiting ? (
                  <DropdownMenuItem onSelect={() => undoIpAction(ip)}>
                    <Undo2 />
                    {undoLabel}
                  </DropdownMenuItem>
                ) : banned ? (
                  <DropdownMenuItem disabled={isPending} onSelect={unbanIp}>
                    <ShieldOff />
                    Unban IP
                  </DropdownMenuItem>
                ) : footer ? (
                  // Inline rather than a submenu, which would have to open
                  // over the sheet.
                  <DropdownMenuGroup aria-labelledby={banLabelId}>
                    <DropdownMenuLabel id={banLabelId} className="flex items-center gap-2 font-normal">
                      <ShieldBan className="size-4" />
                      Ban IP for
                    </DropdownMenuLabel>
                    {BAN_DURATIONS.map((duration) => (
                      <DropdownMenuItem
                        key={duration.value}
                        className="pl-8"
                        disabled={isPending}
                        onSelect={() => banFor(duration)}
                      >
                        {duration.label}
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuItem className="pl-8" disabled={isPending} onSelect={() => openIpBanDialog()}>
                      More options…
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                ) : (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger disabled={isPending}>
                      <ShieldBan />
                      Ban IP
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      {BAN_DURATIONS.map((duration) => (
                        <DropdownMenuItem key={duration.value} onSelect={() => banFor(duration)}>
                          {duration.label}
                        </DropdownMenuItem>
                      ))}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={() => openIpBanDialog()}>More options…</DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                )}
                {dropBanShown &&
                  (dropNetworkBan.state === "unknown" ? (
                    <DropdownMenuItem disabled>
                      <ShieldBan />
                      {DROP_NETWORK_STATUS_UNKNOWN_TEXT}
                      <ActionDetail value={dropNetwork.cidr} />
                    </DropdownMenuItem>
                  ) : dropNetworkBan.state === "banned" ? (
                    <DropdownMenuItem disabled={dropNetworkBan.busy} onSelect={dropNetworkBan.unban}>
                      <ShieldOff />
                      Unban DROP network
                      <ActionDetail value={dropNetwork.cidr} />
                    </DropdownMenuItem>
                  ) : footer ? (
                    <DropdownMenuGroup aria-labelledby={dropBanLabelId}>
                      <DropdownMenuLabel id={dropBanLabelId} className="flex items-start gap-2 font-normal">
                        <ShieldBan className="mt-0.5 size-4 shrink-0" />
                        <span>
                          Ban DROP network <span className="font-mono [overflow-wrap:anywhere]">{dropNetwork.cidr}</span> for
                        </span>
                      </DropdownMenuLabel>
                      {BAN_DURATIONS.map((duration) => (
                        <DropdownMenuItem
                          key={duration.value}
                          className="pl-8"
                          disabled={dropNetworkBan.busy}
                          onSelect={() => dropNetworkBan.ban(duration)}
                        >
                          {duration.label}
                        </DropdownMenuItem>
                      ))}
                      <DropdownMenuItem className="pl-8" disabled={dropNetworkBan.busy} onSelect={() => openDropBanDialog()}>
                        More options…
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                  ) : (
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger disabled={dropNetworkBan.busy}>
                        <ShieldBan />
                        {/* Fills the row so the CIDR sits against the chevron. */}
                        <span className="flex flex-1 items-center">
                          Ban DROP network
                          <ActionDetail value={dropNetwork.cidr} />
                        </span>
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent>
                        {BAN_DURATIONS.map((duration) => (
                          <DropdownMenuItem key={duration.value} onSelect={() => dropNetworkBan.ban(duration)}>
                            {duration.label}
                          </DropdownMenuItem>
                        ))}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => openDropBanDialog()}>More options…</DropdownMenuItem>
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  ))}
              </>
            )}
            {reportingEnabled && (
              <>
                {reportSeparated && <DropdownMenuSeparator />}
                <DropdownMenuItem disabled={reportState.disabled} onSelect={queueReportDialog}>
                  <Flag />
                  Report to AbuseIPDB…
                  <ActionDetail value={reportState.detail ?? undefined} />
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {banDrawer.phone && status?.writeEnabled && (
        <BanDrawer
          ip={ip}
          decision={decision}
          layout={banDrawer}
          open={banDrawer.open}
          onOpenChange={setBanDrawerOpen}
          onClosed={banDrawer.onClosed}
          onAnimationEnd={(open) => {
            if (!open) runAfterClose(afterBanClose)
          }}
          onMoreOptions={() => openIpBanDialog(afterBanClose)}
          returnFocusTo={triggerRef}
          badges={dropNetwork !== null && <DropBadge variant="long" sblId={dropNetwork.sblId} className="font-sans" />}
        >
          {dropBanShown && (
            <DropNetworkChoices
              cidr={dropNetwork.cidr}
              networkBan={dropNetworkBan}
              onMoreOptions={() => openDropBanDialog(afterBanClose)}
            />
          )}
        </BanDrawer>
      )}
      <BanIpDialog
        open={banDialogOpen}
        onOpenChange={setBanDialogOpen}
        initialIp={banDialogTarget.ip}
        initialReason={banDialogTarget.reason}
        returnFocusTo={triggerRef}
      />
      {reportingEnabled && (
        <AbuseIpdbReportDialog
          ip={ip}
          open={reportDialogOpen}
          onOpenChange={setReportDialogOpen}
          returnFocusTo={triggerRef}
        />
      )}
    </span>
  )
}
