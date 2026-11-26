/**
 * The palette's name search: countries, cities, hosts, servers and networks
 * whose name holds what was typed, busiest first. Picking one turns it into a
 * chip in the field, and the list then offers the pages that take it as a
 * filter.
 */
import { useEffect, type ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import {
  Building2,
  ChartColumn,
  ChevronRight,
  FileText,
  Globe,
  MapPin,
  Network,
  Server,
  X,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

import { CommandGroup, CommandItem, CommandShortcut } from "@/components/ui/command"
import {
  GROUP,
  ITEM,
  ItemIcon,
  PhoneChevron,
  RowText,
} from "@/components/command-palette/ip-results"
import { fetchFilterValueMatches, type FilterValueMatches } from "@/lib/api"
import { flagUrl } from "@/lib/country-flags"
import { requestAccessLogsTab } from "@/lib/live-tail-request"
import { usePhoneLayout } from "@/hooks/use-phone-map"

/** The chip's text. The search field points at it with aria-describedby. */
export const PICKED_LABEL_ID = "command-palette-picked"

/** Values of name rows start with this, so the palette's filter lets them through. */
export const NAME_ROW = "name:"
/** Shorter text matches too much to be worth a request. */
export const NAME_SEARCH_MIN = 2
/** The server turns longer text away. */
const NAME_SEARCH_MAX = 100
const SHOWN = 4

export type PickedValue =
  | { kind: "country"; code: string; name: string }
  | { kind: "city"; city: string; countryCode: string | null; countryName: string | null }
  | { kind: "host"; host: string }
  | { kind: "server"; server: string }
  | { kind: "asn"; asn: number; organization: string | null }

type Navigate = ReturnType<typeof useNavigate>

type Target = { page: string; icon: LucideIcon; go: (navigate: Navigate) => void }

// Letters that no decomposition breaks down, folded as the server folds them.
const PLAIN_LETTERS: Record<string, string> = {
  ß: "ss",
  ø: "o",
  æ: "ae",
  œ: "oe",
  ł: "l",
  đ: "d",
  ð: "d",
  þ: "th",
}

/** Lower case without accents, as the server matches. */
function fold(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[ßøæœłđðþ]/g, (letter) => PLAIN_LETTERS[letter])
}

const AS_NUMBER = /^(?:as)?(\d+)$/

export function pickedLabel(picked: PickedValue): string {
  switch (picked.kind) {
    case "country":
      return picked.name
    case "city":
      return picked.countryName ? `${picked.city}, ${picked.countryName}` : picked.city
    case "host":
      return picked.host
    case "server":
      return picked.server
    case "asn":
      return picked.organization ?? `AS${picked.asn}`
  }
}

const KIND_NAME: Record<PickedValue["kind"], string> = {
  country: "country",
  city: "city",
  host: "host",
  server: "server",
  asn: "network",
}

function accessLogs(search: Record<string, unknown>): Target {
  return {
    page: "Access Logs",
    icon: FileText,
    go: (navigate) => {
      // A filter means nothing to the Live tail, so the page opens on History.
      requestAccessLogsTab("history")
      void navigate({ to: "/access-logs", search })
    },
  }
}

function targets(picked: PickedValue): Target[] {
  const analytics = (search: Record<string, unknown>): Target => ({
    page: "Analytics",
    icon: ChartColumn,
    go: (navigate) => void navigate({ to: "/analytics", search }),
  })
  const geoLogs = (search: Record<string, unknown>): Target => ({
    page: "Geo Logs",
    icon: MapPin,
    go: (navigate) => void navigate({ to: "/geo-logs", search }),
  })
  const map = (search: Record<string, unknown>): Target => ({
    page: "Map",
    icon: Globe,
    go: (navigate) => void navigate({ to: "/map", search }),
  })
  switch (picked.kind) {
    case "country": {
      const search = { country: [picked.code] }
      return [
        analytics(search),
        accessLogs(search),
        geoLogs(search),
        map({ countries: [picked.code] }),
      ]
    }
    case "city": {
      // The country goes along, so Paris in France leaves out Paris in Texas.
      const country = picked.countryCode ? [picked.countryCode] : undefined
      const search = { city: [picked.city], country }
      return [
        analytics(search),
        accessLogs(search),
        geoLogs(search),
        map({ cities: [picked.city], countries: country }),
      ]
    }
    case "host": {
      const search = { host: [picked.host] }
      return [analytics(search), accessLogs(search)]
    }
    case "server": {
      const search = { server: [picked.server] }
      return [accessLogs(search), geoLogs(search), map(search)]
    }
    case "asn": {
      const search = { asn: [picked.asn] }
      return [analytics(search), accessLogs(search), geoLogs(search)]
    }
  }
}

const number = new Intl.NumberFormat()

function requests(hits: number): string {
  return `${number.format(hits)} ${hits === 1 ? "request" : "requests"}`
}

/** The typed text in bold color wherever the name holds it, accents or not. */
function Marked({ text, typed }: { text: string; typed: string }) {
  const at = fold(text).indexOf(fold(typed))
  // Folding can change the length of either text, and then the mark would land off target.
  if (at < 0 || fold(text).length !== text.length || fold(typed).length !== typed.length) {
    return <>{text}</>
  }
  return (
    <>
      {text.slice(0, at)}
      <span className="font-semibold text-primary">{text.slice(at, at + typed.length)}</span>
      {text.slice(at + typed.length)}
    </>
  )
}

function FlagIcon({ code }: { code: string }) {
  const src = flagUrl(code)
  if (!src) return <ItemIcon icon={Globe} />
  return (
    <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted/60 phone:size-9 phone:rounded-lg">
      <img
        src={src}
        alt=""
        className="h-3 w-[18px] rounded-[2px] object-cover phone:h-3.5 phone:w-5"
      />
    </span>
  )
}

/** Rows that lead to a second step end in a chevron, on every screen. */
function NextStep() {
  return (
    <CommandShortcut aria-hidden className="flex">
      <ChevronRight className="size-4" />
    </CommandShortcut>
  )
}

export function useFilterValueSearch(text: string, enabled: boolean) {
  const query = text.trim()
  return useQuery({
    queryKey: ["command-palette", "filter-values", query],
    queryFn: ({ signal }) => fetchFilterValueMatches(query, SHOWN, signal),
    enabled: enabled && query.length >= NAME_SEARCH_MIN && query.length <= NAME_SEARCH_MAX,
    // The server can answer from old totals while it reloads them, so a repeat search asks again.
    staleTime: 0,
    placeholderData: (previous) => previous,
  })
}

type Row = { key: string; picked: PickedValue; icon: ReactNode; name: ReactNode; detail: ReactNode }

/**
 * Builds the rows for `typed`. Results for other text stay up while the next
 * request runs, and `stale` then keeps only the rows that still hold the
 * typed text. A current answer shows as the server sent it.
 */
function rows(data: FilterValueMatches, typed: string, stale: boolean): [string, Row[]][] {
  const needle = fold(typed.trim())
  const digits = AS_NUMBER.exec(needle)?.[1]
  const numberHit = (asn: number) => digits !== undefined && String(asn).startsWith(digits)
  const holds = (name: string | null) => !stale || (name !== null && fold(name).includes(needle))
  const countries: Row[] = data.countries
    .filter((country) => holds(country.name) || fold(country.code) === needle)
    .map((country) => ({
      key: `country:${country.code}`,
      picked: { kind: "country", code: country.code, name: country.name },
      icon: <FlagIcon code={country.code} />,
      name: <Marked text={country.name} typed={typed.trim()} />,
      detail: `Country · ${country.code} · ${requests(country.hits)}`,
    }))
  const cities: Row[] = data.cities
    .filter((city) => holds(city.city))
    .map((city) => ({
      key: `city:${city.countryCode ?? ""}:${city.city}`,
      picked: {
        kind: "city",
        city: city.city,
        countryCode: city.countryCode,
        countryName: city.countryName,
      },
      icon: <ItemIcon icon={Building2} />,
      name: <Marked text={city.city} typed={typed.trim()} />,
      detail: ["City", city.countryName ?? city.countryCode, requests(city.hits)]
        .filter(Boolean)
        .join(" · "),
    }))
  const hosts: Row[] = data.hosts
    .filter((host) => holds(host.host))
    .map((host) => ({
      key: `host:${host.host}`,
      picked: { kind: "host", host: host.host },
      icon: <ItemIcon icon={Globe} />,
      name: (
        <span className="font-mono text-[13px] phone:text-[15px]">
          <Marked text={host.host} typed={typed.trim()} />
        </span>
      ),
      detail: `Host · ${requests(host.hits)}`,
    }))
  const servers: Row[] = data.servers
    .filter((server) => holds(server.server))
    .map((server) => ({
      key: `server:${server.server}`,
      picked: { kind: "server", server: server.server },
      icon: <ItemIcon icon={Server} />,
      name: <Marked text={server.server} typed={typed.trim()} />,
      detail: `Server · ${requests(server.hits)}`,
    }))
  const asns: Row[] = data.asns
    .filter((asn) => numberHit(asn.asn) || holds(asn.organization))
    .map((asn) => ({
      key: `asn:${asn.asn}`,
      picked: { kind: "asn", asn: asn.asn, organization: asn.organization },
      icon: <ItemIcon icon={Network} />,
      name: numberHit(asn.asn) ? (
        (asn.organization ?? `AS${asn.asn}`)
      ) : (
        <Marked text={asn.organization ?? `AS${asn.asn}`} typed={typed.trim()} />
      ),
      detail:
        digits !== undefined && numberHit(asn.asn) ? (
          <>
            Network ·{" "}
            <span className="font-mono">
              <span className="font-semibold text-primary">AS{digits}</span>
              {String(asn.asn).slice(digits.length)}
            </span>{" "}
            · {requests(asn.hits)}
          </>
        ) : (
          `Network · AS${asn.asn} · ${requests(asn.hits)}`
        ),
    }))
  return [
    ["Countries", countries],
    ["Cities", cities],
    ["Hosts", hosts],
    ["Servers", servers],
    ["Networks", asns],
  ]
}

/**
 * The request waits for `settled`, the text once typing pauses. The rows
 * follow `search`, the live text.
 */
export function FilterValueGroups({
  search,
  settled,
  enabled,
  onPick,
  onArrived,
  onPending,
}: {
  search: string
  settled: string
  enabled: boolean
  onPick: (picked: PickedValue) => void
  /** Runs once the answer for the text shows, so the palette can move its highlight to it. */
  onArrived: () => void
  /** Tells the palette whether the answer for the live text is still on its way. */
  onPending: (pending: boolean) => void
}) {
  // The field can still hold the last opening's text for the debounce after it was cleared.
  const asking = enabled && search.trim().length >= NAME_SEARCH_MIN
  const { data, dataUpdatedAt, isFetching, isPlaceholderData } = useFilterValueSearch(
    settled,
    asking,
  )
  const settledOnText = settled.trim() === search.trim()
  const current = data !== undefined && !isPlaceholderData && settledOnText
  // A failed request isn't pending, so the list stays as it is.
  const pending = asking && !current && (isFetching || !settledOnText)
  const groups =
    data && asking
      ? rows(data, search, !current).filter(([, groupRows]) => groupRows.length > 0)
      : []
  const arrived = current && groups.length > 0 ? `${settled.trim()}@${dataUpdatedAt}` : null
  useEffect(() => {
    if (arrived) onArrived()
    // Only a new answer moves the highlight. A new onArrived each render must not.
  }, [arrived])
  useEffect(() => onPending(pending), [pending])
  if (!asking) return null
  if (groups.length === 0) {
    // Without this row, "Nothing matches" would show and be read out before the answer comes.
    // The first search after a restart also waits here while the server adds up its totals.
    if (!pending) return null
    return (
      <CommandGroup className={GROUP}>
        <CommandItem disabled value={`${NAME_ROW}searching`} className={ITEM}>
          <ItemIcon icon={Globe} />
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            Searching countries, hosts and networks…
          </span>
        </CommandItem>
      </CommandGroup>
    )
  }
  return (
    <>
      {groups.map(([heading, groupRows]) => (
        <CommandGroup key={heading} heading={heading} className={GROUP}>
          {groupRows.map((row) => (
            <CommandItem
              key={row.key}
              value={`${NAME_ROW}${row.key}`}
              onSelect={() => onPick(row.picked)}
              className={ITEM}
            >
              {row.icon}
              <RowText
                // A narrow phone wraps a long country name and count instead of cutting them off.
                detail={<span className="phone:whitespace-normal">{row.detail}</span>}
              >
                {/* A phone wraps long names, whose ends often tell two rows apart. */}
                <span className="min-w-0 truncate phone:whitespace-normal phone:[overflow-wrap:anywhere]">
                  {row.name}
                </span>
              </RowText>
              <NextStep />
            </CommandItem>
          ))}
        </CommandGroup>
      ))}
    </>
  )
}

/** The second step: the pages that take the picked value as a filter. */
export function PickedTargets({
  picked,
  onGo,
}: {
  picked: PickedValue
  onGo: (go: (navigate: Navigate) => void) => void
}) {
  // A phone starts the second line with it, so it gets a capital there.
  const phone = usePhoneLayout()
  const kind = KIND_NAME[picked.kind]
  const lead = phone ? kind[0].toUpperCase() + kind.slice(1) : kind
  return (
    <CommandGroup heading={`Filter a page by ${kind}`} className={GROUP}>
      {targets(picked).map((target) => (
        <CommandItem
          key={target.page}
          value={target.page}
          onSelect={() => onGo(target.go)}
          className={ITEM}
        >
          <ItemIcon icon={target.icon} />
          <RowText
            detail={
              <span className="phone:whitespace-normal phone:[overflow-wrap:anywhere]">
                {lead} is {pickedLabel(picked)}
              </span>
            }
          >
            <span className="min-w-0 truncate">{target.page}</span>
          </RowText>
          <PhoneChevron />
        </CommandItem>
      ))}
    </CommandGroup>
  )
}

const CHIP_ICON: Record<Exclude<PickedValue["kind"], "country">, LucideIcon> = {
  city: Building2,
  host: Globe,
  server: Server,
  asn: Network,
}

/** The picked value in the search field. Its button takes Enter, which cmdk would give the highlighted row. */
export function PickedChip({
  picked,
  onRemove,
  onKeyDown,
}: {
  picked: PickedValue
  onRemove: () => void
  onKeyDown: (event: React.KeyboardEvent) => void
}) {
  const label = pickedLabel(picked)
  const Icon = picked.kind === "country" ? null : CHIP_ICON[picked.kind]
  const flag = picked.kind === "country" ? flagUrl(picked.code) : undefined
  return (
    <span className="flex max-w-[72%] min-w-0 shrink-0 items-center gap-1.5 rounded-md bg-primary/12 py-1 pr-1 pl-2 text-sm font-medium text-foreground ring-1 ring-primary/40">
      {flag ? (
        <img src={flag} alt="" className="h-3 w-[18px] shrink-0 rounded-[2px] object-cover" />
      ) : Icon ? (
        <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <Globe aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      <span id={PICKED_LABEL_ID} className="min-w-0 truncate">
        {label}
      </span>
      <button
        type="button"
        aria-label={`Remove ${label}`}
        onKeyDown={onKeyDown}
        onClick={onRemove}
        className="grid size-6 shrink-0 place-items-center rounded-sm text-muted-foreground pointer-coarse:size-8 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        <X aria-hidden className="size-3.5" />
      </button>
    </span>
  )
}
