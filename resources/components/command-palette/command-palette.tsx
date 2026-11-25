/**
 * Search and commands. Ctrl+K, or the search field in the top bar, opens one
 * list of pages and actions. Each row shows its keyboard shortcut, so the
 * keys are learned along the way.
 */
import { useEffect, useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { defaultFilter, useCommandState } from "cmdk"
import { ArrowDown, ArrowUp, Ban, CalendarDays, CornerDownLeft, Radio, Search } from "lucide-react"

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
  RecentIpsGroup,
  type IpActions,
} from "@/components/command-palette/ip-results"
import { useDebouncedValue } from "@/hooks/use-debounced-value"
import { useIpInspector } from "@/lib/ip-inspector"
import { parseIpQuery } from "@/lib/ip-prefix"
import { rememberInspectedIp, useRecentIps } from "@/lib/recent-ips"
import { useRouteHeader } from "@/lib/route-header"
import { fetchCrowdsecStatus } from "@/lib/api"
import { NAV_ITEMS, SETTINGS_ITEM, type NavId } from "@/lib/phone-nav"
import {
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

/** IP rows come from the server, which already matched them, so the typed text never hides them. */
function paletteFilter(value: string, search: string, keywords?: string[]): number {
  return value.startsWith(IP_ROW) ? 1 : defaultFilter(value, search, keywords)
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

export function CommandPalette() {
  const isOpen = useCommandPaletteOpen()
  const navigate = useNavigate()
  const { range, customRange, lastRefresh } = useTimeRange()
  const [timeFormat] = useTimeFormat()
  const { status: security } = useSecurityNavStatus()
  const routeHeader = useRouteHeader()
  const phone = usePhoneLayout()
  // A sign-out unmounts the shell. Closing here keeps the palette shut after the next sign-in.
  useEffect(() => () => resetCommandPalette(), [])
  const { ip: inspected, open: inspect } = useIpInspector()
  useEffect(() => {
    if (inspected) rememberInspectedIp(inspected)
  }, [inspected])
  const recentIps = useRecentIps()
  const report = useAbuseReportDialog()
  const [search, setSearch] = useState("")
  const [selected, setSelected] = useState("")
  // Every opening starts with an empty field.
  if (!isOpen && search !== "") setSearch("")
  if (!isOpen && selected !== "") setSelected("")
  const ipQuery = parseIpQuery(useDebouncedValue(search, 150))
  const { data: crowdsec } = useQuery({
    queryKey: queryKeys.crowdsec.status,
    queryFn: fetchCrowdsecStatus,
    staleTime: 60_000,
    enabled: isOpen,
  })

  const pages = [...NAV_ITEMS, SETTINGS_ITEM]
    .filter((item) => !item.requiresSecurityFeature || security?.enabled === true)
    .sort((a, b) => PAGE_ORDER.indexOf(GO_TO[a.id]) - PAGE_ORDER.indexOf(GO_TO[b.id]))

  const currentRange =
    range === "custom"
      ? timeRangeSpan(range, customRange, lastRefresh, timeFormat)
      : timeRangeName(range).toLowerCase()

  const run = (action: () => void) => {
    // Enter during the closing animation would still select a row.
    if (!commandPaletteOpen()) return
    closeCommandPaletteThen(action)
  }

  const onAddress = selected.startsWith(ADDRESS_ROW)

  const ipActions: IpActions = {
    inspect: (ip) => run(() => inspect(ip)),
    openInAccessLogs: (ips) =>
      run(() => void navigate({ to: "/access-logs", search: { ip: ips } })),
    searchDecisions: (query) =>
      run(() => void navigate({ to: "/security", search: { tab: "decisions", q: query } })),
    banRange: (target) => run(() => openBanDialogFor(target)),
    report: ({ ip, asn, organization }) =>
      run(() => report.openFor({ kind: "ip", ip, asn, organization })),
  }

  return (
    <Dialog open={isOpen} onOpenChange={setCommandPaletteOpen}>
      <DialogContent
        data-command-palette=""
        showCloseButton={false}
        className="top-[17vh] translate-y-0 gap-0 overflow-hidden rounded-xl! p-0 sm:max-w-[660px]"
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
          className="bg-transparent"
          vimBindings={false}
          label="Search IPs, pages and actions"
          filter={paletteFilter}
          value={selected}
          onValueChange={setSelected}
          onKeyDown={(event) => {
            // Ctrl+Enter opens an address in Access Logs instead of the inspector.
            const ip = selected.startsWith(ADDRESS_ROW) ? selected.slice(ADDRESS_ROW.length) : null
            if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey) || !ip) return
            event.preventDefault()
            ipActions.openInAccessLogs([ip])
          }}
        >
          <div className="relative border-b border-border/60 [&_[data-slot=command-input-wrapper]]:p-2 [&_[data-slot=input-group]]:h-11! [&_[data-slot=input-group]]:border-0 [&_[data-slot=input-group]]:bg-transparent [&_[data-slot=command-input]]:text-base">
            <CommandInput
              placeholder="Search IPs, pages and actions"
              className="pr-14"
              value={search}
              onValueChange={setSearch}
            />
            <Kbd
              aria-hidden
              className={cn(KEY, "pointer-events-none absolute top-1/2 right-4 -translate-y-1/2")}
            >
              Esc
            </Kbd>
          </div>
          <CommandList className="max-h-[min(28rem,60vh)] px-1.5 py-2">
            <CommandEmpty>Nothing matches.</CommandEmpty>
            {ipQuery ? (
              <IpSearchGroups
                query={ipQuery}
                actions={ipActions}
                crowdsecEnabled={crowdsec?.enabled === true}
                canBan={crowdsec?.writeEnabled === true}
                enabled={isOpen}
                onTopAddress={setSelected}
              />
            ) : (
              search === "" && (
                <RecentIpsGroup ips={recentIps} actions={ipActions} enabled={isOpen} />
              )
            )}
            <CommandGroup heading="Go to" className={GROUP}>
              {pages.map((item) => (
                <CommandItem
                  key={item.id}
                  value={item.title}
                  onSelect={() => run(() => void navigate({ to: item.url }))}
                  className={ITEM}
                >
                  <ItemIcon icon={item.icon} />
                  {item.title}
                  <Keys id={GO_TO[item.id]} />
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandGroup heading={ipQuery ? "More actions" : "Actions"} className={GROUP}>
              {routeHeader.timeRange && !phone && (
                <CommandItem
                  value="change the time range"
                  onSelect={() => run(() => runShortcut("time-range"))}
                  className={ITEM}
                >
                  <ItemIcon icon={CalendarDays} />
                  Change the time range…
                  <span className="text-muted-foreground">now: {currentRange}</span>
                  <Keys id="time-range" />
                </CommandItem>
              )}
              {crowdsec?.writeEnabled && (
                <CommandItem
                  value="ban an ip or range"
                  onSelect={() => run(() => runShortcut("ban"))}
                  className={ITEM}
                >
                  <ItemIcon icon={Ban} />
                  Ban an IP or range…
                  <Keys id="ban" />
                </CommandItem>
              )}
              <CommandItem
                value="start the live tail"
                onSelect={() => run(() => runShortcut("live-tail"))}
                className={ITEM}
              >
                <ItemIcon icon={Radio} />
                Start the live tail
                <Keys id="live-tail" />
              </CommandItem>
            </CommandGroup>
          </CommandList>
          <NoMatchStatus />
        </Command>
        {/* Outside Command, whose Enter handler would run the highlighted row instead. */}
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
          {onAddress && <span className="ml-auto">Paste any IP</span>}
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
        <span className="min-w-0 flex-1 truncate">Search IPs, pages and actions…</span>
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
