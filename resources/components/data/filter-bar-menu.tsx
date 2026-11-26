/**
 * The filter bar's add button and its Filter menu: the page's fields, which
 * can be pinned to the bar, then Hide my IP and Hide muted IPs. Typing finds
 * fields by name and, on pages that pass `valueSearch`, values by name across
 * fields, busiest first.
 */
import { useRef, useState } from "react"
import { EyeOff, Pin, Plus, UserX } from "lucide-react"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Switch } from "@/components/ui/switch"
import { CountryFlag } from "@/components/country-flag"
import { UNTRUSTED_PROXY_HINT } from "@/components/data/exclude-my-ip"
import type { FilterBarField } from "@/components/data/filter-bar-fields"
import {
  NAME_SEARCH_MAX,
  NAME_SEARCH_MIN,
  useFilterValueSearch,
  type PickedValue,
} from "@/components/command-palette/filter-value-results"
import { useDebouncedValue } from "@/hooks/use-debounced-value"
import type { MutedScope } from "@/lib/muted-ips"
import type { MyIpExclusion } from "@/lib/my-ip-exclusion"
import { cn } from "@/lib/utils"

/** A page whose values the Filter menu can search, and what a picked value sets. */
export interface FilterValueSearch {
  onPick: (picked: PickedValue) => void
}

const ITEM = "h-8 gap-2 rounded-sm px-2 text-sm data-selected:bg-accent [&>svg:last-child]:hidden"
const HEADING =
  "p-1 pt-0 **:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:pt-2 **:[[cmdk-group-heading]]:pb-1 **:[[cmdk-group-heading]]:text-[11px] **:[[cmdk-group-heading]]:font-semibold **:[[cmdk-group-heading]]:tracking-[0.08em] **:[[cmdk-group-heading]]:uppercase"
const number = new Intl.NumberFormat()

