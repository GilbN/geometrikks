import type { ConnectionResponse, StoredConnection } from "./storage"

export interface Access {
  write: boolean
  crowdsec: boolean
  drop: boolean
  asn: boolean
  hostFilter: boolean
}

/** A fresh `/auth/connection` answer the popup or worker saw, tagged with the
 *  stored connection it was checked under. */
export interface ConnectionRefresh {
  origin: string
  savedAt: number
  connection: ConnectionResponse
}

export const FEATURE_LABELS = {
  crowdsecWrite: "CrowdSec bans",
  asn: "ASN",
  drop: "Spamhaus DROP",
} as const

/** Write needs the server's crowdsecWrite and either a Read/write key verified
 *  at Connect, or a keyless connection to a server that still has auth off.
 *  A keyed connection never gains write because the server later turned auth off. */
export function deriveAccess(stored: StoredConnection, fresh: ConnectionResponse): Access {
  const capabilities = new Set(fresh.capabilities)
  const keyAllowsWrite = stored.keyless
    ? fresh.mode === "disabled"
    : stored.verifiedScope === "read_write"
  return {
    write: capabilities.has("crowdsecWrite") && keyAllowsWrite,
    crowdsec: capabilities.has("crowdsec"),
    drop: capabilities.has("drop"),
    asn: capabilities.has("asn"),
    hostFilter: capabilities.has("analyticsHostFilter"),
  }
}

/** Applies a refresh only when it was taken under this very connection, so a
 *  late answer can't bring back a server that was disconnected or replaced. */
export function effectiveConnection(
  stored: StoredConnection,
  refresh: ConnectionRefresh | null,
): StoredConnection {
  if (!refresh || refresh.origin !== stored.origin || refresh.savedAt !== stored.savedAt)
    return stored
  return { ...stored, connection: refresh.connection }
}
