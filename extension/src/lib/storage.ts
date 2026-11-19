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
  dropLists: "dropLists",
} as const

/** One key per server origin. chrome.storage has no compare-and-set, so a
 *  late write for a replaced server must land on that server's own key and
 *  never overwrite the next server's rows. */
const RECENT_PREFIX = "recent:"
const ABUSE_PREFIX = "abuse:"
const recentKey = (origin: string) => `${RECENT_PREFIX}${origin}`
const abuseKey = (origin: string) => `${ABUSE_PREFIX}${origin}`

const DEFAULT_SETTINGS: Settings = { showSiteStats: true }

/** Which stored connection a cached value was fetched under. */
export interface ConnectionIdentity {
  origin: string
  savedAt: number
}

interface RecentEntry {
  items: RecentLookup[]
}

interface AbuseEntry {
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

/** Newest first, and only the lookups made on this server. A reconnect to
 *  the same origin, such as a key rotation, keeps them. */
export async function getRecent(
  identity: ConnectionIdentity,
  chromeApi: ChromeApi = realChrome,
): Promise<RecentLookup[]> {
  const entry = await read<RecentEntry>(chromeApi, recentKey(identity.origin))
  return entry?.items ?? []
}

/** `identity` is the connection read when the lookup started. The write is
 *  skipped when Options replaced or removed that connection meanwhile. */
export async function pushRecent(
  identity: ConnectionIdentity,
  lookup: RecentLookup,
  chromeApi: ChromeApi = realChrome,
): Promise<void> {
  const items = await getRecent(identity, chromeApi)
  const next = [lookup, ...items.filter((item) => item.ip !== lookup.ip)].slice(0, RECENT_LIMIT)
  if (!(await isCurrent(identity, chromeApi))) return
  const entry: RecentEntry = { items: next }
  await chromeApi.storage.local.set({ [recentKey(identity.origin)]: entry })
}

async function keysWithPrefix(chromeApi: ChromeApi, prefixes: string[]): Promise<string[]> {
  const items = await chromeApi.storage.local.get(null)
  return Object.keys(items).filter((key) => prefixes.some((prefix) => key.startsWith(prefix)))
}

export async function clearRecent(chromeApi: ChromeApi = realChrome): Promise<void> {
  await chromeApi.storage.local.remove(await keysWithPrefix(chromeApi, [RECENT_PREFIX]))
}

export async function getAbuseCache(
  identity: ConnectionIdentity,
  ip: string,
  chromeApi: ChromeApi = realChrome,
): Promise<CheckResponse | null> {
  const cache = (await read<Record<string, AbuseEntry>>(chromeApi, abuseKey(identity.origin))) ?? {}
  const entry = cache[ip]
  if (!entry) return null
  return Date.now() - entry.at < ABUSE_CACHE_MS ? entry.result : null
}

/** `identity` is the connection read when the check started. The write is
 *  skipped when Options replaced or removed that connection meanwhile. */
export async function setAbuseCache(
  identity: ConnectionIdentity,
  ip: string,
  result: CheckResponse,
  chromeApi: ChromeApi = realChrome,
): Promise<void> {
  const now = Date.now()
  const key = abuseKey(identity.origin)
  const cache = (await read<Record<string, AbuseEntry>>(chromeApi, key)) ?? {}
  const kept = Object.fromEntries(
    Object.entries(cache).filter(([, entry]) => now - entry.at < ABUSE_CACHE_MS),
  )
  if (!(await isCurrent(identity, chromeApi))) return
  const entry: AbuseEntry = { result, at: now }
  await chromeApi.storage.local.set({ [key]: { ...kept, [ip]: entry } })
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

/** Everything kept for any server except the connection itself.
 *  Pending right-click items live in session storage; the worker clears those. */
export async function clearLocalServerData(chromeApi: ChromeApi = realChrome): Promise<void> {
  const perServer = await keysWithPrefix(chromeApi, [RECENT_PREFIX, ABUSE_PREFIX])
  await chromeApi.storage.local.remove([...perServer, KEYS.dropLists, KEYS.connectionRefresh])
}
