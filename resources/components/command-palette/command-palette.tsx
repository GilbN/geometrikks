/**
 * Search and commands. Ctrl+K, or the search field in the top bar, opens one
 * list of pages and actions. Each row shows its keyboard shortcut, so the
 * keys are learned along the way. On a phone it is a full-screen sheet
 * opened from the search button in the header.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react"
import { useNavigate, useRouter, type RouterHistory } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { defaultFilter, useCommandState } from "cmdk"
import {
  ArrowDown,
  ArrowUp,
  Ban,
  CalendarDays,
  CircleX,
  CornerDownLeft,
  Radio,
  Search,
} from "lucide-react"

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import {
  openBanDialogFor,
  openShortcutsCheatSheet,
  runShortcut,
} from "@/components/shortcuts/keyboard-shortcuts"
import { useAbuseReportDialog } from "@/components/abuse-report/abuse-report-dialog"
import {
  ADDRESS_ROW,
  GROUP,
  IP_ROW,
  ITEM,
  ItemIcon,
  IpSearchGroups,
  PhoneChevron,
  RecentIpsGroup,
  RowText,
  type IpActions,
} from "@/components/command-palette/ip-results"
import {
  FilterValueGroups,
  NAME_ROW,
  PICKED_LABEL_ID,
  PickedChip,
  PickedTargets,
  pickedLabel,
  type PickedValue,
} from "@/components/command-palette/filter-value-results"
import { useDebouncedValue } from "@/hooks/use-debounced-value"
import { useIpInspector } from "@/lib/ip-inspector"
import { canonicalIp, parseIpQuery } from "@/lib/ip-prefix"
import { isValidIp } from "@/lib/crowdsec"
import { requestAccessLogsTab } from "@/lib/live-tail-request"
import { requestDecisionsSearch } from "@/lib/decisions-search-request"
import { rememberInspectedIp, useRecentIps } from "@/lib/recent-ips"
import { useRouteHeader } from "@/lib/route-header"
import { useOverlayEntry } from "@/lib/overlay-history"
import { fetchCrowdsecStatus } from "@/lib/api"
import { NAV_ITEMS, SETTINGS_ITEM, moreItems, slotFour, type NavId } from "@/lib/phone-nav"
import {
  closeCommandPalette,
  closeCommandPaletteThen,
  commandPaletteOpen,
  openCommandPalette,
  resetCommandPalette,
  setCommandPaletteOpen,
  takeCommandPaletteClose,
  useCommandPaletteOpen,
} from "@/lib/command-palette-store"
import { queryKeys, useSecurityNavStatus } from "@/lib/queries"
import {
  SHORTCUTS,
  ariaKeyShortcut,
  modifierLabel,
  shortcutKeyLabels,
  type ShortcutId,
} from "@/lib/shortcuts"
import { timeRangeName, timeRangeSpan } from "@/lib/time-range-label"
import { useTimeRange } from "@/lib/time-range-context"
import { useTimeFormat } from "@/lib/table-view"
import { usePhoneLayout } from "@/hooks/use-phone-map"
import { cn } from "@/lib/utils"

const GO_TO: Record<NavId, ShortcutId> = {
  overview: "go-overview",
  map: "go-map",
  "access-logs": "go-access-logs",
  "geo-logs": "go-geo-logs",
  "debug-logs": "go-debug-logs",
  analytics: "go-analytics",
  security: "go-security",
  settings: "go-settings",
}

/** The order the cheat sheet lists the pages in. */
const PAGE_ORDER: ShortcutId[] = SHORTCUTS.filter((shortcut) => shortcut.group === "goto").map(
  (shortcut) => shortcut.id,
)

/** The pages a phone reaches through More, which the sheet lists before anything is typed. */
const PHONE_PAGE_ORDER: NavId[] = ["geo-logs", "analytics", "debug-logs", "settings"]

const KEY = "h-6 min-w-6 rounded-md border border-border bg-transparent px-1.5 text-xs"

function Keys({ id }: { id: ShortcutId }) {
  const shortcut = SHORTCUTS.find((candidate) => candidate.id === id)
  if (!shortcut) return null
  return (
    <CommandShortcut aria-hidden className="tracking-normal">
      <KbdGroup>
        {shortcutKeyLabels(shortcut).map((label, index) => (
          <Kbd key={`${label}-${index}`} className={KEY}>
            {label}
          </Kbd>
        ))}
      </KbdGroup>
    </CommandShortcut>
  )
}

