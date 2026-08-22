/**
 * Column metadata for the grouped geo-events table. Static on purpose:
 * labels, defaults, sort fields and mobile hiding live here so visibility
 * persistence and the contract test can read them without rendering. Cell
 * rendering is an exhaustive switch in geo-logs-table.tsx.
 */
import type { GeoLogSortField } from "@/lib/api"
import type { VisibilityColumn } from "@/lib/column-visibility"

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
  | "hostnames"

export interface GeoLogColumn extends VisibilityColumn {
  key: GeoLogColumnKey
  label: string
  /** Present when the column is server-sortable; absent for hostnames. */
  sortField?: GeoLogSortField
  align?: "right"
}

export const GEO_LOG_COLUMNS = [
  { key: "city", label: "City", sortField: "city", defaultVisible: true },
  { key: "postalCode", label: "Postal Code", sortField: "postalCode", defaultVisible: true, mobileHidden: true },
  { key: "state", label: "State", sortField: "state", defaultVisible: true, mobileHidden: true },
  { key: "countryCode", label: "Country Code", sortField: "countryCode", defaultVisible: true, mobileHidden: true },
  { key: "countryName", label: "Country", sortField: "countryName", defaultVisible: true },
  { key: "ipAddress", label: "IP", sortField: "ipAddress", defaultVisible: true },
  { key: "latitude", label: "Lat", sortField: "latitude", defaultVisible: true, align: "right", mobileHidden: true },
  { key: "longitude", label: "Long", sortField: "longitude", defaultVisible: true, align: "right", mobileHidden: true },
  { key: "eventCount", label: "Count", sortField: "eventCount", defaultVisible: true, align: "right" },
  { key: "lastSeen", label: "Last seen", sortField: "lastSeen", defaultVisible: true, mobileHidden: true },
  { key: "hostnames", label: "Hostnames", defaultVisible: false },
] satisfies readonly GeoLogColumn[] as readonly GeoLogColumn[]
