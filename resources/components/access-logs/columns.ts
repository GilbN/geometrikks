/**
 * Column metadata for the access-logs history table. Static on purpose:
 * labels, defaults, sort fields and mobile hiding live here so visibility
 * persistence and the contract test can read them without rendering. Cell
 * rendering is an exhaustive switch in access-logs-table.tsx.
 */
import type { AccessLogSortField } from "@/lib/api"
import type { VisibilityColumn } from "@/lib/column-visibility"

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
  | "hostname"
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
  sortField?: AccessLogSortField
  align?: "right"
}

export const ACCESS_LOG_COLUMNS = [
  { key: "timestamp", label: "Time", sortField: "timestamp", defaultVisible: true },
  { key: "statusCode", label: "Status", sortField: "statusCode", defaultVisible: true },
  { key: "method", label: "Method", sortField: "method", defaultVisible: true },
  { key: "url", label: "URL", sortField: "url", defaultVisible: true },
  { key: "host", label: "Host", sortField: "host", defaultVisible: true, mobileHidden: true },
  { key: "ipAddress", label: "IP", sortField: "ipAddress", defaultVisible: true },
  { key: "bytesSent", label: "Bytes", sortField: "bytesSent", defaultVisible: true, align: "right", mobileHidden: true },
  { key: "requestTime", label: "Req time", sortField: "requestTime", defaultVisible: true, align: "right", mobileHidden: true },
  { key: "remoteUser", label: "Remote user", defaultVisible: false },
  { key: "httpVersion", label: "HTTP ver", defaultVisible: false },
  { key: "referrer", label: "Referrer", defaultVisible: true, mobileHidden: true },
  { key: "hostname", label: "Recorded by", defaultVisible: false, mobileHidden: true },
  { key: "logFormat", label: "Source format", defaultVisible: false, mobileHidden: true },
  { key: "userAgent", label: "User agent", defaultVisible: false },
  { key: "upstreamResponseTime", label: "Upstream res time", defaultVisible: false, align: "right" },
  { key: "country", label: "Country", defaultVisible: true, mobileHidden: true },
  { key: "city", label: "City", defaultVisible: true, mobileHidden: true },
  { key: "asn", label: "ASN", defaultVisible: false, mobileHidden: true },
  { key: "asnOrganization", label: "AS organization", defaultVisible: false, mobileHidden: true },
] satisfies readonly AccessLogColumn[] as readonly AccessLogColumn[]
