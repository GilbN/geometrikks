import type { ChromeApi } from "../lib/chrome-api"
import type { ClientTarget } from "../lib/client"
import type { FailureInput } from "../lib/failures"
import { normalizeOrigin } from "../lib/origin"
import { effectiveConnection } from "../lib/connection"
import {
  clearLocalServerData,
  getConnection,
  getConnectionRefresh,
  nextGeneration,
  removeConnection,
  setConnection,
  type ConnectionResponse,
  type StoredConnection,
} from "../lib/storage"

export const NOT_HTTPS_MESSAGE = "GeoMetrikks for Chrome needs an https:// address"
export const INVALID_ADDRESS_MESSAGE = "Enter the full address, starting with https://."
export const MISSING_ADDRESS_MESSAGE = "Enter the address you open GeoMetrikks on."
export const AUTH_OFF_WITH_KEY_MESSAGE =
  "Authentication is off on this server. Clear the key field to connect without one."
export const UNEXPECTED_MESSAGE = "Something went wrong. Try again."

export type FetchConnection = (
  target: ClientTarget,
) => Promise<{ ok: true; connection: ConnectionResponse } | { ok: false; failure: FailureInput }>

export interface ConnectDeps {
  chrome: ChromeApi
  fetchConnection: FetchConnection
  now?: () => number
}

export type ConnectResult =
  | { ok: true; stored: StoredConnection }
  | { ok: false; field: "address" | "key" | null; message: string }

export function addressError(address: string): string | null {
  if (!address.trim()) return MISSING_ADDRESS_MESSAGE
  const normalized = normalizeOrigin(address)
  if (normalized.ok) return null
  return normalized.reason === "not-https" ? NOT_HTTPS_MESSAGE : INVALID_ADDRESS_MESSAGE
}

export function apiKeysPageUrl(address: string): string | null {
  const normalized = normalizeOrigin(address)
  return normalized.ok ? `${normalized.origin}/settings/api-keys` : null
}

function failureMessage(
  failure: FailureInput,
  host: string,
  keyed: boolean,
): { field: "key" | null; message: string } {
  if (failure.timedOut) return { field: null, message: `${host} didn't answer within 10 seconds.` }
  if (failure.networkError)
    return {
      field: null,
      message: `Can't reach ${host}. Check the address and that this computer can open it.`,
    }
  if (failure.notJson)
    return {
      field: null,
      message: `${host} didn't answer with GeoMetrikks JSON. A login proxy in front of it has to let /api/ through.`,
    }
  if (failure.code === "not_authenticated")
    return {
      field: "key",
      message: keyed
        ? `${host} didn't receive the key. A proxy in front of it may be dropping the Authorization header.`
        : "This server needs an API key.",
    }
  const keyField = failure.code === "api_key_invalid" || failure.code === "api_key_expired"
  if (failure.detail) return { field: keyField ? "key" : null, message: failure.detail }
  return { field: null, message: `${host} answered with status ${failure.status ?? "unknown"}.` }
}

async function settle(promise: Promise<boolean>, fallback: boolean): Promise<boolean> {
  try {
    return await promise
  } catch {
    return fallback
  }
}

async function bestEffort(step: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run()
  } catch (error) {
    console.warn(`GeoMetrikks for Chrome: ${step} failed`, error)
  }
}

async function notifyServerChanged(chromeApi: ChromeApi): Promise<void> {
  try {
    await chromeApi.runtime.sendMessage({ type: "serverChanged" })
  } catch {
    // Rejects with "Receiving end does not exist" while no worker listener is up.
  }
}

/** Call it straight from the click handler. It requests the host permission
 *  before its first await, while Chrome still counts the user gesture. */
