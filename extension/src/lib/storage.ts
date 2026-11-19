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
  /** Stays the same across a reconnect to this origin. A switch to another
   *  origin or a disconnect starts a new one. */
  lifetime?: string
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

/** One key per connection lifetime. chrome.storage has no compare-and-set,
 *  so a late write from an earlier lifetime, even one on the same origin,
 *  must land on a key the current lifetime never reads. */
const RECENT_PREFIX = "recent:"
const ABUSE_PREFIX = "abuse:"
const recentKey = (origin: string, lifetime: string) => `${RECENT_PREFIX}${origin}:${lifetime}`
const abuseKey = (origin: string, lifetime: string) => `${ABUSE_PREFIX}${origin}:${lifetime}`

const DEFAULT_SETTINGS: Settings = { showSiteStats: true }

/** Names the stored connection a caller fetched a cached value under. A read or
 *  write without a `lifetime` takes it from the stored connection when that
 *  is still the one this identity names. */
export interface ConnectionIdentity {
  origin: string
  savedAt: number
  lifetime?: string
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

/** The lifetime `identity` belongs to, or null when the stored connection
 *  is no longer the one it names. */
async function currentLifetime(
  identity: ConnectionIdentity,
  chromeApi: ChromeApi,
): Promise<string | null> {
  const stored = await getConnection(chromeApi)
  if (!stored || !sameIdentity(stored, identity)) return null
  const lifetime = stored.lifetime ?? ""
  if (identity.lifetime !== undefined && identity.lifetime !== lifetime) return null
  return lifetime
}

async function readLifetime(
  identity: ConnectionIdentity,
  chromeApi: ChromeApi,
): Promise<string | null> {
  return identity.lifetime ?? (await currentLifetime(identity, chromeApi))
}

/** A lifetime no other connection has. Options starts one when it saves a
 *  connection to a new origin, including the first one after a disconnect. */
export function newLifetime(): string {
  return crypto.randomUUID()
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

async function readRecent(
  origin: string,
  lifetime: string,
  chromeApi: ChromeApi,
): Promise<RecentLookup[]> {
  return (await read<RecentLookup[]>(chromeApi, recentKey(origin, lifetime))) ?? []
}

/** Newest first, and only the lookups made on this server. A reconnect to
 *  the same origin, such as a key rotation, keeps them. */
export async function getRecent(
  identity: ConnectionIdentity,
  chromeApi: ChromeApi = realChrome,
): Promise<RecentLookup[]> {
  const lifetime = await readLifetime(identity, chromeApi)
  return lifetime === null ? [] : readRecent(identity.origin, lifetime, chromeApi)
}

/** `identity` is the connection read when the lookup started. The write is
 *  skipped when Options replaced or removed that connection meanwhile. */
export async function pushRecent(
  identity: ConnectionIdentity,
  lookup: RecentLookup,
  chromeApi: ChromeApi = realChrome,
): Promise<void> {
  const lifetime = await currentLifetime(identity, chromeApi)
  if (lifetime === null) return
  const items = await readRecent(identity.origin, lifetime, chromeApi)
  const next = [lookup, ...items.filter((item) => item.ip !== lookup.ip)].slice(0, RECENT_LIMIT)
  if ((await currentLifetime(identity, chromeApi)) !== lifetime) return
  await chromeApi.storage.local.set({ [recentKey(identity.origin, lifetime)]: next })
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
  const lifetime = await readLifetime(identity, chromeApi)
  if (lifetime === null) return null
  const key = abuseKey(identity.origin, lifetime)
  const entry = ((await read<Record<string, AbuseEntry>>(chromeApi, key)) ?? {})[ip]
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
  const lifetime = await currentLifetime(identity, chromeApi)
  if (lifetime === null) return
  const now = Date.now()
  const key = abuseKey(identity.origin, lifetime)
  const cache = (await read<Record<string, AbuseEntry>>(chromeApi, key)) ?? {}
  const kept = Object.fromEntries(
    Object.entries(cache).filter(([, entry]) => now - entry.at < ABUSE_CACHE_MS),
  )
  if ((await currentLifetime(identity, chromeApi)) !== lifetime) return
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
