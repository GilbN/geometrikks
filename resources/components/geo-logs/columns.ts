/**
 * Column metadata for the grouped geo-events table. Static on purpose:
 * labels, defaults, sort fields and mobile hiding live here so visibility
 * persistence and the contract test can read them without rendering. Cell
 * rendering is an exhaustive switch in geo-logs-table.tsx.
 */
import type { GeoLogSortField } from "@/lib/api"
import type { SortKind } from "@/components/data/sort-options"
import type { RenamedColumnKeys, VisibilityColumn } from "@/lib/column-visibility"

export type GeoLogColumnKey =
  | "city"
  | "postalCode"
  | "state"
  | "countryCode"
  | "countryName"
  | "ipAddress"
  | "latitude"
  | "longitude"
  | "eventCount"
  | "lastSeen"
  | "servers"
  | "asn"
  | "asOrganization"

export interface GeoLogColumn extends VisibilityColumn {
  key: GeoLogColumnKey
  label: string
  grow?: boolean
  /** Present when the backend can sort by the column; absent for servers. */
  sortField?: GeoLogSortField
  sortKind?: SortKind
  align?: "right"
}

export const GEO_LOG_COLUMNS = [
  { key: "city", grow: true, label: "City", sortField: "city", defaultVisible: true },
  {
    key: "postalCode",
    label: "Postal Code",
    sortField: "postalCode",
    defaultVisible: true,
    mobileHidden: true,
  },
  {
    key: "state",
    grow: true,
    label: "State",
    sortField: "state",
    defaultVisible: true,
    mobileHidden: true,
  },
  {
    key: "countryCode",
    label: "Country Code",
    sortField: "countryCode",
    defaultVisible: true,
    mobileHidden: true,
  },
  {
    key: "countryName",
    grow: true,
    label: "Country",
    sortField: "countryName",
    defaultVisible: true,
  },
  { key: "ipAddress", label: "IP", sortField: "ipAddress", defaultVisible: true },
  {
    key: "latitude",
    label: "Lat",
    sortField: "latitude",
    sortKind: "number",
    defaultVisible: true,
    align: "right",
    mobileHidden: true,
  },
  {
    key: "longitude",
    label: "Long",
    sortField: "longitude",
    sortKind: "number",
    defaultVisible: true,
    align: "right",
    mobileHidden: true,
  },
  {
    key: "eventCount",
    label: "Count",
    sortField: "eventCount",
    sortKind: "number",
    defaultVisible: true,
    align: "right",
  },
  {
    key: "lastSeen",
    label: "Last seen",
    sortField: "lastSeen",
    sortKind: "time",
    defaultVisible: true,
    mobileHidden: true,
  },
  { key: "servers", grow: true, label: "Servers", defaultVisible: false },
  {
    key: "asn",
    label: "ASN",
    sortField: "asn",
    sortKind: "number",
    defaultVisible: false,
    mobileHidden: true,
  },
  { key: "asOrganization", label: "Organization", defaultVisible: false, mobileHidden: true },
] satisfies readonly GeoLogColumn[] as readonly GeoLogColumn[]

/** Saved layouts from before the server rename. */
export const GEO_LOG_RENAMED_COLUMN_KEYS: RenamedColumnKeys = { hostnames: "servers" }

/** A column of the combined layout: one field, or several sharing a cell. */
export interface GeoLogCombinedColumn {
  key: GeoLogColumnKey | "location" | "client" | "coordinates"
  label: string
  /** The visible fields this column holds, in sort-menu order. */
  fields: GeoLogColumn[]
  grow?: boolean
  /** Keeps the column this wide when the table is short of room, so narrower columns give way first. */
  minWidth?: string
  align?: "right"
}

const COMBINED_GROUPS: readonly {
  key: "location" | "client" | "coordinates"
  label: string
  fields: readonly GeoLogColumnKey[]
  grow?: boolean
  minWidth?: string
}[] = [
  {
    key: "location",
    label: "Location",
    fields: ["city", "state", "postalCode", "countryName", "countryCode"],
    grow: true,
    minWidth: "15rem",
  },
  { key: "client", label: "Client", fields: ["ipAddress"] },
  { key: "coordinates", label: "Coordinates", fields: ["latitude", "longitude"] },
]

/** Where each group sits, and the fields that move up beside them. */
const COMBINED_ORDER: readonly (GeoLogColumnKey | "location" | "client" | "coordinates")[] = [
  "location",
  "client",
  "coordinates",
  "eventCount",
  "lastSeen",
]

/**
 * The combined layout of the visible fields: flag, city, state, country and
 * postal code share Location, the IP takes Client, and lat/long share
 * Coordinates. A group shows while any of its fields is visible, so the saved
 * field choices mean the same in both layouts. The other fields keep their own
 * columns, in the same order as the separate layout.
 */
export function combinedGeoLogColumns(
  shownColumns: readonly GeoLogColumn[],
): GeoLogCombinedColumn[] {
  const shown = new Map(shownColumns.map((column) => [column.key, column]))
  const grouped = new Set<GeoLogColumnKey>(COMBINED_GROUPS.flatMap((group) => group.fields))
  const byKey = new Map<string, GeoLogCombinedColumn>()
  for (const group of COMBINED_GROUPS) {
    const fields = group.fields.flatMap((key) => shown.get(key) ?? [])
    if (fields.length) byKey.set(group.key, { ...group, fields })
  }
  for (const column of shownColumns) {
    if (grouped.has(column.key)) continue
    byKey.set(column.key, {
      key: column.key,
      label: column.label,
      fields: [column],
      grow: column.grow,
      align: column.align,
    })
  }
  const first = COMBINED_ORDER.flatMap((key) => byKey.get(key) ?? [])
  const rest = [...byKey.values()].filter((column) => !COMBINED_ORDER.includes(column.key))
  return [...first, ...rest]
}
