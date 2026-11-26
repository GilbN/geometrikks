/**
 * The palette's IP rows: addresses seen that start with what was typed, the
 * pages to filter by it, and what to do about it. Searches cover everything
 * kept, not only the selected range, through the per-IP daily rollups.
 */
import { useEffect, type ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import { ChevronRight, FileText, Mail, ScanSearch, Shield, ShieldBan } from "lucide-react"
import type { LucideIcon } from "lucide-react"

import { CommandGroup, CommandItem, CommandShortcut } from "@/components/ui/command"
import { DecisionBadge } from "@/components/crowdsec/decision-badge"
import { DropBadge } from "@/components/drop/drop-badge"
import { fetchTopIpStats } from "@/lib/api"
import { countryDisplayName } from "@/lib/country-flags"
import { timeLeftText } from "@/lib/crowdsec-alerts"
import { decisionLabel, winningDecision } from "@/lib/crowdsec"
import { ipv4InCidr, type IpQuery } from "@/lib/ip-prefix"
import {
  useBannedIps,
  useBannedRanges,
  useDropAsns,
  useDropNetwork,
  useIpDecisions,
} from "@/lib/queries"
import { usePhoneLayout } from "@/hooks/use-phone-map"
import { cn } from "@/lib/utils"

/** Earlier than any install's data, so the daily rollups reach back to the first day kept. */
const EVERYTHING_KEPT = "2000-01-01T00:00:00Z"
/** The most rows the search asks for. The request count needs every match. */
const SEARCH_LIMIT = 100
const SHOWN = 8

export const GROUP =
  "**:[[cmdk-group-heading]]:text-[11px] **:[[cmdk-group-heading]]:font-semibold **:[[cmdk-group-heading]]:tracking-[0.08em] **:[[cmdk-group-heading]]:uppercase"
/** On a phone the rows are taller, for a thumb. */
export const ITEM =
  "min-h-10 gap-3 rounded-lg! px-2.5 text-sm ring-1 ring-transparent data-selected:bg-primary/12 data-selected:ring-primary/50 phone:min-h-14 phone:gap-3.5 phone:px-2 phone:text-[15px] phone:active:bg-muted/60 phone:[&>svg:last-child]:hidden"

export function ItemIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted/60 phone:size-9 phone:rounded-lg">
      <Icon className="size-4 text-muted-foreground phone:size-[18px]" />
    </span>
  )
}

/** A row's name with its detail beside it, or below it on a phone. */
export function RowText({ children, detail }: { children: ReactNode; detail?: ReactNode }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-3 phone:flex-col phone:items-start phone:gap-0.5 phone:*:max-w-full">
      {children}
      {detail ? (
        <span className="min-w-0 truncate text-muted-foreground phone:text-[13px]">{detail}</span>
      ) : null}
    </span>
  )
}

/** On a phone, rows that open a page or the inspector end in a chevron. */
export function PhoneChevron() {
  return (
    <CommandShortcut aria-hidden className="hidden phone:flex">
      <ChevronRight className="size-4" />
    </CommandShortcut>
  )
}

/** Values of IP rows start with this, so the palette's filter lets them through. */
export const IP_ROW = "ip:"
/** Values of rows for one address, which Ctrl+Enter opens in Access Logs. */
export const ADDRESS_ROW = `${IP_ROW}addr:`

const number = new Intl.NumberFormat()

function useIpStats(ips: string[] | null, enabled: boolean) {
  return useQuery({
    queryKey: ["command-palette", "ips", ips],
    // The signal drops a search the next keystroke replaced.
    queryFn: ({ signal }) =>
      fetchTopIpStats(
        {
          startDate: EVERYTHING_KEPT,
          endDate: new Date().toISOString(),
          ips: ips ?? [],
          limit: SEARCH_LIMIT,
        },
        signal,
      ),
    enabled: enabled && ips !== null && ips.length > 0,
    staleTime: 30_000,
    placeholderData: (previous) => previous,
  })
}

/** The typed text in bold color where an address starts with it. */
function Highlighted({ ip, typed }: { ip: string; typed: string }) {
  const matches = ip.toLowerCase().startsWith(typed.toLowerCase())
  return (
    <span className="min-w-0 font-mono text-[13px] [overflow-wrap:anywhere] phone:text-[15px]">
      {matches ? (
        <>
          <span className="font-semibold text-primary">{ip.slice(0, typed.length)}</span>
          {ip.slice(typed.length)}
        </>
      ) : (
        ip
      )}
    </span>
  )
}