export async function connect(
  input: { address: string; key: string },
  deps: ConnectDeps,
): Promise<ConnectResult> {
  const normalized = normalizeOrigin(input.address)
  if (!normalized.ok) {
    return {
      ok: false,
      field: "address",
      message: addressError(input.address) ?? NOT_HTTPS_MESSAGE,
    }
  }
  const { origin, pattern } = normalized
  const permissions = { origins: [pattern] }
  // A failed check counts as granted, so the rollback below never removes a
  // permission that may have been working before this attempt.
  const wasGrantedCheck = settle(deps.chrome.permissions.contains(permissions), true)
  const grantRequest = settle(deps.chrome.permissions.request(permissions), false)

  const host = new URL(origin).host
  const wasGranted = await wasGrantedCheck
  const granted = await grantRequest
  if (!granted) {
    return {
      ok: false,
      field: null,
      message: `Chrome didn't get access to ${host}. Click Connect again and choose Allow.`,
    }
  }

  let saved = false
  try {
    const key = input.key.trim() || null
    const verified = await verify(deps, { origin, pattern, key }, host)
    if (!verified.ok) return verified
    const previous = await getConnection(deps.chrome)
    const sameOrigin = previous?.origin === origin
    const generation = sameOrigin ? (previous.generation ?? 0) : await nextGeneration(deps.chrome)
    const stored: StoredConnection = { ...verified.stored, generation }
    await setConnection(stored, deps.chrome)
    saved = true
    if (previous && !sameOrigin) await forgetServer(deps.chrome, previous, pattern)
    return { ok: true, stored }
  } finally {
    if (!saved && !wasGranted)
      await bestEffort("removing the new permission", () =>
        deps.chrome.permissions.remove(permissions),
      )
  }
}

async function verify(
  deps: ConnectDeps,
  target: { origin: string; pattern: string; key: string | null },
  host: string,
): Promise<ConnectResult> {
  const { origin, pattern, key } = target
  let result: Awaited<ReturnType<FetchConnection>>
  try {
    result = await deps.fetchConnection({ origin, key })
  } catch {
    result = { ok: false, failure: { networkError: true } }
  }
  if (!result.ok) return { ok: false, ...failureMessage(result.failure, host, key !== null) }
  const { connection } = result
  if (connection.mode === "disabled" && key !== null)
    return { ok: false, field: "key", message: AUTH_OFF_WITH_KEY_MESSAGE }
  return {
    ok: true,
    stored: {
      origin,
      pattern,
      key,
      keyless: key === null,
      verifiedScope: connection.mode === "apiKey" ? connection.scope : null,
      connection,
      savedAt: (deps.now ?? Date.now)(),
    },
  }
}

/** The new connection is already saved, so a failing step is logged and
 *  skipped instead of turning a working Connect into an error. */
async function forgetServer(
  chromeApi: ChromeApi,
  previous: StoredConnection,
  pattern: string,
): Promise<void> {
  await bestEffort("clearing the old server's data", () => clearLocalServerData(chromeApi))
  if (previous.pattern !== pattern)
    await bestEffort("removing the old server's permission", () =>
      chromeApi.permissions.remove({ origins: [previous.pattern] }),
    )
  await notifyServerChanged(chromeApi)
}

export async function disconnect(deps: { chrome: ChromeApi }): Promise<void> {
  const stored = await getConnection(deps.chrome)
  await nextGeneration(deps.chrome)
  await removeConnection(deps.chrome)
  await clearLocalServerData(deps.chrome)
  if (stored) await deps.chrome.permissions.remove({ origins: [stored.pattern] })
  await notifyServerChanged(deps.chrome)
}

/** Like `connect`, call it straight from the click handler. Another Options
 *  tab may have replaced or removed the connection meanwhile, or the check
 *  may fail; then a grant this click added is taken back. */
export async function grantAccess(deps: {
  chrome: ChromeApi
  stored: StoredConnection
}): Promise<boolean> {
  const permissions = { origins: [deps.stored.pattern] }
  const wasGrantedCheck = settle(deps.chrome.permissions.contains(permissions), true)
  const grantRequest = settle(deps.chrome.permissions.request(permissions), false)
  const wasGranted = await wasGrantedCheck
  if (!(await grantRequest)) return false
  let kept = false
  try {
    const current = await getConnection(deps.chrome)
    kept = current?.pattern === deps.stored.pattern
    return kept
  } finally {
    if (!kept && !wasGranted)
      await bestEffort("removing a grant for a replaced server", () =>
        deps.chrome.permissions.remove(permissions),
      )
  }
}

export interface DisplayedConnection {
  /** As saved at Connect, with the verified key name and scope. */
  stored: StoredConnection | null
  /** `stored` with the latest refresh applied, for versions and features. */
  effective: StoredConnection | null
  hasAccess: boolean
}

export async function loadDisplayed(chromeApi: ChromeApi): Promise<DisplayedConnection> {
  const [stored, refresh] = await Promise.all([
    getConnection(chromeApi),
    getConnectionRefresh(chromeApi),
  ])
  if (!stored) return { stored: null, effective: null, hasAccess: true }
  const hasAccess = await settle(
    chromeApi.permissions.contains({ origins: [stored.pattern] }),
    true,
  )
  return { stored, effective: effectiveConnection(stored, refresh), hasAccess }
}
