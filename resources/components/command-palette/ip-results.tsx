/**
 * The palette's IP rows: addresses seen that start with what was typed, the
 * pages to filter by it, and what to do about it. Searches cover everything
 * kept, not only the selected range, through the per-IP daily rollups.
 */
import { useEffect, useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { FileText, Mail, ScanSearch, Shield, ShieldBan } from "lucide-react"
import type { LucideIcon } from "lucide-react"

import { CommandGroup, CommandItem } from "@/components/ui/command"
import { DecisionBadge } from "@/components/crowdsec/decision-badge"
import { DropBadge } from "@/components/drop/drop-badge"
import { fetchTopIpStats } from "@/lib/api"
import { countryDisplayName } from "@/lib/country-flags"
import { timeLeftText } from "@/lib/crowdsec-alerts"
import type { IpQuery } from "@/lib/ip-prefix"
import { useBannedIps, useDropAsns, useDropNetwork, useIpDecisions } from "@/lib/queries"
import { cn } from "@/lib/utils"

/** Earlier than any install's data, so the daily rollups reach back to the first day kept. */
const EVERYTHING_KEPT = "2000-01-01T00:00:00Z"
/** The most rows the search asks for. The request count needs every match. */
const SEARCH_LIMIT = 100
const SHOWN = 8

export const GROUP =
  "**:[[cmdk-group-heading]]:text-[11px] **:[[cmdk-group-heading]]:font-semibold **:[[cmdk-group-heading]]:tracking-[0.08em] **:[[cmdk-group-heading]]:uppercase"
export const ITEM =
  "min-h-10 gap-3 rounded-lg! px-2.5 text-sm ring-1 ring-transparent data-selected:bg-primary/12 data-selected:ring-primary/50"

export function ItemIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted/60">
      <Icon className="size-4 text-muted-foreground" />
    </span>
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
    queryFn: () =>
      fetchTopIpStats({
        startDate: EVERYTHING_KEPT,
        endDate: new Date().toISOString(),
        ips: ips ?? [],
        limit: SEARCH_LIMIT,
      }),
    enabled: enabled && ips !== null && ips.length > 0,
    staleTime: 30_000,
    placeholderData: (previous) => previous,
  })
}

/** The typed text in bold color where an address starts with it. */
function Highlighted({ ip, typed }: { ip: string; typed: string }) {
  const matches = ip.toLowerCase().startsWith(typed.toLowerCase())
  return (
    <span className="font-mono text-[13px]">
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

function BanMark({ ip }: { ip: string }) {
  const { data: decisions } = useIpDecisions(ip)
  const ban = decisions?.find((decision) => decision.type === "ban") ?? decisions?.[0]
  if (!ban) return null
  return (
    <DecisionBadge type={ban.type} insideButton className="shrink-0">
      {ban.type === "ban" ? "Banned" : ban.type} · {timeLeftText(ban.duration)}
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
  onTopAddress,
}: {
  query: IpQuery
  actions: IpActions
  crowdsecEnabled: boolean
  canBan: boolean
  enabled: boolean
  /** The rows arrive after the palette has picked a row. This moves the pick to the first address. */
  onTopAddress: (value: string) => void
}) {
  const { data, isFetching, isError } = useIpStats(query.ranges, enabled)
  const { data: bannedIps } = useBannedIps()
  const rows = data?.items.slice(0, SHOWN) ?? []
  const requests =
    data && data.distinctIps <= SEARCH_LIMIT
      ? data.items.reduce((sum, item) => sum + item.hits, 0)
      : null
  const activeBans = useMemo(() => {
    if (!bannedIps) return 0
    const typed = query.typed.toLowerCase()
    let count = 0
    for (const ip of bannedIps.keys()) if (ip.toLowerCase().startsWith(typed)) count++
    return count
  }, [bannedIps, query.typed])
  const top = rows[0]
  const topValue = top ? `${ADDRESS_ROW}${top.ipAddress}` : null
  useEffect(() => {
    if (topValue) onTopAddress(topValue)
  }, [topValue, onTopAddress])
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
            <Highlighted ip={row.ipAddress} typed={query.typed} />
            <span className="min-w-0 truncate text-muted-foreground">
              {[
                row.asn != null ? `AS${row.asn} ${row.asOrganization ?? ""}`.trim() : null,
                `${number.format(row.hits)} ${row.hits === 1 ? "request" : "requests"}`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              <BanMark ip={row.ipAddress} />
              <DropMark ip={row.ipAddress} asn={row.asn} />
            </span>
          </CommandItem>
        ))}
        {rows.length === 0 && (
          <CommandItem
            value={`${IP_ROW}status`}
            disabled
            className={cn(ITEM, "text-muted-foreground")}
          >
            <ItemIcon icon={ScanSearch} />
            {isError
              ? "The search failed. Try again in a moment."
              : isFetching || !data
                ? "Searching…"
                : `No address starting with ${label} in the data kept.`}
          </CommandItem>
        )}
      </CommandGroup>
      <CommandGroup heading="Filter a page" className={GROUP}>
        <CommandItem
          value={`${IP_ROW}filter:access-logs`}
          onSelect={() => actions.openInAccessLogs(query.ranges)}
          className={ITEM}
        >
          <ItemIcon icon={FileText} />
          <span className="min-w-0 truncate">
            Access Logs where IP starts with{" "}
            <span className="font-mono font-semibold text-primary">{label}</span>
          </span>
          {requests !== null && (
            <span className="shrink-0 text-muted-foreground">
              {number.format(requests)} {requests === 1 ? "request" : "requests"}
            </span>
          )}
        </CommandItem>
        {crowdsecEnabled && (query.cidr || query.address) && (
          <CommandItem
            value={`${IP_ROW}filter:security`}
            onSelect={() => actions.searchDecisions(query.address ?? query.cidr ?? label)}
            className={ITEM}
          >
            <ItemIcon icon={Shield} />
            <span className="min-w-0 truncate">
              Security decisions matching{" "}
              <span className="font-mono font-semibold text-primary">{label}</span>
            </span>
            {activeBans > 0 && (
              <span className="shrink-0 text-muted-foreground">
                {activeBans} active {activeBans === 1 ? "ban" : "bans"}
              </span>
            )}
          </CommandItem>
        )}
      </CommandGroup>
      {((canBan && (query.cidr || query.address)) || reportIp) && (
        <CommandGroup heading="Actions" className={GROUP}>
          {canBan && (query.cidr || query.address) && (
            <CommandItem
              value={`${IP_ROW}ban`}
              onSelect={() => actions.banRange((query.address ?? query.cidr)!)}
              className={ITEM}
            >
              <ItemIcon icon={ShieldBan} />
              <span className="min-w-0 truncate">
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
              <span className="min-w-0 truncate">
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
  if (ips.length === 0) return null
  const stats = new Map(data?.items.map((item) => [item.ipAddress, item]))
  return (
    <CommandGroup heading="Recently inspected" className={GROUP}>
      {ips.map((ip) => {
        const row = stats.get(ip)
        const detail = [
          bannedIps?.has(ip)
            ? "banned"
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
            <span className="font-mono text-[13px]">{ip}</span>
            {detail && <span className="min-w-0 truncate text-muted-foreground">{detail}</span>}
          </CommandItem>
        )
      })}
    </CommandGroup>
  )
}