/** cmdk's Enter handler would run the highlighted row instead of the focused button. */
function keepKeyFromList(event: KeyboardEvent) {
  if (event.key === "Enter") event.stopPropagation()
}

/** Name rows score this. A page or action whose name starts with the text scores more. */
const NAME_ROW_SCORE = 0.5

/**
 * IP and name rows come from the server, which already matched them, so the
 * typed text never hides them. Name rows rank under a page or action whose
 * name starts with the text, so "acc" and Enter still opens Access Logs and
 * not Accra.
 */
function paletteFilter(value: string, search: string, keywords?: string[]): number {
  if (value.startsWith(IP_ROW)) return 1
  if (value.startsWith(NAME_ROW)) return NAME_ROW_SCORE
  return defaultFilter(value, search, keywords)
}

/** cmdk's empty message sits in the listbox, which screen readers don't announce. */
function NoMatchStatus() {
  const count = useCommandState((state) => state.filtered.count)
  return (
    <div role="status" className="sr-only">
      {count === 0 ? "Nothing matches." : ""}
    </div>
  )
}

/**
 * Mirrors cmdk's picked row for the footer. Selection stays uncontrolled, so
 * cmdk picks the first row as results arrive and keeps aria-activedescendant
 * in step.
 */
function SelectionMirror({ onChange }: { onChange: (value: string) => void }) {
  const value = useCommandState((state) => state.value)
  useEffect(() => onChange(value ?? ""), [value, onChange])
  return null
}

/**
 * Where the phone keyboard leaves the page visible. A fixed sheet keeps its
 * full height under the keyboard, which would hide the last rows for good.
 * It is tracked while closed too, so the sheet keeps its size as it fades out
 * and opens at the current one.
 */
function useVisibleViewport(active: boolean): { top: number; height: number } | null {
  const [box, setBox] = useState<{ top: number; height: number } | null>(null)
  useEffect(() => {
    const viewport = window.visualViewport
    if (!active || !viewport) return
    const update = () => setBox({ top: viewport.offsetTop, height: viewport.height })
    update()
    viewport.addEventListener("resize", update)
    viewport.addEventListener("scroll", update)
    return () => {
      viewport.removeEventListener("resize", update)
      viewport.removeEventListener("scroll", update)
    }
  }, [active])
  return active ? box : null
}

const PALETTE_OVERLAY = "command-palette"

/**
 * Runs `action` once Back has taken the sheet's history entry away. Closing
 * the sheet on a phone steps back off that entry, and a page opened before
 * the step lands would be undone by it.
 */
function afterOverlayEntry(history: RouterHistory, action: () => void) {
  if (history.location.state.overlay !== PALETTE_OVERLAY) return action()
  let done = false
  const finish = () => {
    if (done) return
    done = true
    stop()
    window.clearTimeout(timer)
    action()
  }
  const stop = history.subscribe(() => {
    if (history.location.state.overlay !== PALETTE_OVERLAY) finish()
  })
  const timer = window.setTimeout(finish, 1000)
}

