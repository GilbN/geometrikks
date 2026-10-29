/**
 * The controls after an IP in a table cell: a copy button, and a menu that
 * copies, inspects and flies to the IP, filters on the row's IP, host,
 * server, country or ASN, and bans or unbans. They replace the separate
 * inspect, fly-to and ban buttons. Desktop gets a dropdown menu. Phones get
 * the same actions in a bottom drawer, like the Filters drawer.
 */
import { Fragment, createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react"
import { useNavigate } from "@tanstack/react-router"
import { Check, Copy, EllipsisVertical, Eye, EyeOff, Filter, FilterX, Loader2, LocateFixed, ScanSearch, ShieldBan, ShieldOff, Undo2 } from "lucide-react"
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
import { Separator } from "@/components/ui/separator"
import { stopRowActivation } from "@/components/data/row-activation"
import { CountryFlag } from "@/components/country-flag"
import { DecisionBadge } from "@/components/crowdsec/decision-badge"
import { BanIpDialog } from "@/components/security/ban-ip-dialog"
import { useIsMobile } from "@/hooks/use-mobile"
import { copyText } from "@/lib/clipboard"
import { BAN_DURATIONS, winningDecision } from "@/lib/crowdsec"
import { timeLeftText } from "@/lib/crowdsec-alerts"
import { scenarioText } from "@/lib/scenario-name"
import { countryLabel, type FilterTarget, type IpRowValues } from "@/lib/ip-filter-targets"
import { useIpInspectorActions } from "@/lib/ip-inspector"
import { flyToSearch } from "@/lib/map-filters"
import { useBannedIps, useCrowdsecStatus, useIpDecisions } from "@/lib/queries"
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

interface IpAction {
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

function filterActions(ip: string, target: FilterTarget): IpAction[] {
  const key = `${target.noun}:${target.value}`
  // The IP already heads the menu; a host or server needs its value shown.
  const detail = target.value === ip ? undefined : target.value
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
  return <span className="ml-auto max-w-48 truncate pl-4 font-mono text-xs text-muted-foreground">{value}</span>
}

/** Copies the IP in one click; the icon turns into a check for a moment. */
export function CopyIpButton({ ip, className }: { ip: string; className?: string }) {
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
      title={copied ? "Copied" : "Copy IP"}
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
  return (
    <span className={cn("flex gap-1", wrap ? "min-w-0" : "max-w-80")}>
      <span className={wrap ? "min-w-0 [overflow-wrap:anywhere]" : "truncate"} title={decision.scenario}>{scenarioText(decision.scenario)}</span>
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
  /** For a record sheet's footer: a full-size button and a dropdown at every
   *  width, since a vaul drawer can't nest in the sheet's dialog. Copy,
   *  inspect and fly-to are left out because the sheet has its own. */
  footer?: boolean
  /** Runs after a filter action, so a sheet can close over the filtered table. */
  onFilter?: () => void
}) {
  const { ip } = values
  const isMobile = useIsMobile()
  const { open: inspect } = useIpInspectorActions()
  const navigate = useNavigate()
  const targetsFor = useContext(FilterTargetsContext)
  const { data: status } = useCrowdsecStatus()
  const { data: bannedIps } = useBannedIps()
  const ipActions = useIpActions()
  const pendingAction = usePendingIpAction(ip)
  const [banDialogOpen, setBanDialogOpen] = useState(false)
  // An action that opens a sheet or dialog runs once the menu or drawer has
  // closed and focus is back on the trigger. The sheet takes the focused
  // element as the one to return to, and a dialog opened during the drawer's
  // close animation leaves pointer-events: none on the body after it is
  // dismissed. vaul only reports the end of a close it made itself, so every
  // drawer action closes it through DrawerClose rather than a controlled `open`.
  const afterClose = useRef<(() => void) | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const banLabelId = useId()
  const runAfterClose = () => {
    const run = afterClose.current
    afterClose.current = null
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

  const banFor = (duration: (typeof BAN_DURATIONS)[number]) => ipActions.ban(ip, duration.value, duration.label)
  const unbanIp = () => ipActions.unban(ip)

  const navigation: IpAction[] = footer
    ? []
    : [
        { key: "copy", icon: <Copy />, label: "Copy IP", run: (source: HTMLElement) => void copy(source) },
        { key: "inspect", icon: <ScanSearch />, label: "Inspect IP", run: () => inspect(ip), opensDialog: true },
        {
          key: "fly-to",
          icon: <LocateFixed />,
          label: "Fly to on the map",
          run: () =>
            void navigate({
              to: "/map",
              search: (prev: Record<string, unknown>) => ({ ...prev, ...flyToSearch(ip, locationId) }),
            }),
        },
      ]
  const filters = (targetsFor?.(values) ?? [])
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
  if (footer && sections.length === 0 && !status?.writeEnabled) return null

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
      {isMobile && !footer ? (
        <Drawer
          onAnimationEnd={(open) => {
            if (!open) runAfterClose()
          }}
        >
          <DrawerTrigger asChild>{trigger}</DrawerTrigger>
          <DrawerContent>
            <DrawerHeader>
              <DrawerTitle className="flex items-center justify-center gap-2 font-mono">
                {ip}
                {decision !== null && <DecisionBadge type={decision} className="font-sans" />}
              </DrawerTitle>
              <DrawerDescription className="flex flex-col items-center justify-center gap-0.5">
                <IpContext values={values} decision={decision} />
              </DrawerDescription>
            </DrawerHeader>
            <div className="flex flex-col overflow-y-auto overscroll-contain px-2 pb-6">
              {sections.map((section, index) => (
                <div key={index} className="flex flex-col">
                  {index > 0 && <Separator className="my-2" />}
                  {section.map((action) => (
                    <DrawerClose key={action.key} asChild>
                      <Button
                        variant="ghost"
                        className="h-11 justify-start gap-3 px-3 font-normal"
                        onClick={(event) => select(action, event.currentTarget)}
                      >
                        {action.icon}
                        {action.label}
                        <ActionDetail value={action.detail} />
                      </Button>
                    </DrawerClose>
                  ))}
                </div>
              ))}
              {status?.writeEnabled && (
                <>
                  <Separator className="my-2" />
                  {waiting ? (
                    <DrawerClose asChild>
                      <Button
                        variant="ghost"
                        className="h-11 justify-start gap-3 px-3 font-normal"
                        onClick={() => undoIpAction(ip)}
                      >
                        <Undo2 />
                        {undoLabel}
                      </Button>
                    </DrawerClose>
                  ) : banned ? (
                    <DrawerClose asChild>
                      <Button
                        variant="ghost"
                        className="h-11 justify-start gap-3 px-3 font-normal"
                        disabled={isPending}
                        onClick={unbanIp}
                      >
                        <ShieldOff />
                        Unban IP
                      </Button>
                    </DrawerClose>
                  ) : (
                    <div className="flex flex-col gap-2 px-3 pt-1">
                      <span className="flex items-center gap-3 text-sm">
                        <ShieldBan className="size-4" />
                        Ban IP for
                      </span>
                      <div className="grid grid-cols-3 gap-2">
                        {BAN_DURATIONS.map((duration) => (
                          <DrawerClose key={duration.value} asChild>
                            <Button
                              variant="outline"
                              className="h-11"
                              disabled={isPending}
                              onClick={() => banFor(duration)}
                            >
                              {duration.label}
                            </Button>
                          </DrawerClose>
                        ))}
                        <DrawerClose asChild>
                          <Button
                            variant="outline"
                            className="h-11"
                            onClick={() => {
                              afterClose.current = () => setBanDialogOpen(true)
                            }}
                          >
                            More options…
                          </Button>
                        </DrawerClose>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </DrawerContent>
        </Drawer>
      ) : (
        <DropdownMenu>
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
                <span className="flex items-center gap-2 font-mono">
                  {ip}
                  {decision !== null && <DecisionBadge type={decision} className="font-sans" />}
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
                  // Inline rather than a submenu: a phone has no room beside
                  // the footer menu for one.
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
                    <DropdownMenuItem
                      className="pl-8"
                      disabled={isPending}
                      onSelect={() => {
                        afterClose.current = () => setBanDialogOpen(true)
                      }}
                    >
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
                      <DropdownMenuItem
                        onSelect={() => {
                          afterClose.current = () => setBanDialogOpen(true)
                        }}
                      >
                        More options…
                      </DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                )}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <BanIpDialog open={banDialogOpen} onOpenChange={setBanDialogOpen} initialIp={ip} returnFocusTo={triggerRef} />
    </span>
  )
}
