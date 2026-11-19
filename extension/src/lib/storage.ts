import type {
  ApiV1AuthConnectionConnectionResponse,
  CheckResponse,
  DropListsResponse,
} from "@/generated/api/types.gen"
import { realChrome, type ChromeApi } from "./chrome-api"
import type { ConnectionRefresh } from "./connection"

export type ConnectionResponse = ApiV1AuthConnectionConnectionResponse

export interface StoredConnection {
  origin: string
  pattern: string
  key: string | null
  keyless: boolean
  /** From the `apiKey` answer at Connect; a refresh never changes it. */
  verifiedScope: "read" | "read_write" | null
  connection: ConnectionResponse
  savedAt: number
}

export interface Settings {
  showSiteStats: boolean
}

export interface RecentLookup {
  ip: string
  countryCode: string | null
  asn: number | null
  asOrganization: string | null
  decisionType: string | null
  dropSblId: string | null
  at: number
}

export interface BanResult {
  ok: boolean
  ip: string
  durationLabel: string
  message: string
}

export interface PendingItem {
  id: string
  kind: "lookup" | "ban" | "not-ip"
  ip: string | null
  text: string
  result: BanResult | null
  origin: string
  windowId: number
  createdAt: number
  reservedForPage: boolean
}

export const RECENT_LIMIT = 5
export const ABUSE_CACHE_MS = 15 * 60_000
export const DROP_CACHE_MS = 6 * 60 * 60_000

const KEYS = {
  connection: "connection",
  connectionRefresh: "connectionRefresh",
  settings: "settings",
  recent: "recent",
  abuseCache: "abuseCache",
  dropLists: "dropLists",
} as const

const DEFAULT_SETTINGS: Settings = { showSiteStats: true }

/** Which stored connection a cached value was fetched under. */
export interface ConnectionIdentity {
  origin: string
  savedAt: number
}

interface RecentEntry extends ConnectionIdentity {
  items: RecentLookup[]
}

interface AbuseEntry extends ConnectionIdentity {
  result: CheckResponse
  at: number
}

interface DropEntry extends ConnectionIdentity {
  fetchedAt: number
  lists: DropListsResponse
}

async function read<T>(chromeApi: ChromeApi, key: string): Promise<T | null> {
  const items = await chromeApi.storage.local.get(key)
  return (items[key] as T | undefined) ?? null
}

export async function getConnection(chromeApi: ChromeApi = realChrome) {
  return read<StoredConnection>(chromeApi, KEYS.connection)
}

function sameIdentity(a: ConnectionIdentity, b: ConnectionIdentity): boolean {
  return a.origin === b.origin && a.savedAt === b.savedAt
}

async function isCurrent(identity: ConnectionIdentity, chromeApi: ChromeApi): Promise<boolean> {
  const stored = await getConnection(chromeApi)
  return stored !== null && sameIdentity(stored, identity)
}

/** Options is the only writer of the connection. */
export async function setConnection(
  connection: StoredConnection,
  chromeApi: ChromeApi = realChrome,
): Promise<void> {
  await chromeApi.storage.local.set({ [KEYS.connection]: connection })
}

export async function removeConnection(chromeApi: ChromeApi = realChrome): Promise<void> {
  await chromeApi.storage.local.remove(KEYS.connection)
}

export async function getConnectionRefresh(chromeApi: ChromeApi = realChrome) {
  return read<ConnectionRefresh>(chromeApi, KEYS.connectionRefresh)
}

/** The worker is the only writer of the refresh. */
export async function setConnectionRefresh(
  refresh: ConnectionRefresh,
  chromeApi: ChromeApi = realChrome,
): Promise<void> {
  await chromeApi.storage.local.set({ [KEYS.connectionRefresh]: refresh })
}

export async function getSettings(chromeApi: ChromeApi = realChrome): Promise<Settings> {
  const stored = await read<Partial<Settings>>(chromeApi, KEYS.settings)
  return { ...DEFAULT_SETTINGS, ...stored }
}

export async function setSettings(
  settings: Settings,
  chromeApi: ChromeApi = realChrome,
): Promise<void> {
  await chromeApi.storage.local.set({ [KEYS.settings]: settings })
}