export function CommandPalette() {
  const isOpen = useCommandPaletteOpen()
  const navigate = useNavigate()
  const router = useRouter()
  const { range, customRange, lastRefresh } = useTimeRange()
  const [timeFormat] = useTimeFormat()
  const { status: security, isError: securityError } = useSecurityNavStatus()
  const routeHeader = useRouteHeader()
  const phone = usePhoneLayout()
  const inputRef = useRef<HTMLInputElement>(null)
  const sheetBox = useVisibleViewport(phone)
  // Back closes the sheet before it leaves the page, as with the other phone overlays.
  useOverlayEntry(PALETTE_OVERLAY, phone && isOpen, closeCommandPalette)
  // Crossing the phone breakpoint swaps the field, and the new one needs focus to keep typing.
  useEffect(() => {
    if (commandPaletteOpen()) inputRef.current?.focus()
  }, [phone])
  // A sign-out unmounts the shell. Closing here keeps the palette shut after the next sign-in.
  useEffect(() => () => resetCommandPalette(), [])
  const { ip: inspected, open: inspect } = useIpInspector()
  useEffect(() => {
    // A hand-edited ?inspect= link can hold anything. The list keeps real addresses only.
    if (inspected && isValidIp(inspected)) rememberInspectedIp(canonicalIp(inspected))
  }, [inspected])
  const recentIps = useRecentIps()
  const report = useAbuseReportDialog()
  const [search, setSearch] = useState("")
  const [selected, setSelected] = useState("")
  // The arrow keys set it and typing clears it, so a highlight the user moved stays put.
  const highlightMoved = useRef(false)
  const [ipStatus, setIpStatus] = useState("")
  // A touch screen hides the highlight on the picked row until the arrow keys move it.
  const [arrowKeysUsed, setArrowKeysUsed] = useState(false)
  // A country, city, host, server or network picked from the name search, waiting for a page.
  const [picked, setPicked] = useState<PickedValue | null>(null)
  // Each opening starts empty. Clearing on open, not on close, keeps the list
  // as it was while the dialog fades out.
  const [wasOpen, setWasOpen] = useState(isOpen)
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen)
    if (isOpen) {
      setSearch("")
      setArrowKeysUsed(false)
      setPicked(null)
    }
  }
  const settledSearch = useDebouncedValue(search, 150)
  // The list follows the live text, so IP search starts and ends with the
  // keystroke. Only the request waits for the text to settle.
  const ipQuery = parseIpQuery(search)
  const { data: crowdsec } = useQuery({
    queryKey: queryKeys.crowdsec.status,
    queryFn: fetchCrowdsecStatus,
    staleTime: 60_000,
    enabled: isOpen,
  })

  const pages = [...NAV_ITEMS, SETTINGS_ITEM]
    .filter((item) => !item.requiresSecurityFeature || security?.enabled === true)
    .sort((a, b) => PAGE_ORDER.indexOf(GO_TO[a.id]) - PAGE_ORDER.indexOf(GO_TO[b.id]))
  // The tab bar already holds the other pages. A search still finds them.
  const shownPages =
    phone && search === ""
      ? moreItems(slotFour(security, securityError)).sort(
          (a, b) => PHONE_PAGE_ORDER.indexOf(a.id) - PHONE_PAGE_ORDER.indexOf(b.id),
        )
      : pages

  const currentRange =
    range === "custom"
      ? timeRangeSpan(range, customRange, lastRefresh, timeFormat)
      : timeRangeName(range).toLowerCase()

  const run = (action: () => void) => {
    // Enter during the closing animation would still select a row.
    if (!commandPaletteOpen()) return
    closeCommandPaletteThen(() => afterOverlayEntry(router.history, action))
  }

  const onAddress = selected.startsWith(ADDRESS_ROW)

  const pick = (value: PickedValue) => {
    setPicked(value)
    setSearch("")
    inputRef.current?.focus()
  }
  const unpick = () => {
    setPicked(null)
    // Text typed to narrow the page list would start a name search of its own.
    setSearch("")
    inputRef.current?.focus()
  }
  const type = (text: string) => {
    highlightMoved.current = false
    setSearch(text)
  }
  // Name rows arrive after cmdk has highlighted the best page or action, and cmdk keeps
  // that highlight when rows mount above it. A loose match such as "Change the time
  // range" for "git" gives way to the top row, the way cmdk's own Home key moves it.
  const raiseNameRows = () => {
    if (highlightMoved.current || paletteFilter(selected, search) >= NAME_ROW_SCORE) return
    requestAnimationFrame(() =>
      inputRef.current?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })),
    )
  }

  const ipActions: IpActions = {
    inspect: (ip) => run(() => inspect(ip)),
    openInAccessLogs: (ips) =>
      run(() => {
        // A filter means nothing to the Live tail, so the page opens on History.
        requestAccessLogsTab("history")
        void navigate({ to: "/access-logs", search: { ip: ips } })
      }),
    searchDecisions: (query) =>
      run(() => {
        requestDecisionsSearch(query)
        void navigate({ to: "/security", search: { tab: "decisions" } })
      }),
    banRange: (target) => run(() => openBanDialogFor(target)),
    report: ({ ip, asn, organization }) =>
      run(() => report.openFor({ kind: "ip", ip, asn, organization })),
  }

  const goTo = (
    <CommandGroup heading="Go to" className={GROUP}>
      {shownPages.map((item) => (
        <CommandItem
          key={item.id}
          value={item.title}
          onSelect={() => run(() => void navigate({ to: item.url }))}
          className={ITEM}
        >
          <ItemIcon icon={item.icon} />
          <span className="min-w-0 flex-1 truncate">{item.title}</span>
          {phone ? <PhoneChevron /> : <Keys id={GO_TO[item.id]} />}
        </CommandItem>
      ))}
    </CommandGroup>
  )

  const timeRangeAction = routeHeader.timeRange && (
    <CommandItem
      value="change the time range"
      onSelect={() => run(() => runShortcut("time-range"))}
      className={ITEM}
    >
      <ItemIcon icon={CalendarDays} />
      <RowText detail={`${phone ? "Now" : "now"}: ${currentRange}`}>
        <span className="min-w-0 truncate">Change the time range…</span>
      </RowText>
      {!phone && <Keys id="time-range" />}
    </CommandItem>
  )

  const actions = (
    <CommandGroup heading={ipQuery ? "More actions" : "Actions"} className={GROUP}>
      {/* A phone puts the range last, where its two lines sit apart from the one-line rows. */}
      {!phone && timeRangeAction}
      {crowdsec?.writeEnabled && (
        <CommandItem
          value="ban an ip or range"
          onSelect={() => run(() => runShortcut("ban"))}
          className={ITEM}
        >
          <ItemIcon icon={Ban} />
          <span className="min-w-0 flex-1 truncate">Ban an IP or range…</span>
          {!phone && <Keys id="ban" />}
        </CommandItem>
      )}
      <CommandItem
        value="start the live tail"
        onSelect={() => run(() => runShortcut("live-tail"))}
        className={ITEM}
      >
        <ItemIcon icon={Radio} />
        <span className="min-w-0 flex-1 truncate">Start the live tail</span>
        {!phone && <Keys id="live-tail" />}
      </CommandItem>
      {phone && timeRangeAction}
    </CommandGroup>
  )

  return (
    <Dialog open={isOpen} onOpenChange={setCommandPaletteOpen}>
      <DialogContent
        data-command-palette=""
        showCloseButton={false}
        className={cn(
          "top-[17vh] translate-y-0 gap-0 overflow-hidden rounded-xl! p-0 sm:max-w-[660px]",
          phone &&
            "top-0 left-0 flex h-dvh w-full max-w-none translate-x-0 flex-col rounded-none! border-0 bg-background pt-[env(safe-area-inset-top,0px)] pr-[env(safe-area-inset-right,0px)] pl-[env(safe-area-inset-left,0px)] shadow-none data-[state=closed]:zoom-out-100 data-[state=open]:zoom-in-100 sm:max-w-none",
        )}
        style={sheetBox ? { top: sheetBox.top, height: sheetBox.height } : undefined}
        onEscapeKeyDown={(event) => {
          // Escape steps back from the page list to the search before it closes the palette.
          if (!picked) return
          event.preventDefault()
          unpick()
        }}
        onCloseAutoFocus={(event) => {
          const { opener, action } = takeCommandPaletteClose()
          // Opened from the keyboard there is no trigger to return to, so focus goes
          // back to the opener. An action runs after that, so a menu or dialog it
          // opens returns focus there too.
          if (opener?.isConnected) {
            event.preventDefault()
            opener.focus({ preventScroll: true })
          }
          action?.()
        }}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Search and commands</DialogTitle>
          <DialogDescription>Go to a page or run an action.</DialogDescription>
        </DialogHeader>
        {/* cmdk binds Ctrl+K to "up". The palette needs it to close. */}
        <Command
          className={cn("bg-transparent", phone && "min-h-0 flex-1 rounded-none! p-0")}
          vimBindings={false}
          label="Search IPs, hosts, countries, pages and actions"
          filter={paletteFilter}

          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              setArrowKeysUsed(true)
              highlightMoved.current = true
            }
            if (event.key === "Backspace" && picked && search === "") {
              event.preventDefault()
              unpick()
              return
            }
            // Ctrl+Enter opens an address in Access Logs instead of the inspector.
            const value =
              event.currentTarget
                .querySelector('[cmdk-item][data-selected="true"]')
                ?.getAttribute("data-value") ?? ""
            const ip = value.startsWith(ADDRESS_ROW) ? value.slice(ADDRESS_ROW.length) : null
            if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey) || !ip) return
            event.preventDefault()
            ipActions.openInAccessLogs([ip])
          }}
        >
          {phone ? (
            <div className="flex items-center gap-3 border-b border-border/60 py-2.5 pr-4 pl-4 [&_[data-slot=command-input-wrapper]]:p-0 [&_[data-slot=input-group]]:h-11! [&_[data-slot=input-group]]:rounded-xl! [&_[data-slot=input-group]]:border-border [&_[data-slot=command-input]]:text-base">
              <div
                className={cn(
                  "relative min-w-0 flex-1",
                  picked &&
                    "flex items-center rounded-xl border border-border bg-input/30 pl-1.5 [&_[data-slot=command-input-wrapper]]:min-w-0 [&_[data-slot=command-input-wrapper]]:flex-1 [&_[data-slot=input-group-addon]]:hidden [&_[data-slot=input-group]]:border-0! [&_[data-slot=input-group]]:bg-transparent!",
                )}
              >
                {picked && (
                  <PickedChip picked={picked} onRemove={unpick} onKeyDown={keepKeyFromList} />
                )}
                <CommandInput
                  ref={inputRef}
                  placeholder={picked ? "Pick a page" : "IP, host, country or action"}
                  aria-describedby={picked ? PICKED_LABEL_ID : undefined}
                  className={cn(search !== "" && "pr-9")}
                  value={search}
                  onValueChange={type}
                />
                {search !== "" && (
                  <button
                    type="button"
                    aria-label="Clear the search"
                    onKeyDown={keepKeyFromList}
                    onClick={() => {
                      setSearch("")
                      inputRef.current?.focus()
                    }}
                    className="absolute top-1/2 right-1 grid size-9 -translate-y-1/2 place-items-center rounded-full text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <CircleX aria-hidden className="size-5" />
                  </button>
                )}
              </div>
              <button
                type="button"
                onKeyDown={keepKeyFromList}
                onClick={closeCommandPalette}
                className="-mr-2 shrink-0 rounded-md px-2 py-2 text-[15px] font-medium text-primary focus-visible:outline-2 focus-visible:outline-ring"
              >
                Cancel
              </button>
            </div>
          ) : (
            <div
              className={cn(
                "relative border-b border-border/60 [&_[data-slot=command-input-wrapper]]:p-2 [&_[data-slot=input-group]]:h-11! [&_[data-slot=input-group]]:border-0 [&_[data-slot=input-group]]:bg-transparent [&_[data-slot=command-input]]:text-base",
                picked &&
                  "flex items-center pl-4 [&_[data-slot=command-input-wrapper]]:min-w-0 [&_[data-slot=command-input-wrapper]]:flex-1 [&_[data-slot=input-group-addon]]:hidden",
              )}
            >
              {picked && (
                <PickedChip picked={picked} onRemove={unpick} onKeyDown={keepKeyFromList} />
              )}
              <CommandInput
                ref={inputRef}
                placeholder={
                  picked ? "Pick a page" : "Search IPs, hosts, countries, pages and actions"
                }
                aria-describedby={picked ? PICKED_LABEL_ID : undefined}
                className="pr-14"
                value={search}
                onValueChange={type}
              />
              <Kbd
                aria-hidden
                className={cn(KEY, "pointer-events-none absolute top-1/2 right-4 -translate-y-1/2")}
              >
                Esc
              </Kbd>
            </div>
          )}
          <CommandList
            className={cn(
              "max-h-[min(28rem,60vh)] px-1.5 py-2",
              phone &&
                "max-h-none flex-1 overscroll-contain px-1 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom,0px))]",
              phone &&
                !arrowKeysUsed &&
                "pointer-coarse:[&_[cmdk-item][data-selected=true]]:bg-transparent pointer-coarse:[&_[cmdk-item][data-selected=true]]:ring-transparent pointer-coarse:[&_[cmdk-item][data-selected=true]>span>svg]:text-muted-foreground",
            )}
          >
            <CommandEmpty>Nothing matches.</CommandEmpty>
            {picked ? (
              <PickedTargets picked={picked} onGo={(go) => run(() => go(navigate))} />
            ) : (
              <>
                {ipQuery ? (
                  <IpSearchGroups
                    query={ipQuery}
                    actions={ipActions}
                    crowdsecEnabled={crowdsec?.enabled === true}
                    canBan={crowdsec?.writeEnabled === true}
                    enabled={isOpen}
                    current={settledSearch === search}
                    onStatus={setIpStatus}
                  />
                ) : (
                  search === "" && (
                    <RecentIpsGroup ips={recentIps} actions={ipActions} enabled={isOpen} />
                  )
                )}
                {!ipQuery && (
                  <FilterValueGroups
                    search={search}
                    settled={settledSearch}
                    enabled={isOpen}
                    onPick={pick}
                    onArrived={raiseNameRows}
                  />
                )}
                {phone ? (
                  <>
                    {actions}
                    {goTo}
                  </>
                ) : (
                  <>
                    {goTo}
                    {actions}
                  </>
                )}
              </>
            )}
          </CommandList>
          <NoMatchStatus />
          <div role="status" className="sr-only">
            {picked ? `${pickedLabel(picked)}. Pick a page.` : ipStatus}
          </div>
          <SelectionMirror onChange={setSelected} />
        </Command>
        {/* Outside Command, whose Enter handler would run the highlighted row instead. */}
        {!phone && (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-border/60 px-4 py-2.5 text-xs text-muted-foreground">
            <span aria-hidden className="flex items-center gap-1.5">
              <KbdGroup>
                <Kbd className={KEY}>
                  <ArrowUp />
                </Kbd>
                <Kbd className={KEY}>
                  <ArrowDown />
                </Kbd>
              </KbdGroup>
              move
            </span>
            <span aria-hidden className="flex items-center gap-1.5">
              <Kbd className={KEY}>
                <CornerDownLeft />
              </Kbd>
              {onAddress ? "open the inspector" : "open"}
            </span>
            {onAddress && (
              <span aria-hidden className="flex items-center gap-1.5">
                <KbdGroup>
                  <Kbd className={KEY}>{modifierLabel()}</Kbd>
                  <Kbd className={KEY}>
                    <CornerDownLeft />
                  </Kbd>
                </KbdGroup>
                open in Access Logs
              </span>
            )}
            <button
              type="button"
              onClick={() => run(() => openShortcutsCheatSheet())}
              aria-label="All shortcuts"
              className="flex items-center gap-1.5 rounded-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
              <Kbd className={KEY}>?</Kbd>
              all shortcuts
            </button>
          </div>
        )}
      </DialogContent>
      {report.dialog}
    </Dialog>
  )
}

