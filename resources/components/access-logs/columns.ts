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
  width: number
  sortField?: AccessLogSortField
  align?: "right"
}

export const ACCESS_LOG_COLUMNS = [
  { key: "timestamp", width: 205, label: "Time", sortField: "timestamp", defaultVisible: true },
  { key: "statusCode", width: 90, label: "Status", sortField: "statusCode", defaultVisible: true },
  { key: "method", width: 100, label: "Method", sortField: "method", defaultVisible: true },
  { key: "url", width: 320, label: "URL", sortField: "url", defaultVisible: true },
  { key: "host", width: 220, label: "Host", sortField: "host", defaultVisible: true, mobileHidden: true },
  { key: "ipAddress", width: 250, label: "IP", sortField: "ipAddress", defaultVisible: true },
  { key: "bytesSent", width: 105, label: "Bytes", sortField: "bytesSent", defaultVisible: true, align: "right", mobileHidden: true },
  { key: "requestTime", width: 105, label: "Req time", sortField: "requestTime", defaultVisible: true, align: "right", mobileHidden: true },
  { key: "remoteUser", width: 160, label: "Remote user", defaultVisible: false },
  { key: "httpVersion", width: 100, label: "HTTP ver", defaultVisible: false },
  { key: "referrer", width: 280, label: "Referrer", defaultVisible: true, mobileHidden: true },
  { key: "hostname", width: 180, label: "Recorded by", defaultVisible: false, mobileHidden: true },
  { key: "logFormat", width: 180, label: "Source format", defaultVisible: false, mobileHidden: true },
  { key: "userAgent", width: 300, label: "User agent", defaultVisible: false },
  { key: "upstreamResponseTime", width: 155, label: "Upstream res time", defaultVisible: false, align: "right" },
  { key: "country", width: 120, label: "Country", defaultVisible: true, mobileHidden: true },
  { key: "city", width: 160, label: "City", defaultVisible: true, mobileHidden: true },
  { key: "asn", width: 120, label: "ASN", defaultVisible: false, mobileHidden: true },
  { key: "asnOrganization", width: 240, label: "AS organization", defaultVisible: false, mobileHidden: true },
] satisfies readonly AccessLogColumn[] as readonly AccessLogColumn[]
