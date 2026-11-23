import type { AbuseIpdbStatusResponse } from "@/generated/api/types.gen"
import type { DropIndex } from "@/lib/drop-lists"
import { realChrome, type ChromeApi } from "../lib/chrome-api"
import type { ExtensionClient } from "../lib/client"
import {
  deriveAccess,
  effectiveConnection,
  sameIdentity,
  type Access,
  type ConnectionRefresh,
} from "../lib/connection"
import {
  getConnection,
  getConnectionRefresh,
  type ConnectionResponse,
  type Settings,
  type StoredConnection,
} from "../lib/storage"

export interface OpenContext {
  windowId: number
  tabUrl: string | undefined
  /** Set when the worker opened this page as a tab for a right-click result. */
  pendingId: string | null
}

/** The window and active tab this popup opened over. `tab.url` is readable
 *  through `activeTab` after a toolbar click; from anywhere else it is undefined. */
export async function readOpenContext(
  chromeApi: ChromeApi = realChrome,
  search: string = location.search,
): Promise<OpenContext> {
  const params = new URLSearchParams(search)
  const [currentWindow, [activeTab]] = await Promise.all([
    chromeApi.windows.getCurrent(),
    chromeApi.tabs.query({ active: true, currentWindow: true }),
  ])
  let tabUrl = activeTab?.url
  if (import.meta.env.MODE === "e2e") tabUrl = params.get("tabUrl") ?? tabUrl
  return { windowId: currentWindow.id ?? -1, tabUrl, pendingId: params.get("pending") }
}

/** The saved connection with its refresh applied. The refresh is optional: a
 *  failed read of it keeps the saved connection as it is. */
export async function readStoredConnection(
  chromeApi: ChromeApi = realChrome,
): Promise<StoredConnection | null> {
  const saved = await getConnection(chromeApi)
  if (!saved) return null
  let refresh: ConnectionRefresh | null
  try {
    refresh = await getConnectionRefresh(chromeApi)
  } catch {
    refresh = null
  }
  return effectiveConnection(saved, refresh)
}

/** What one popup open knows once the connection check passed. */
export interface PopupSession {
  ctx: OpenContext
  /** The stored connection with any matching refresh applied. */
  stored: StoredConnection
  connection: ConnectionResponse
  client: ExtensionClient
  access: Access
  settings: Settings
  /** Optional data, loaded once per open while Home shows. Neither rejects:
   *  each resolves to null when its call or the DROP cache fails. */
  abuseStatus: Promise<AbuseIpdbStatusResponse | null>
  dropIndex: Promise<DropIndex | null>
}

export const SESSION_STALE_MESSAGE = "The connection changed. Reopen the popup."

/** False once Options saved another connection, or one with other write
 *  access, after this session opened. The session's client still sends the
 *  key it opened with, so a write must not go out through it then. */
export function sessionIsCurrent(session: PopupSession, latest: StoredConnection | null): boolean {
  if (latest === null || !sameIdentity(session.stored, latest)) return false
  return deriveAccess(latest, session.connection).write === session.access.write
}

export type Guarded<T> = { stale: true } | { stale: false; value: T }

/** Runs `send` only while the stored connection read right before it is
 *  still this session's. A failed read counts as changed. */
export async function sendWhileCurrent<T>(
  session: PopupSession,
  send: () => Promise<T>,
  chromeApi: ChromeApi = realChrome,
): Promise<Guarded<T>> {
  let refresh: ConnectionRefresh | null
  try {
    refresh = await getConnectionRefresh(chromeApi)
  } catch {
    refresh = null
  }
  let saved: StoredConnection | null
  try {
    // Last await before `send`: a connection saved during any earlier read
    // would otherwise go unseen.
    saved = await getConnection(chromeApi)
  } catch {
    return { stale: true }
  }
  const latest = saved && effectiveConnection(saved, refresh)
  if (!sessionIsCurrent(session, latest)) return { stale: true }
  return { stale: false, value: await send() }
}

export function connectionChanged(stored: ConnectionResponse, fresh: ConnectionResponse): boolean {
  if (stored.mode !== fresh.mode) return true
  const before = [...stored.capabilities].sort().join()
  const after = [...fresh.capabilities].sort().join()
  return before !== after
}

/** Only the worker writes `connectionRefresh`, inside its queue. */
export async function refreshViaWorker(
  fresh: ConnectionResponse,
  started: { origin: string; savedAt: number },
  chromeApi: ChromeApi = realChrome,
): Promise<void> {
  try {
    await chromeApi.runtime.sendMessage({ type: "refreshConnection", fresh, started })
  } catch {
    // No listener answered; the next open sends it again.
  }
}
