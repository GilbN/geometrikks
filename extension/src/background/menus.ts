import { BAN_DURATIONS } from "@/lib/crowdsec"
import type { BanDuration } from "../lib/actions"
import type { ChromeApi } from "../lib/chrome-api"
import { deriveAccess, type Access } from "../lib/connection"
import { classifyFailure, type Failure } from "../lib/failures"
import { parseSingleIp } from "../lib/ip"
import type { BanResult, PendingItem, StoredConnection } from "../lib/storage"
import {
  currentConnection,
  enqueuePending,
  sameIdentity,
  storeRefresh,
  type WorkerDeps,
} from "./pending-flow"

export const MENU_PARENT = "gmk"
export const MENU_LOOKUP = "gmk-lookup"
export const MENU_BAN = "gmk-ban"
const BAN_PREFIX = "gmk-ban:"

const CONTEXTS: chrome.contextMenus.CreateProperties["contexts"] = ["selection"]

/** Unqueued; callers already hold the queue. */
async function createMenus(access: Access | null, chromeApi: ChromeApi): Promise<void> {
  await chromeApi.contextMenus.removeAll()
  if (access === null) return
  const menus = chromeApi.contextMenus
  menus.create({ id: MENU_PARENT, title: "GeoMetrikks", contexts: CONTEXTS })
  menus.create({ id: MENU_LOOKUP, parentId: MENU_PARENT, title: "Look up %s", contexts: CONTEXTS })
  if (!access.write) return
  menus.create({ id: MENU_BAN, parentId: MENU_PARENT, title: "Ban %s", contexts: CONTEXTS })
  for (const duration of BAN_DURATIONS) {
    menus.create({
      id: `${BAN_PREFIX}${duration.value}`,
      parentId: MENU_BAN,
      title: duration.label,
      contexts: CONTEXTS,
    })
  }
}

/** Not connected registers nothing. A read-only connection gets Look up only. */
export async function buildMenus(access: Access | null, deps: WorkerDeps): Promise<void> {
  await deps.queue(() => createMenus(access, deps.chrome))
}

function storedAccess(stored: StoredConnection | null): Access | null {
  return stored && deriveAccess(stored, stored.connection)
}

/** Builds the menus from what storage says now, read inside the queue so an
 *  older rebuild can't finish last with stale access. */
export async function rebuildMenus(deps: WorkerDeps): Promise<void> {
  await deps.queue(async () =>
    createMenus(storedAccess(await currentConnection(deps.chrome)), deps.chrome),
  )
}

/** The worker's only writer of `connectionRefresh`; the menus follow it. */
export async function handleRefreshConnection(
  fresh: StoredConnection["connection"],
  started: { origin: string; savedAt: number },
  deps: WorkerDeps,
): Promise<boolean> {
  return storeRefresh(fresh, started, deps, (stored) =>
    createMenus(storedAccess(stored), deps.chrome),
  )
}

const FAILURE_TEXT: Record<Failure, (host: string) => string> = {
  "key-invalid": () => "This key no longer works.",
  "needs-key": () => "This server now needs an API key.",
  "keys-unavailable": () => "GeoMetrikks can't check keys right now.",
  unreachable: (host) => `Can't reach ${host}.`,
  "access-removed": (host) => `GeoMetrikks for Chrome lost access to ${host}.`,
}

function notSent(ip: string, duration: BanDuration, reason: string): BanResult {
  return { ok: false, ip, durationLabel: duration.label, message: `${ip} wasn't banned. ${reason}` }
}

function durationFor(menuItemId: string | number): BanDuration | null {
  if (typeof menuItemId !== "string" || !menuItemId.startsWith(BAN_PREFIX)) return null
  const value = menuItemId.slice(BAN_PREFIX.length)
  return BAN_DURATIONS.find((duration) => duration.value === value) ?? null
}

async function windowIdFor(tab: chrome.tabs.Tab | undefined, deps: WorkerDeps): Promise<number> {
  if (tab?.windowId !== undefined && tab.windowId >= 0) return tab.windowId
  try {
    return (await deps.chrome.windows.getCurrent()).id ?? -1
  } catch {
    return -1
  }
}

/** Checks the connection right before a ban and sends it only while the
 *  stored connection is unchanged and may still write. */
async function banResultFor(
  stored: StoredConnection,
  ip: string,
  duration: BanDuration,
  deps: WorkerDeps,
): Promise<BanResult | null> {
  const host = new URL(stored.origin).host
  const permitted = await deps.chrome.permissions.contains({ origins: [stored.pattern] })
  if (!permitted) return notSent(ip, duration, FAILURE_TEXT["access-removed"](host))
  const checked = await deps.fetchConnection({ origin: stored.origin, key: stored.key })
  if (!sameIdentity(stored, await currentConnection(deps.chrome))) return null
  if (!checked.ok) {
    const failure = classifyFailure(checked.failure, {
      keyless: stored.keyless,
      permissionMissing: false,
    })
    return notSent(ip, duration, FAILURE_TEXT[failure](host))
  }
  const before = deriveAccess(stored, stored.connection)
  const now = deriveAccess(stored, checked.connection)
  if (before.write !== now.write) {
    await handleRefreshConnection(
      checked.connection,
      { origin: stored.origin, savedAt: stored.savedAt },
      deps,
    )
    return notSent(ip, duration, `${host} no longer accepts bans from this connection.`)
  }
  if (now.write !== true)
    return notSent(ip, duration, `${host} doesn't accept bans from this connection.`)
  if (!sameIdentity(stored, await currentConnection(deps.chrome))) return null
  try {
    return await deps.banIp({ origin: stored.origin, key: stored.key }, ip, duration)
  } catch {
    return {
      ok: false,
      ip,
      durationLabel: duration.label,
      message: `Ban failed for ${ip}; the server didn't answer.`,
    }
  }
}

/** Turns a menu click into a stored pending item and returns it. The
 *  caller shows it with `deliverPending`. Text that isn't one IP sends
 *  nothing to the server. */
export async function handleMenuClick(
  info: Pick<chrome.contextMenus.OnClickData, "menuItemId" | "selectionText">,
  tab: chrome.tabs.Tab | undefined,
  deps: WorkerDeps,
): Promise<PendingItem | null> {
  const duration = durationFor(info.menuItemId)
  if (info.menuItemId !== MENU_LOOKUP && duration === null) return null
  const stored = await currentConnection(deps.chrome)
  if (stored === null) return null
  const text = (info.selectionText ?? "").trim()
  const ip = parseSingleIp(text)
  const base = {
    id: deps.newId(),
    text,
    origin: stored.origin,
    windowId: await windowIdFor(tab, deps),
    reservedForPage: false,
  }
  let item: PendingItem
  if (ip === null) {
    item = { ...base, kind: "not-ip", ip: null, result: null, createdAt: deps.now() }
  } else if (duration === null) {
    item = { ...base, kind: "lookup", ip, result: null, createdAt: deps.now() }
  } else {
    const result = await banResultFor(stored, ip, duration, deps)
    if (result === null) return null
    item = { ...base, kind: "ban", ip, result, createdAt: deps.now() }
  }
  return enqueuePending(item, stored, deps)
}
