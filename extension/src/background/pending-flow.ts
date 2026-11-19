import { banIp, type BanDuration } from "../lib/actions"
import { realChrome, type ChromeApi } from "../lib/chrome-api"
import {
  createExtensionClient,
  fetchConnection as fetchConnectionReal,
  type ClientTarget,
} from "../lib/client"
import { effectiveConnection, type ConnectionRefresh } from "../lib/connection"
import type { FailureInput } from "../lib/failures"
import { createSerialQueue, PENDING_TTL_MS, selectById, selectForPopup } from "../lib/pending"
import {
  getConnection,
  getConnectionRefresh,
  setConnectionRefresh,
  type BanResult,
  type ConnectionResponse,
  type PendingItem,
  type StoredConnection,
} from "../lib/storage"

export type SerialQueue = <T>(job: () => Promise<T>) => Promise<T>

export interface WorkerDeps {
  chrome: ChromeApi
  /** Every read-then-write of pending items, refreshes and menus runs here. */
  queue: SerialQueue
  fetchConnection: (
    target: ClientTarget,
  ) => Promise<{ ok: true; connection: ConnectionResponse } | { ok: false; failure: FailureInput }>
  banIp: (target: ClientTarget, ip: string, duration: BanDuration) => Promise<BanResult>
  now: () => number
  newId: () => string
}

export function createWorkerDeps(chromeApi: ChromeApi = realChrome): WorkerDeps {
  return {
    chrome: chromeApi,
    queue: createSerialQueue(),
    fetchConnection: (target) => fetchConnectionReal(target),
    banIp: (target, ip, duration) => banIp(createExtensionClient(target), ip, duration),
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
  }
}

const PENDING_KEY = "pending"

export type ClaimRequest = { windowId: number; origin: string } | { id: string; origin: string }

/** The stored connection with a matching refresh applied, or null. */
export async function currentConnection(chromeApi: ChromeApi): Promise<StoredConnection | null> {
  const stored = await getConnection(chromeApi)
  return stored && effectiveConnection(stored, await getConnectionRefresh(chromeApi))
}

/** True when `b` is still the connection `a` was read as. A reconnect to
 *  the same origin changes `savedAt` and may change the key. */
export function sameIdentity(a: StoredConnection | null, b: StoredConnection | null): boolean {
  return (
    a !== null &&
    b !== null &&
    a.origin === b.origin &&
    a.savedAt === b.savedAt &&
    a.key === b.key &&
    (a.generation ?? 0) === (b.generation ?? 0)
  )
}

async function readPending(chromeApi: ChromeApi, now: number): Promise<PendingItem[]> {
  const items = await chromeApi.storage.session.get(PENDING_KEY)
  const list = items[PENDING_KEY]
  if (!Array.isArray(list)) return []
  return (list as PendingItem[]).filter((item) => now - item.createdAt < PENDING_TTL_MS)
}

async function writePending(chromeApi: ChromeApi, items: PendingItem[]): Promise<void> {
  await chromeApi.storage.session.set({ [PENDING_KEY]: items })
}

/** Stores `item` only while the connection it was made under is still the
 *  stored one. */
export async function enqueuePending(
  item: PendingItem,
  identity: StoredConnection,
  deps: WorkerDeps,
): Promise<PendingItem | null> {
  return deps.queue(async () => {
    if (!sameIdentity(identity, await currentConnection(deps.chrome))) return null
    const items = await readPending(deps.chrome, deps.now())
    await writePending(deps.chrome, [...items, item])
    return item
  })
}

/** Grants the newest matching item once and removes it in the same step. */
export async function claimPending(
  request: ClaimRequest,
  deps: WorkerDeps,
): Promise<PendingItem | null> {
  return deps.queue(async () => {
    const now = deps.now()
    const items = await readPending(deps.chrome, now)
    const claimed =
      "id" in request
        ? selectById(items, { id: request.id, origin: request.origin, now })
        : selectForPopup(items, { windowId: request.windowId, origin: request.origin, now })
    if (claimed === null) return null
    await writePending(
      deps.chrome,
      items.filter((item) => item.id !== claimed.id),
    )
    return claimed
  })
}

export async function clearPending(deps: WorkerDeps): Promise<void> {
  await deps.queue(async () => {
    await deps.chrome.storage.session.remove(PENDING_KEY)
  })
}

/** Marks the item for the fallback page, unless a popup claimed it first. */
async function reserveForPage(id: string, deps: WorkerDeps): Promise<boolean> {
  return deps.queue(async () => {
    const items = await readPending(deps.chrome, deps.now())
    if (!items.some((item) => item.id === id)) return false
    await writePending(
      deps.chrome,
      items.map((item) => (item.id === id ? { ...item, reservedForPage: true } : item)),
    )
    return true
  })
}

/** Opens the toolbar popup on the window the click came from, or a tab
 *  showing the item when Chrome won't open the popup. */
export async function deliverPending(item: PendingItem, deps: WorkerDeps): Promise<void> {
  try {
    await deps.chrome.action.openPopup({ windowId: item.windowId })
    return
  } catch {
    // No focused window, or another popup is open. The fallback page shows it.
  }
  if (!(await reserveForPage(item.id, deps))) return
  const url = `popup.html?pending=${encodeURIComponent(item.id)}`
  try {
    await deps.chrome.tabs.create({ windowId: item.windowId, url })
  } catch {
    await deps.chrome.windows.create({ url })
  }
}

/** Stores a fresh `/auth/connection` answer taken under `started`, and
 *  drops a late answer for a replaced or reconnected server. */
export async function storeRefresh(
  fresh: ConnectionResponse,
  started: { origin: string; savedAt: number },
  deps: WorkerDeps,
  afterWrite?: (stored: StoredConnection) => Promise<void>,
): Promise<boolean> {
  return deps.queue(async () => {
    const stored = await getConnection(deps.chrome)
    if (!stored || stored.origin !== started.origin || stored.savedAt !== started.savedAt)
      return false
    const refresh: ConnectionRefresh = {
      origin: stored.origin,
      savedAt: stored.savedAt,
      connection: fresh,
    }
    await setConnectionRefresh(refresh, deps.chrome)
    await afterWrite?.({ ...stored, connection: fresh })
    return true
  })
}

export type WorkerMessage =
  | ({ type: "claimPending" } & ClaimRequest)
  | { type: "serverChanged" }
  | {
      type: "refreshConnection"
      fresh: ConnectionResponse
      started: { origin: string; savedAt: number }
    }

/** The claim inside a `claimPending` message, or null when it is malformed. */
export function claimRequestFrom(message: Record<string, unknown>): ClaimRequest | null {
  const { origin, id, windowId } = message
  if (typeof origin !== "string") return null
  if (typeof id === "string") return { id, origin }
  if (typeof windowId === "number") return { windowId, origin }
  return null
}

export function refreshFrom(
  message: Record<string, unknown>,
): { fresh: ConnectionResponse; started: { origin: string; savedAt: number } } | null {
  const { fresh, started } = message
  if (typeof fresh !== "object" || fresh === null) return null
  const { mode, capabilities } = fresh as Record<string, unknown>
  if ((mode !== "apiKey" && mode !== "disabled") || !Array.isArray(capabilities)) return null
  if (typeof started !== "object" || started === null) return null
  const { origin, savedAt } = started as Record<string, unknown>
  if (typeof origin !== "string" || typeof savedAt !== "number") return null
  return { fresh: fresh as ConnectionResponse, started: { origin, savedAt } }
}