/** Only rows the banned list names look up their decision, so a search costs no LAPI calls for the rest. */
function BanMark({ ip }: { ip: string }) {
  const { data: decisions } = useIpDecisions(ip)
  const decision = winningDecision(decisions)
  if (!decision) return null
  return (
    <DecisionBadge type={decision.type} insideButton className="shrink-0">
      {decisionLabel(decision.type)} · {timeLeftText(decision.duration)}
    </DecisionBadge>
  )
}

function DropMark({ ip, asn }: { ip: string; asn: number | null }) {
  const network = useDropNetwork(ip)
  const dropAsns = useDropAsns()
  if (network) return <DropBadge variant="short" sblId={network.sblId} insideButton />
  if (asn != null && dropAsns?.has(asn)) {
    return <DropBadge variant="short" list="asn-drop" showListName insideButton />
  }
  return null
}

export interface IpActions {
  inspect: (ip: string) => void
  openInAccessLogs: (ips: string[]) => void
  searchDecisions: (query: string) => void
  banRange: (target: string) => void
  report: (subject: { ip: string; asn: number | null; organization: string | null }) => void
}

export function IpSearchGroups({
  query,
  actions,
  crowdsecEnabled,
  canBan,
  enabled,
  current,
  onStatus,
}: {
  query: IpQuery
  actions: IpActions
  crowdsecEnabled: boolean
  canBan: boolean
  enabled: boolean
  /** False while the typed text is ahead of the query, so no row acts on an older search. */
  current: boolean
  /** The search's state in words, for a live region outside the listbox. */
  onStatus: (text: string) => void
}) {
  const { data, isError, isPlaceholderData } = useIpStats(query.ranges, enabled && current)
  // Rows for an older search stay hidden until this one answers, so Enter never opens the wrong address.
  const fresh = current && data !== undefined && !isPlaceholderData
  const { data: bannedIps } = useBannedIps()
  const { data: bannedRanges } = useBannedRanges()
  const coveredByBannedRange = (ip: string) =>
    [...(bannedRanges?.keys() ?? [])].some((cidr) => ipv4InCidr(ip, cidr))
  const rows = fresh ? data.items.slice(0, SHOWN) : []
  const requests =
    fresh && data.distinctIps <= SEARCH_LIMIT
      ? data.items.reduce((sum, item) => sum + item.hits, 0)
      : null
  const status = !current
    ? "Searching."
    : isError && !fresh
      ? "The search failed."
      : !fresh
        ? "Searching."
        : rows.length === 0
          ? `No address starting with ${query.typed}.`
          : `${rows.length} ${rows.length === 1 ? "address" : "addresses"} found.`
  useEffect(() => {
    onStatus(status)
    return () => onStatus("")
  }, [status, onStatus])
  // A failed search still leaves the typed text to filter by, ban or report.
  const usable = fresh || (current && isError)
  const top = rows[0]
  const reportIp = query.address ?? top?.ipAddress ?? null
  const reportRow = rows.find((row) => row.ipAddress === reportIp)
  const label = query.typed

  return (
    <>
      <CommandGroup heading="IP addresses seen" className={GROUP}>
        {rows.map((row) => (
          <CommandItem
            key={row.ipAddress}
            value={`${ADDRESS_ROW}${row.ipAddress}`}
            onSelect={() => actions.inspect(row.ipAddress)}
            className={ITEM}
          >
            <ItemIcon icon={ScanSearch} />
            <RowText
              detail={
                <>
                  {row.asn != null && (
                    <>
                      {/* A phone has room for the name only. */}
                      <span className="phone:hidden">
                        AS{row.asn}
                        {row.asOrganization ? " " : ""}
                      </span>
                      {row.asOrganization}
                      {row.asOrganization ? " · " : <span className="phone:hidden"> · </span>}
                    </>
                  )}
                  {number.format(row.hits)} {row.hits === 1 ? "request" : "requests"}
                </>
              }
            >
              <Highlighted ip={row.ipAddress} typed={query.typed} />
            </RowText>
            {/* As a shortcut slot it hides cmdk's check icon, which would take half the free space. */}
            <CommandShortcut className="flex shrink-0 items-center gap-1.5 tracking-normal">
              {(bannedIps?.has(row.ipAddress) || coveredByBannedRange(row.ipAddress)) && (
                <BanMark ip={row.ipAddress} />
              )}
              <DropMark ip={row.ipAddress} asn={row.asn} />
              {/* Badges take the chevron's place on a phone. */}
              <ChevronRight aria-hidden className="hidden size-4 phone:only:block" />
            </CommandShortcut>
          </CommandItem>
        ))}
        {rows.length === 0 && (
          <CommandItem
            value={`${IP_ROW}status`}
            disabled
            className={cn(ITEM, "text-muted-foreground")}
          >
            <ItemIcon icon={ScanSearch} />
            {isError && current && !fresh
              ? "The search failed. Try again in a moment."
              : !fresh
                ? "Searching…"
                : `No address starting with ${label} in the data kept.`}
          </CommandItem>
        )}
      </CommandGroup>
      {usable && (
        <CommandGroup heading="Filter a page" className={GROUP}>
          <CommandItem
            value={`${IP_ROW}filter:access-logs`}
            onSelect={() => actions.openInAccessLogs(query.ranges)}
            className={ITEM}
          >
            <ItemIcon icon={FileText} />
            <RowText
              detail={
                requests !== null &&
                `${number.format(requests)} ${requests === 1 ? "request" : "requests"}`
              }
            >
              <span className="min-w-0 truncate phone:whitespace-normal">
                Access Logs<span className="phone:hidden"> where</span>
                <span className="hidden phone:inline">,</span> IP starts with{" "}
                <span className="font-mono font-semibold text-primary">{label}</span>
              </span>
            </RowText>
            <PhoneChevron />
          </CommandItem>
          {crowdsecEnabled && (query.cidr || query.address) && (
            <CommandItem
              value={`${IP_ROW}filter:security`}
              onSelect={() => actions.searchDecisions(query.address ?? query.cidr ?? label)}
              className={ITEM}
            >
              <ItemIcon icon={Shield} />
              <span className="min-w-0 flex-1 truncate phone:whitespace-normal">
                Security decisions matching{" "}
                <span className="font-mono font-semibold text-primary">{label}</span>
              </span>
              <PhoneChevron />
            </CommandItem>
          )}
        </CommandGroup>
      )}
      {usable && ((canBan && (query.cidr || query.address)) || reportIp) && (
        <CommandGroup heading="Actions" className={GROUP}>
          {canBan && (query.cidr || query.address) && (
            <CommandItem
              value={`${IP_ROW}ban`}
              onSelect={() => actions.banRange((query.address ?? query.cidr)!)}
              className={ITEM}
            >
              <ItemIcon icon={ShieldBan} />
              <span className="min-w-0 truncate phone:whitespace-normal phone:[overflow-wrap:anywhere]">
                Ban <span className="font-mono">{query.address ?? query.cidr}</span>
                {query.address ? "…" : " as a range…"}
              </span>
            </CommandItem>
          )}
          {reportIp && (
            <CommandItem
              value={`${IP_ROW}report`}
              onSelect={() =>
                actions.report({
                  ip: reportIp,
                  asn: reportRow?.asn ?? null,
                  organization: reportRow?.asOrganization ?? null,
                })
              }
              className={ITEM}
            >
              <ItemIcon icon={Mail} />
              <span className="min-w-0 truncate phone:whitespace-normal phone:[overflow-wrap:anywhere]">
                Write an abuse report for <span className="font-mono">{reportIp}</span>
              </span>
            </CommandItem>
          )}
        </CommandGroup>
      )}
    </>
  )
}

