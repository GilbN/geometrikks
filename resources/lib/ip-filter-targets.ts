/**
 * The filter actions an IP actions menu offers for one table row. Each page
 * turns a row's values (IP, host, server, country, ASN) into targets for the
 * filters it has, so the menu can include, exclude or remove a value without
 * knowing the page's filter state.
 */
import type { AccessLogFilterState } from "@/lib/access-log-filters-context"
import type { AnalyticsFilterState } from "@/lib/analytics-filters-context"
import { countryDisplayName } from "@/lib/country-flags"
import type { GeoLogFilterState } from "@/lib/geo-log-filters-context"

export interface FilterTarget {
  /** What the value is, as the menu names it: "IP", "host", "country". */
  noun: string
  /** The value as the menu shows it: an IP, a host, "AS13335". */
  value: string
  /** Whether the value already sits in the include or exclude list. */
  state: "include" | "exclude" | null
  /** Absent when the page has no include filter for this value. */
  include?: () => void
  /** Absent when the page has no exclude filter for this value. */
  exclude?: () => void
  remove: () => void
}

/** What a row hands the menu. The header shows the location and network;
 *  each page picks the values it can filter on. */
export interface IpRowValues {
  ip: string
  host?: string | null
  server?: string | null
  countryCode?: string | null
  countryName?: string | null
  city?: string | null
  asn?: number | null
  asOrganization?: string | null
}

type ListKey<F, V> = { [K in keyof F]: F[K] extends V[] ? K : never }[keyof F]

function listOf<F, V>(filters: F, key: ListKey<F, V> | null): V[] {
  return key === null ? [] : (filters[key] as unknown as V[])
}

function withList<F, V>(filters: F, key: ListKey<F, V> | null, values: V[]): F {
  return key === null ? filters : { ...filters, [key]: values }
}

/**
 * A target backed by a page's include and exclude lists. Adding a value to
 * one list takes it out of the other, so a value is never in both.
 */
export function listFilterTarget<F, V extends string | number = string>({
  noun,
  value,
  label = String(value),
  filters,
  setFilters,
  includeKey,
  excludeKey,
}: {
  noun: string
  value: V
  /** How the menu shows the value; defaults to the value itself. */
  label?: string
  filters: F
  setFilters: (updater: (prev: F) => F) => void
  includeKey: ListKey<F, V> | null
  excludeKey: ListKey<F, V> | null
}): FilterTarget {
  const without = (list: V[]) => list.filter((entry) => entry !== value)
  const update = (include: (list: V[]) => V[], exclude: (list: V[]) => V[]) =>
    setFilters((prev) =>
      withList(
        withList(prev, includeKey, include(listOf(prev, includeKey))),
        excludeKey,
        exclude(listOf(prev, excludeKey)),
      ),
    )
  const state = listOf(filters, includeKey).includes(value)
    ? "include"
    : listOf(filters, excludeKey).includes(value)
      ? "exclude"
      : null
  return {
    noun,
    value: label,
    state,
    include: includeKey === null ? undefined : () => update((list) => [...without(list), value], without),
    exclude: excludeKey === null ? undefined : () => update(without, (list) => [...without(list), value]),
    remove: () => update(without, without),
  }
}

/** A target backed by a single-value include filter, like Debug Logs' IP box. */
export function singleFilterTarget({
  noun,
  value,
  current,
  setValue,
}: {
  noun: string
  value: string
  current: string | undefined
  setValue: (next: string | undefined) => void
}): FilterTarget {
  return {
    noun,
    value,
    state: current === value ? "include" : null,
    include: () => setValue(value),
    remove: () => setValue(undefined),
  }
}

type SetFilters<F> = (updater: (prev: F) => F) => void

/** "Belgium" for a row with BE; the code itself when the name is unknown. */
export function countryLabel(code: string, name?: string | null): string {
  return name ?? countryDisplayName(code) ?? code
}

function countryTarget<F>(
  { countryCode, countryName }: IpRowValues,
  filters: F,
  setFilters: SetFilters<F>,
  includeKey: ListKey<F, string>,
): FilterTarget[] {
  if (!countryCode) return []
  return [
    listFilterTarget<F>({
      noun: "country",
      value: countryCode,
      label: countryLabel(countryCode, countryName),
      filters,
      setFilters,
      includeKey,
      excludeKey: null,
    }),
  ]
}

export function accessLogFilterTargets(filters: AccessLogFilterState, setFilters: SetFilters<AccessLogFilterState>) {
  return (row: IpRowValues): FilterTarget[] => {
    const target = (
      noun: string,
      value: string,
      includeKey: "ips" | "hosts" | "servers",
      excludeKey: "ipsExclude" | "hostsExclude" | "serversExclude",
    ) => listFilterTarget({ noun, value, filters, setFilters, includeKey, excludeKey })
    return [
      target("IP", row.ip, "ips", "ipsExclude"),
      ...(row.host ? [target("host", row.host, "hosts", "hostsExclude")] : []),
      ...(row.server ? [target("server", row.server, "servers", "serversExclude")] : []),
      ...countryTarget(row, filters, setFilters, "countryCodes"),
    ]
  }
}

export function geoLogFilterTargets(filters: GeoLogFilterState, setFilters: SetFilters<GeoLogFilterState>) {
  return (row: IpRowValues): FilterTarget[] => [
    listFilterTarget({ noun: "IP", value: row.ip, filters, setFilters, includeKey: "ips", excludeKey: "ipsExclude" }),
    ...countryTarget(row, filters, setFilters, "countryCodes"),
    ...(row.asn != null
      ? [
          listFilterTarget({
            noun: "ASN",
            value: row.asn,
            label: `AS${row.asn}`,
            filters,
            setFilters,
            includeKey: "asns",
            excludeKey: "asnsExclude",
          }),
        ]
      : []),
  ]
}

export function analyticsFilterTargets(filters: AnalyticsFilterState, setFilters: SetFilters<AnalyticsFilterState>) {
  return (row: IpRowValues): FilterTarget[] => [
    listFilterTarget({ noun: "IP", value: row.ip, filters, setFilters, includeKey: "ips", excludeKey: "ipsExclude" }),
    ...countryTarget(row, filters, setFilters, "countryCodes"),
  ]
}
