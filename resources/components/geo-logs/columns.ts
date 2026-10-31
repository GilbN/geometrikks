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
  { key: "postalCode", label: "Postal Code", sortField: "postalCode", defaultVisible: true, mobileHidden: true },
  { key: "state", grow: true, label: "State", sortField: "state", defaultVisible: true, mobileHidden: true },
  { key: "countryCode", label: "Country Code", sortField: "countryCode", defaultVisible: true, mobileHidden: true },
  { key: "countryName", grow: true, label: "Country", sortField: "countryName", defaultVisible: true },
  { key: "ipAddress", label: "IP", sortField: "ipAddress", defaultVisible: true },
  { key: "latitude", label: "Lat", sortField: "latitude", sortKind: "number", defaultVisible: true, align: "right", mobileHidden: true },
  { key: "longitude", label: "Long", sortField: "longitude", sortKind: "number", defaultVisible: true, align: "right", mobileHidden: true },
  { key: "eventCount", label: "Count", sortField: "eventCount", sortKind: "number", defaultVisible: true, align: "right" },
  { key: "lastSeen", label: "Last seen", sortField: "lastSeen", sortKind: "time", defaultVisible: true, mobileHidden: true },
  { key: "servers", grow: true, label: "Servers", defaultVisible: false },
  { key: "asn", label: "ASN", sortField: "asn", sortKind: "number", defaultVisible: false, mobileHidden: true },
  { key: "asOrganization", label: "Organization", defaultVisible: false, mobileHidden: true },
] satisfies readonly GeoLogColumn[] as readonly GeoLogColumn[]

/** Saved layouts from before the server rename. */
export const GEO_LOG_RENAMED_COLUMN_KEYS: RenamedColumnKeys = { hostnames: "servers" }
