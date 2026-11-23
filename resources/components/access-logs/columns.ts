/**
 * Column metadata for the access-logs history table. Static on purpose:
 * labels, defaults, sort fields and mobile hiding live here so visibility
 * persistence and the contract test can read them without rendering. Cell
 * rendering is an exhaustive switch in access-logs-table.tsx.
 */
import type { AccessLogSortField } from "@/lib/api"
import type { SortKind } from "@/components/data/sort-options"
import type { RenamedColumnKeys, VisibilityColumn } from "@/lib/column-visibility"

export type AccessLogColumnKey =
  | "timestamp"
  | "statusCode"
  | "method"
  | "url"
  | "host"
  | "ipAddress"
  | "bytesSent"
  | "requestTime"
  | "remoteUser"
  | "httpVersion"
  | "referrer"
  | "server"
  | "logFormat"
  | "userAgent"
  | "upstreamResponseTime"
  | "country"
  | "city"
  | "asn"
  | "asnOrganization"

export interface AccessLogColumn extends VisibilityColumn {
  key: AccessLogColumnKey
  label: string
  grow?: boolean
  sortField?: AccessLogSortField
  sortKind?: SortKind
  align?: "right"
}

export const ACCESS_LOG_COLUMNS = [
  {
    key: "timestamp",
    label: "Time",
    sortField: "timestamp",
    sortKind: "time",
    defaultVisible: true,
  },
  {
    key: "statusCode",
    label: "Status",
    sortField: "statusCode",
    sortKind: "number",
    defaultVisible: true,
  },
  { key: "method", label: "Method", sortField: "method", defaultVisible: true },
  { key: "url", grow: true, label: "URL", sortField: "url", defaultVisible: true },
  {
    key: "host",
    grow: true,
    label: "Host",
    sortField: "host",
    defaultVisible: true,
    mobileHidden: true,
  },
  { key: "ipAddress", label: "IP", sortField: "ipAddress", defaultVisible: true },
  {
    key: "bytesSent",
    label: "Bytes",
    sortField: "bytesSent",
    sortKind: "number",
    defaultVisible: true,
    align: "right",
    mobileHidden: true,
  },
  {
    key: "requestTime",
    label: "Req time",
    sortField: "requestTime",
    sortKind: "number",
    defaultVisible: true,
    align: "right",
    mobileHidden: true,
  },
  { key: "remoteUser", grow: true, label: "Remote user", defaultVisible: false },
  { key: "httpVersion", label: "HTTP ver", defaultVisible: false },
  { key: "referrer", grow: true, label: "Referrer", defaultVisible: true, mobileHidden: true },
  { key: "server", grow: true, label: "Server", defaultVisible: false, mobileHidden: true },
  {
    key: "logFormat",
    grow: true,
    label: "Source format",
    defaultVisible: false,
    mobileHidden: true,
  },
  { key: "userAgent", grow: true, label: "User agent", defaultVisible: false },
  {
    key: "upstreamResponseTime",
    label: "Upstream res time",
    defaultVisible: false,
    align: "right",
  },
  { key: "country", label: "Country", defaultVisible: true, mobileHidden: true },
  { key: "city", grow: true, label: "City", defaultVisible: true, mobileHidden: true },
  { key: "asn", label: "ASN", defaultVisible: false, mobileHidden: true },
  {
    key: "asnOrganization",
    grow: true,
    label: "AS organization",
    defaultVisible: false,
    mobileHidden: true,
  },
] satisfies readonly AccessLogColumn[] as readonly AccessLogColumn[]

/** Saved layouts from before the server rename. */
export const ACCESS_LOG_RENAMED_COLUMN_KEYS: RenamedColumnKeys = { hostname: "server" }

/** A column of the combined layout: one field, or several sharing a cell. */
export interface AccessLogCombinedColumn {
  key: AccessLogColumnKey | "request" | "client" | "location"
  label: string
  /** The visible fields this column shows, in the order the cell draws them. */
  fields: AccessLogColumn[]
  grow?: boolean
  width?: string
  /** Keeps the column this wide when the table is short of room, so the narrower columns give way first. */
  minWidth?: string
  align?: "right"
}

const COMBINED_GROUPS: readonly {
  key: "request" | "client" | "location"
  label: string
  fields: readonly AccessLogColumnKey[]
  grow?: boolean
  width?: string
  minWidth?: string
}[] = [
  {
    key: "request",
    label: "Request",
    fields: ["method", "host", "url"],
    grow: true,
    minWidth: "15rem",
  },
  { key: "client", label: "Client", fields: ["ipAddress"] },
  { key: "location", label: "Location", fields: ["city", "country"], width: "9rem" },
]

/** Where each group sits, and the fields that move up beside them. */
const COMBINED_ORDER: readonly (AccessLogColumnKey | "request" | "client" | "location")[] = [
  "timestamp",
  "statusCode",
  "request",
  "client",
  "location",
  "bytesSent",
  "requestTime",
]

/** Shorter headers where the combined layout leaves less room. */
const COMBINED_LABELS: Partial<Record<AccessLogColumnKey, string>> = { requestTime: "Took" }
const COMBINED_WIDTHS: Partial<Record<AccessLogColumnKey, string>> = { referrer: "9rem" }

/**
 * The combined layout of the visible fields: method, host and path share
 * Request, the IP takes Client with its flag, and city and country share
 * Location. A group shows while any of its fields is visible, so the saved
 * field choices mean the same in both layouts. The other fields keep their
 * own columns, in the same order as the separate layout.
 */
export function combinedAccessLogColumns(
  shownColumns: readonly AccessLogColumn[],
): AccessLogCombinedColumn[] {
  const shown = new Map(shownColumns.map((column) => [column.key, column]))
  const grouped = new Set<AccessLogColumnKey>(COMBINED_GROUPS.flatMap((group) => group.fields))
  const byKey = new Map<string, AccessLogCombinedColumn>()
  for (const group of COMBINED_GROUPS) {
    const fields = group.fields.flatMap((key) => shown.get(key) ?? [])
    if (fields.length) byKey.set(group.key, { ...group, fields })
  }
  for (const column of shownColumns) {
    if (grouped.has(column.key)) continue
    byKey.set(column.key, {
      key: column.key,
      label: COMBINED_LABELS[column.key] ?? column.label,
      fields: [column],
      grow: COMBINED_WIDTHS[column.key] ? false : column.grow,
      width: COMBINED_WIDTHS[column.key],
      align: column.align,
    })
  }
  const first = COMBINED_ORDER.flatMap((key) => byKey.get(key) ?? [])
  const rest = [...byKey.values()].filter((column) => !COMBINED_ORDER.includes(column.key))
  return [...first, ...rest]
}