export function AddFilterMenu({
  ref,
  compact,
  fields,
  pins,
  onTogglePin,
  onPickField,
  myIp,
  muted,
  onToggleMuted,
  valueSearch,
}: {
  ref: React.Ref<HTMLButtonElement>
  /** A plus only, once the bar holds a chip. */
  compact: boolean
  fields: FilterBarField[]
  pins: string[]
  onTogglePin: (fieldId: string) => void
  onPickField: (fieldId: string) => void
  myIp?: MyIpExclusion
  muted?: MutedScope
  onToggleMuted?: () => void
  valueSearch?: FilterValueSearch
}) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState("")
  const picked = useRef(false)
  const typed = text.trim().toLowerCase()
  const settled = useDebouncedValue(text, 150)
  const asking =
    valueSearch !== undefined && typed.length >= NAME_SEARCH_MIN && typed.length <= NAME_SEARCH_MAX
  const { data, isFetching, isPlaceholderData } = useFilterValueSearch(settled, open && asking)
  // Rows for older text would let Enter pick a match for something no longer typed.
  const current = !isPlaceholderData && settled.trim() === text.trim()
  const shownFields = fields.filter((field) => field.label.toLowerCase().includes(typed))
  const groups = asking && current && data ? valueGroups(data) : []
  const showMyIp = myIp !== undefined && (myIp.ip !== null || myIp.behindUntrustedProxy)
  const showMuted = muted !== undefined && onToggleMuted !== undefined && muted.chip !== "none"
  const searching = asking && (isFetching || !current)

  const changeOpen = (next: boolean) => {
    setOpen(next)
    if (next) {
      picked.current = false
      setText("")
    }
  }
  const pickField = (fieldId: string) => {
    picked.current = true
    setOpen(false)
    onPickField(fieldId)
  }
  const pickValue = (value: PickedValue) => {
    setOpen(false)
    valueSearch?.onPick(value)
  }

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <button
          ref={ref}
          type="button"
          aria-label="Add a filter"
          title="Add a filter"
          className={cn(
            "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-dashed border-muted-foreground/55 text-[13px] font-medium text-muted-foreground outline-none hover:border-solid hover:text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
            "data-[state=open]:border-solid data-[state=open]:border-ring data-[state=open]:text-foreground data-[state=open]:ring-3 data-[state=open]:ring-ring/50",
            compact ? "w-8" : "pr-[11px] pl-[9px]",
          )}
        >
          <Plus aria-hidden className="size-3.5" />
          {!compact && "Filter"}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        // The list scrolls in what the search field and the pin note leave of the room below.
        className={cn(
          "max-h-(--radix-popover-content-available-height) gap-0 overflow-hidden p-0",
          groups.length > 0 ? "w-[324px]" : "w-[248px]",
        )}
        // A picked field opens its chip's picker, which takes the focus.
        onCloseAutoFocus={(event) => picked.current && event.preventDefault()}
      >
        {/* No vim bindings, so Ctrl+K still opens the palette. */}
        <Command
          label="Filter by"
          shouldFilter={false}
          vimBindings={false}
          className="rounded-none! p-0"
          loop
        >
          <CommandInput
            value={text}
            onValueChange={setText}
            placeholder="Filter by…"
            aria-label="Filter by"
          />
          <CommandList className="max-h-[28rem] min-h-0 flex-1">
            <CommandEmpty className="py-3 text-xs text-muted-foreground">
              {searching ? "Searching…" : "No matches"}
            </CommandEmpty>
            {shownFields.length > 0 && (
              <CommandGroup className="p-1">
                {shownFields.map((field) => {
                  const Icon = field.icon
                  const isPinned = pins.includes(field.id)
                  return (
                    <CommandItem
                      key={field.id}
                      value={`field:${field.id}`}
                      onSelect={() => pickField(field.id)}
                      className={cn(ITEM, "group/field")}
                    >
                      <Icon aria-hidden className="size-[15px] text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{field.label}</span>
                      {field.exclude && (
                        <span className="text-xs text-muted-foreground">is / is not</span>
                      )}
                      <button
                        type="button"
                        aria-label={isPinned ? `Unpin ${field.label}` : `Pin ${field.label}`}
                        aria-pressed={isPinned}
                        title={isPinned ? "Unpin from the bar" : "Pin to the bar"}
                        // cmdk would run the highlighted row on Enter and on a click.
                        onKeyDown={(event) => event.key === "Enter" && event.stopPropagation()}
                        onPointerDown={(event) => event.preventDefault()}
                        onClick={(event) => {
                          event.stopPropagation()
                          onTogglePin(field.id)
                        }}
                        className={cn(
                          "-mr-1 grid size-6 shrink-0 place-items-center rounded-sm outline-none hover:bg-background/60 focus-visible:ring-2 focus-visible:ring-ring",
                          isPinned
                            ? "text-primary"
                            : "text-muted-foreground opacity-0 group-hover/field:opacity-100 group-data-selected/field:opacity-100 focus-visible:opacity-100",
                        )}
                      >
                        <Pin aria-hidden className="size-3.5" />
                      </button>
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            )}
            {groups.map(([heading, rows]) => (
              <CommandGroup key={heading} heading={heading} className={HEADING}>
                {rows.map((row) => (
                  <CommandItem
                    key={row.key}
                    value={row.key}
                    onSelect={() => pickValue(row.picked)}
                    className={cn(ITEM, "pr-2")}
                  >
                    {row.icon}
                    <span className="min-w-0 flex-1 truncate">{row.name}</span>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {number.format(row.hits)}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
            {typed === "" && (showMyIp || showMuted) && (
              <>
                <CommandSeparator className="mx-0" />
                <CommandGroup className="p-1">
                  {showMyIp && <MyIpRow exclusion={myIp} />}
                  {showMuted && <MutedRow scope={muted} onToggle={onToggleMuted} />}
                </CommandGroup>
              </>
            )}
          </CommandList>
          {typed === "" && (
            <p className="flex items-center gap-1.5 border-t px-2.5 py-2 text-xs text-muted-foreground">
              <Pin aria-hidden className="size-3" />A pinned field stays in the bar.
            </p>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** A switch row. The option carries its state, since a control nested in an option goes unread. */
function SwitchRow({
  value,
  icon: Icon,
  label,
  detail,
  hint,
  checked,
  disabled = false,
  onSelect,
}: {
  value: string
  icon: typeof UserX
  label: string
  detail?: React.ReactNode
  /** Why the row is off, on a line of its own. */
  hint?: string
  checked: boolean
  disabled?: boolean
  onSelect?: () => void
}) {
  return (
    <CommandItem
      value={value}
      disabled={disabled}
      onSelect={onSelect}
      aria-checked={checked}
      className={cn(ITEM, hint && "h-auto items-start py-1.5")}
    >
      <Icon aria-hidden className={cn("size-[15px] text-muted-foreground", hint && "mt-0.5")} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0">{label}</span>
          {detail && <span className="min-w-0 truncate text-muted-foreground">{detail}</span>}
        </span>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </span>
      <Switch aria-hidden checked={checked} tabIndex={-1} className="pointer-events-none" />
    </CommandItem>
  )
}

function MyIpRow({ exclusion }: { exclusion: MyIpExclusion }) {
  if (exclusion.behindUntrustedProxy) {
    return (
      <SwitchRow
        value="hide-my-ip"
        icon={UserX}
        label="Hide my IP"
        hint={UNTRUSTED_PROXY_HINT}
        checked={false}
        disabled
      />
    )
  }
  if (exclusion.ip === null) return null
  return (
    <SwitchRow
      value="hide-my-ip"
      icon={UserX}
      label="Hide my IP"
      detail={<span className="font-mono text-xs">{exclusion.ip}</span>}
      checked={exclusion.excluded}
      onSelect={exclusion.toggle}
    />
  )
}

function MutedRow({ scope, onToggle }: { scope: MutedScope; onToggle: () => void }) {
  if (scope.chip === "none") return null
  const greyed = scope.chip === "greyed"
  return (
    <SwitchRow
      value="hide-muted-ips"
      icon={EyeOff}
      label="Hide muted IPs"
      detail={scope.count}
      hint={greyed ? "Off while filtering by IP" : undefined}
      checked={scope.chip === "hiding"}
      disabled={greyed}
      onSelect={onToggle}
    />
  )
}

type ValueRow = {
  key: string
  picked: PickedValue
  icon: React.ReactNode
  name: React.ReactNode
  hits: number
}

type Matches = NonNullable<ReturnType<typeof useFilterValueSearch>["data"]>

function valueGroups(data: Matches): [string, ValueRow[]][] {
  const groups: [string, ValueRow[]][] = [
    [
      "Country",
      data.countries.map((country) => ({
        key: `country:${country.code}`,
        picked: { kind: "country", code: country.code, name: country.name },
        icon: <CountryFlag code={country.code} className="h-3 w-[18px]" />,
        name: country.name,
        hits: country.hits,
      })),
    ],
    [
      "City",
      data.cities.map((city) => ({
        key: `city:${city.countryCode ?? ""}:${city.city}`,
        picked: {
          kind: "city",
          city: city.city,
          countryCode: city.countryCode,
          countryName: city.countryName,
        },
        icon: <CountryFlag code={city.countryCode} className="h-3 w-[18px]" />,
        name: city.city,
        hits: city.hits,
      })),
    ],
    [
      "Host",
      data.hosts.map((host) => ({
        key: `host:${host.host}`,
        picked: { kind: "host", host: host.host },
        icon: null,
        name: <span className="font-mono text-[13px]">{host.host}</span>,
        hits: host.hits,
      })),
    ],
    [
      "Server",
      data.servers.map((server) => ({
        key: `server:${server.server}`,
        picked: { kind: "server", server: server.server },
        icon: null,
        name: server.server,
        hits: server.hits,
      })),
    ],
    [
      "ASN",
      data.asns.map((asn) => ({
        key: `asn:${asn.asn}`,
        picked: { kind: "asn", asn: asn.asn, organization: asn.organization },
        icon: null,
        name: (
          <>
            AS{asn.asn} <span className="text-muted-foreground">{asn.organization}</span>
          </>
        ),
        hits: asn.hits,
      })),
    ],
  ]
  return groups.filter(([, rows]) => rows.length > 0)
}
