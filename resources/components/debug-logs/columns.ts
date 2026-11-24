/**
 * Column metadata for the debug-logs table. Static on purpose: labels,
 * defaults, sort fields and mobile hiding live here so visibility persistence
 * and tests can read them without rendering. Cell rendering is an exhaustive
 * switch in debug-logs-table.tsx.
 */
import type { AccessLogDebugSortField } from "@/lib/api"
import type { SortKind } from "@/components/data/sort-options"
import type { VisibilityColumn } from "@/lib/column-visibility"

export type DebugLogColumnKey =
  | "createdAt"
  | "isMalformed"
  | "parseError"
  | "logFormat"
  | "rawLine"
  | "statusCode"
  | "method"
  | "ipAddress"
  | "url"
  | "host"
  | "timestamp"
  | "country"
  | "city"
  | "userAgent"

export interface DebugLogColumn extends VisibilityColumn {
  key: DebugLogColumnKey
  label: string
  grow?: boolean
  sortField?: AccessLogDebugSortField
  sortKind?: SortKind
}

export const DEBUG_LOG_COLUMNS = [
  {
    key: "createdAt",
    label: "Captured",
    sortField: "createdAt",
    sortKind: "time",
    defaultVisible: true,
  },
  {
    key: "isMalformed",
    label: "Malformed",
    sortField: "isMalformed",
    sortKind: "flag",
    defaultVisible: true,
  },
  {
    key: "parseError",
    grow: true,
    label: "Parse error",
    sortField: "parseError",
    defaultVisible: true,
    mobileHidden: true,
  },
  {
    key: "logFormat",
    label: "Source format",
    sortField: "logFormat",
    defaultVisible: false,
    mobileHidden: true,
  },
  {
    key: "rawLine",
    grow: true,
    label: "Raw line",
    defaultVisible: true,
  },
  {
    key: "statusCode",
    label: "Status",
    sortField: "statusCode",
    sortKind: "number",
    defaultVisible: true,
    mobileHidden: true,
  },
  {
    key: "method",
    label: "Method",
    defaultVisible: true,
    mobileHidden: true,
  },
  {
    key: "ipAddress",
    label: "IP",
    sortField: "ipAddress",
    defaultVisible: true,
    mobileHidden: true,
  },
  {
    key: "url",
    grow: true,
    label: "URL",
    defaultVisible: false,
  },
  {
    key: "host",
    grow: true,
    label: "Host",
    sortField: "host",
    defaultVisible: false,
  },
  {
    key: "timestamp",
    label: "Log time",
    sortField: "timestamp",
    sortKind: "time",
    defaultVisible: false,
  },
  {
    key: "country",
    label: "Country",
    sortField: "countryCode",
    defaultVisible: false,
  },
  {
    key: "city",
    grow: true,
    label: "City",
    sortField: "city",
    defaultVisible: false,
  },
  {
    key: "userAgent",
    grow: true,
    label: "User agent",
    defaultVisible: false,
  },
] satisfies readonly DebugLogColumn[] as readonly DebugLogColumn[]

/** A column of the combined layout: one field, or several sharing a cell. */
export interface DebugLogCombinedColumn {
  key: DebugLogColumnKey | "result" | "request" | "client"
  label: string
  /** The visible fields this column shows, in the order the cell draws them. */
  fields: DebugLogColumn[]
  grow?: boolean
  width?: string
  /** Keeps the column this wide when the table is short of room, so narrower columns give way first. */
  minWidth?: string
}

const COMBINED_GROUPS: readonly {
  key: "result" | "request" | "client"
  label: string
  fields: readonly DebugLogColumnKey[]
}[] = [
  { key: "result", label: "Result", fields: ["isMalformed", "parseError"] },
  { key: "request", label: "Request", fields: ["statusCode", "method", "host", "url"] },
  { key: "client", label: "Client", fields: ["ipAddress"] },
]

/** Where each group sits, and the fields that move up beside them. */
const COMBINED_ORDER: readonly (DebugLogColumnKey | "result" | "request" | "client")[] = [
  "createdAt",
  "result",
  "rawLine",
  "request",
  "client",
]

const COMBINED_LABELS: Partial<Record<DebugLogColumnKey, string>> = { rawLine: "Line" }
const COMBINED_MIN_WIDTHS: Partial<Record<DebugLogColumnKey, string>> = { rawLine: "15rem" }

function groupWidth(
  key: "result" | "request" | "client",
  fields: readonly DebugLogColumn[],
): string | undefined {
  if (key === "result") {
    return fields.some((field) => field.key === "parseError") ? "14rem" : undefined
  }
  if (key === "request") {
    return fields.some((field) => field.key === "host" || field.key === "url") ? "16rem" : undefined
  }
  return undefined
}

/**
 * The combined layout of the visible fields: Malformed and Parse error share
 * Result, status/method/host/path share Request, the IP takes Client, and Raw
 * line becomes Line with the remaining width. A group shows while any of its
 * fields is visible, so the saved field choices mean the same in both layouts.
 */
export function combinedDebugLogColumns(
  shownColumns: readonly DebugLogColumn[],
): DebugLogCombinedColumn[] {
  const shown = new Map(shownColumns.map((column) => [column.key, column]))
  const grouped = new Set<DebugLogColumnKey>(COMBINED_GROUPS.flatMap((group) => group.fields))
  const byKey = new Map<string, DebugLogCombinedColumn>()
  for (const group of COMBINED_GROUPS) {
    const fields = group.fields.flatMap((key) => shown.get(key) ?? [])
    if (fields.length) {
      byKey.set(group.key, {
        key: group.key,
        label: group.label,
        fields,
        width: groupWidth(group.key, fields),
      })
    }
  }
  for (const column of shownColumns) {
    if (grouped.has(column.key)) continue
    byKey.set(column.key, {
      key: column.key,
      label: COMBINED_LABELS[column.key] ?? column.label,
      fields: [column],
      grow: column.grow,
      minWidth: COMBINED_MIN_WIDTHS[column.key],
    })
  }
  const first = COMBINED_ORDER.flatMap((key) => byKey.get(key) ?? [])
  const rest = [...byKey.values()].filter((column) => !COMBINED_ORDER.includes(column.key))
  return [...first, ...rest]
}