/** The last addresses opened in the inspector, with what is known about them. */
export function RecentIpsGroup({
  ips,
  actions,
  enabled,
}: {
  ips: string[]
  actions: IpActions
  enabled: boolean
}) {
  const { data } = useIpStats(ips.length ? ips : null, enabled)
  const { data: bannedIps } = useBannedIps()
  // A phone starts the second line with it, so it keeps its capital.
  const phone = usePhoneLayout()
  if (ips.length === 0) return null
  const stats = new Map(data?.items.map((item) => [item.ipAddress, item]))
  return (
    <CommandGroup heading="Recently inspected" className={GROUP}>
      {ips.map((ip) => {
        const row = stats.get(ip)
        const detail = [
          bannedIps?.has(ip)
            ? phone
              ? decisionLabel(bannedIps.get(ip) ?? "ban")
              : decisionLabel(bannedIps.get(ip) ?? "ban").toLowerCase()
            : row?.countryCode
              ? countryDisplayName(row.countryCode)
              : null,
          row ? `${number.format(row.hits)} ${row.hits === 1 ? "request" : "requests"}` : null,
        ]
          .filter(Boolean)
          .join(" · ")
        return (
          <CommandItem
            key={ip}
            value={`${ADDRESS_ROW}${ip}`}
            onSelect={() => actions.inspect(ip)}
            className={ITEM}
          >
            <ItemIcon icon={ScanSearch} />
            <RowText detail={detail}>
              <span className="min-w-0 font-mono text-[13px] [overflow-wrap:anywhere] phone:text-[15px]">
                {ip}
              </span>
            </RowText>
            <PhoneChevron />
          </CommandItem>
        )
      })}
    </CommandGroup>
  )
}