/** Newest first, and only the lookups made under this connection. */
export async function getRecent(
  identity: ConnectionIdentity,
  chromeApi: ChromeApi = realChrome,
): Promise<RecentLookup[]> {
  const entry = await read<RecentEntry>(chromeApi, KEYS.recent)
  return entry && sameIdentity(entry, identity) ? entry.items : []
}

/** `identity` is the connection read when the lookup started. Dropped when
 *  that connection was replaced or removed while the lookup ran. */
export async function pushRecent(
  identity: ConnectionIdentity,
  lookup: RecentLookup,
  chromeApi: ChromeApi = realChrome,
): Promise<void> {
  const items = await getRecent(identity, chromeApi)
  const next = [lookup, ...items.filter((item) => item.ip !== lookup.ip)].slice(0, RECENT_LIMIT)
  if (!(await isCurrent(identity, chromeApi))) return
  const entry: RecentEntry = { origin: identity.origin, savedAt: identity.savedAt, items: next }
  await chromeApi.storage.local.set({ [KEYS.recent]: entry })
}

export async function clearRecent(chromeApi: ChromeApi = realChrome): Promise<void> {
  await chromeApi.storage.local.remove(KEYS.recent)
}

export async function getAbuseCache(
  identity: ConnectionIdentity,
  ip: string,
  chromeApi: ChromeApi = realChrome,
): Promise<CheckResponse | null> {
  const cache = (await read<Record<string, AbuseEntry>>(chromeApi, KEYS.abuseCache)) ?? {}
  const entry = cache[ip]
  if (!entry || !sameIdentity(entry, identity)) return null
  return Date.now() - entry.at < ABUSE_CACHE_MS ? entry.result : null
}

/** `identity` is the connection read when the check started. Dropped when
 *  that connection was replaced or removed while the check ran. */
export async function setAbuseCache(
  identity: ConnectionIdentity,
  ip: string,
  result: CheckResponse,
  chromeApi: ChromeApi = realChrome,
): Promise<void> {
  const now = Date.now()
  const cache = (await read<Record<string, AbuseEntry>>(chromeApi, KEYS.abuseCache)) ?? {}
  const kept = Object.fromEntries(
    Object.entries(cache).filter(
      ([, entry]) => sameIdentity(entry, identity) && now - entry.at < ABUSE_CACHE_MS,
    ),
  )
  if (!(await isCurrent(identity, chromeApi))) return
  const entry: AbuseEntry = { origin: identity.origin, savedAt: identity.savedAt, result, at: now }
  await chromeApi.storage.local.set({ [KEYS.abuseCache]: { ...kept, [ip]: entry } })
}

/** The cached lists, or null when stale or fetched for another connection. */
export async function getDropLists(
  identity: ConnectionIdentity,
  chromeApi: ChromeApi = realChrome,
): Promise<DropListsResponse | null> {
  const entry = await read<DropEntry>(chromeApi, KEYS.dropLists)
  if (!entry || !sameIdentity(entry, identity)) return null
  return Date.now() - entry.fetchedAt < DROP_CACHE_MS ? entry.lists : null
}

/** `identity` is the connection read before the fetch started, so lists
 *  fetched for one server are never served to the next. */
export async function setDropLists(
  identity: ConnectionIdentity,
  lists: DropListsResponse,
  chromeApi: ChromeApi = realChrome,
): Promise<void> {
  const entry: DropEntry = {
    origin: identity.origin,
    savedAt: identity.savedAt,
    fetchedAt: Date.now(),
    lists,
  }
  await chromeApi.storage.local.set({ [KEYS.dropLists]: entry })
}

/** Everything kept for the current server except the connection itself.
 *  Pending right-click items live in session storage; the worker clears those. */
export async function clearLocalServerData(chromeApi: ChromeApi = realChrome): Promise<void> {
  await chromeApi.storage.local.remove([
    KEYS.recent,
    KEYS.abuseCache,
    KEYS.dropLists,
    KEYS.connectionRefresh,
  ])
}
