import type { AbuseIpdbStatusResponse } from "@/generated/api/types.gen"
import type { DropIndex } from "@/lib/drop-lists"
import { realChrome, type ChromeApi } from "../lib/chrome-api"
import type { ExtensionClient } from "../lib/client"
import type { Access } from "../lib/connection"
import type { ConnectionResponse, Settings, StoredConnection } from "../lib/storage"

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

/** What one popup open knows once the connection check passed. */
export interface PopupSession {
  ctx: OpenContext
  /** The stored connection with any matching refresh applied. */
  stored: StoredConnection
  connection: ConnectionResponse
  client: ExtensionClient
  access: Access
  settings: Settings
  /** `/abuseipdb/status`, fetched once per open; null when it failed. */
  abuseStatus: AbuseIpdbStatusResponse | null
  dropIndex: DropIndex | null
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
