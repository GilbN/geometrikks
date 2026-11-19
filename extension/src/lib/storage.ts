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

interface RecentEntry {
  origin: string
  items: RecentLookup[]
}

interface AbuseEntry {
  result: CheckResponse
  at: number
}

interface DropEntry {
  origin: string
  savedAt: number
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

/** Newest first, and only the lookups made on `origin`. */
export async function getRecent(
  origin: string,
  chromeApi: ChromeApi = realChrome,
): Promise<RecentLookup[]> {
  const entry = await read<RecentEntry>(chromeApi, KEYS.recent)
  return entry?.origin === origin ? entry.items : []
}

export async function pushRecent(
  origin: string,
  lookup: RecentLookup,
  chromeApi: ChromeApi = realChrome,
): Promise<void> {
  const items = await getRecent(origin, chromeApi)
  const next = [lookup, ...items.filter((item) => item.ip !== lookup.ip)].slice(0, RECENT_LIMIT)
  await chromeApi.storage.local.set({ [KEYS.recent]: { origin, items: next } })
}

export async function clearRecent(chromeApi: ChromeApi = realChrome): Promise<void> {
  await chromeApi.storage.local.remove(KEYS.recent)
}

export async function getAbuseCache(
  ip: string,
  chromeApi: ChromeApi = realChrome,
): Promise<CheckResponse | null> {
  const cache = (await read<Record<string, AbuseEntry>>(chromeApi, KEYS.abuseCache)) ?? {}
  const entry = cache[ip]
  return entry && Date.now() - entry.at < ABUSE_CACHE_MS ? entry.result : null
}

export async function setAbuseCache(
  ip: string,
  result: CheckResponse,
  chromeApi: ChromeApi = realChrome,
): Promise<void> {
  const now = Date.now()
  const cache = (await read<Record<string, AbuseEntry>>(chromeApi, KEYS.abuseCache)) ?? {}
  const kept = Object.fromEntries(
    Object.entries(cache).filter(([, entry]) => now - entry.at < ABUSE_CACHE_MS),
  )
  await chromeApi.storage.local.set({ [KEYS.abuseCache]: { ...kept, [ip]: { result, at: now } } })
}

/** The cached lists, or null when stale or fetched for another connection. */
export async function getDropLists(
  identity: { origin: string; savedAt: number },
  chromeApi: ChromeApi = realChrome,
): Promise<DropListsResponse | null> {
  const entry = await read<DropEntry>(chromeApi, KEYS.dropLists)
  if (!entry || entry.origin !== identity.origin || entry.savedAt !== identity.savedAt) return null
  return Date.now() - entry.fetchedAt < DROP_CACHE_MS ? entry.lists : null
}

/** `identity` is the connection read before the fetch started, so lists
 *  fetched for one server are never served to the next. */
export async function setDropLists(
  identity: { origin: string; savedAt: number },
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
  await chromeApi.storage.local.remove([KEYS.recent, KEYS.abuseCache, KEYS.dropLists])
}