/** The top bar's search field. It only opens the palette, so it is a button that looks like a field. */
export function CommandPaletteField() {
  return (
    <>
      <button
        type="button"
        onClick={(event) => openCommandPalette(event.currentTarget)}
        aria-keyshortcuts={ariaKeyShortcut("k")}
        className="hidden h-9 w-80 items-center gap-2 rounded-md border border-input bg-input/30 px-3 text-left text-[13px] text-muted-foreground transition-colors hover:bg-input/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring @4xl:flex"
      >
        <Search aria-hidden className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">Search IPs, hosts, pages…</span>
        <KbdGroup aria-hidden>
          <Kbd className={KEY}>{modifierLabel()}</Kbd>
          <Kbd className={KEY}>K</Kbd>
        </KbdGroup>
      </button>
      <Button
        variant="outline"
        size="icon"
        onClick={(event) => openCommandPalette(event.currentTarget)}
        aria-keyshortcuts={ariaKeyShortcut("k")}
        className="size-9 @4xl:hidden"
      >
        <Search className="size-4" />
        <span className="sr-only">Search and commands</span>
      </Button>
    </>
  )
}

/** The phone header's search button, round like the refresh button beside it. */
export function PhoneSearchButton() {
  return (
    <Button
      variant="outline"
      size="icon-sm"
      onClick={(event) => openCommandPalette(event.currentTarget)}
      className="shrink-0 rounded-full"
    >
      <Search className="size-4" />
      <span className="sr-only">Search and commands</span>
    </Button>
  )
}
