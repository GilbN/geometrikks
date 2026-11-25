/**
 * Search and commands. Ctrl+K, or the search field in the top bar, opens one
 * list of pages and actions. Each row shows its keyboard shortcut, so the
 * keys are learned along the way.
 */
import { useRef, useSyncExternalStore } from "react"
import { useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { ArrowDown, ArrowUp, Ban, CalendarDays, CornerDownLeft, Radio, Search } from "lucide-react"
import type { LucideIcon } from "lucide-react"

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
import { openShortcutsCheatSheet, runShortcut } from "@/components/shortcuts/keyboard-shortcuts"
import { useRouteHeader } from "@/lib/route-header"
import { fetchCrowdsecStatus } from "@/lib/api"
import { NAV_ITEMS, SETTINGS_ITEM } from "@/lib/phone-nav"
import { queryKeys, useSecurityNavStatus } from "@/lib/queries"
import { SHORTCUTS, shortcutKeyLabels, type ShortcutId } from "@/lib/shortcuts"
import { timeRangeName, timeRangeSpan } from "@/lib/time-range-label"
import { useTimeRange } from "@/lib/time-range-context"
import { useTimeFormat } from "@/lib/table-view"
import { cn } from "@/lib/utils"

let open = false
const listeners = new Set<() => void>()

function setOpen(next: boolean): void {
  if (next === open) return
  open = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function openCommandPalette(): void {
  setOpen(true)
}

export function closeCommandPalette(): void {
  setOpen(false)
}

export function commandPaletteOpen(): boolean {
  return open
}

const GO_TO: Record<string, ShortcutId> = {
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

const ITEM =
  "min-h-10 gap-3 rounded-lg! px-2.5 text-sm ring-1 ring-transparent data-selected:bg-primary/12 data-selected:ring-primary/50"

function ItemIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted/60">
      <Icon className="size-4 text-muted-foreground" />
    </span>
  )
}

export function CommandPalette() {
  const isOpen = useSyncExternalStore(subscribe, () => open)
  const navigate = useNavigate()
  const { range, customRange, lastRefresh } = useTimeRange()
  const [timeFormat] = useTimeFormat()
  const { status: security } = useSecurityNavStatus()
  const routeHeader = useRouteHeader()
  const { data: crowdsec } = useQuery({
    queryKey: queryKeys.crowdsec.status,
    queryFn: fetchCrowdsecStatus,
    staleTime: 60_000,
    enabled: isOpen,
  })
  // An action that opens a menu or dialog waits for the palette to close and hand focus back.
  const afterClose = useRef<(() => void) | null>(null)

  const pages = [...NAV_ITEMS, SETTINGS_ITEM]
    .filter((item) => !item.requiresSecurityFeature || security?.enabled === true)
    .sort((a, b) => PAGE_ORDER.indexOf(GO_TO[a.id]) - PAGE_ORDER.indexOf(GO_TO[b.id]))

  const currentRange =
    range === "custom"
      ? timeRangeSpan(range, customRange, lastRefresh, timeFormat)
      : timeRangeName(range).toLowerCase()

  const run = (action: () => void) => {
    afterClose.current = action
    setOpen(false)
  }

  return (
    <Dialog open={isOpen} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        className="top-[17vh] translate-y-0 gap-0 overflow-hidden rounded-xl! p-0 sm:max-w-[660px]"
        onCloseAutoFocus={(event) => {
          const action = afterClose.current
          afterClose.current = null
          if (!action) return
          event.preventDefault()
          action()
        }}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Search and commands</DialogTitle>
          <DialogDescription>Go to a page or run an action.</DialogDescription>
        </DialogHeader>
        {/* cmdk binds Ctrl+K to "up". The palette needs it to close. */}
        <Command className="bg-transparent" vimBindings={false}>
          <div className="relative border-b border-border/60 [&_[data-slot=command-input-wrapper]]:p-2 [&_[data-slot=input-group]]:h-11! [&_[data-slot=input-group]]:border-0 [&_[data-slot=input-group]]:bg-transparent [&_[data-slot=command-input]]:text-base">
            <CommandInput placeholder="Search pages and actions" className="pr-14" />
            <Kbd
              className={cn(KEY, "pointer-events-none absolute top-1/2 right-4 -translate-y-1/2")}
            >
              Esc
            </Kbd>
          </div>
          <CommandList className="max-h-[min(28rem,60vh)] px-1.5 py-2">
            <CommandEmpty>Nothing matches.</CommandEmpty>
            <CommandGroup
              heading="Go to"
              className="**:[[cmdk-group-heading]]:text-[11px] **:[[cmdk-group-heading]]:font-semibold **:[[cmdk-group-heading]]:tracking-[0.08em] **:[[cmdk-group-heading]]:uppercase"
            >
              {pages.map((item) => (
                <CommandItem
                  key={item.id}
                  value={`go ${item.title}`}
                  onSelect={() => run(() => void navigate({ to: item.url }))}
                  className={ITEM}
                >
                  <ItemIcon icon={item.icon} />
                  {item.title}
                  <Keys id={GO_TO[item.id]} />
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandGroup
              heading="Actions"
              className="**:[[cmdk-group-heading]]:text-[11px] **:[[cmdk-group-heading]]:font-semibold **:[[cmdk-group-heading]]:tracking-[0.08em] **:[[cmdk-group-heading]]:uppercase"
            >
              {routeHeader.timeRange && (
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
              open
            </span>
            <button
              type="button"
              onClick={() => run(() => openShortcutsCheatSheet())}
              className="flex items-center gap-1.5 rounded-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
              <Kbd className={KEY}>?</Kbd>
              all shortcuts
            </button>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  )
}

/** The top bar's search field. It only opens the palette, so it is a button that looks like a field. */
export function CommandPaletteField() {
  return (
    <>
      <button
        type="button"
        onClick={openCommandPalette}
        aria-label="Search and commands"
        aria-keyshortcuts="Control+K"
        className="hidden h-9 w-80 items-center gap-2 rounded-md border border-input bg-input/30 px-3 text-left text-[13px] text-muted-foreground transition-colors hover:bg-input/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring @4xl:flex"
      >
        <Search aria-hidden className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">Search pages and actions…</span>
        <KbdGroup aria-hidden>
          <Kbd className={KEY}>Ctrl</Kbd>
          <Kbd className={KEY}>K</Kbd>
        </KbdGroup>
      </button>
      <Button
        variant="outline"
        size="icon"
        onClick={openCommandPalette}
        aria-keyshortcuts="Control+K"
        className="size-9 @4xl:hidden"
      >
        <Search className="size-4" />
        <span className="sr-only">Search and commands</span>
      </Button>
    </>
  )
}
