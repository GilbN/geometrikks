import type { ChromeApi } from "../lib/chrome-api"
import type { ClientTarget } from "../lib/client"
import type { FailureInput } from "../lib/failures"
import { normalizeOrigin } from "../lib/origin"
import {
  clearLocalServerData,
  getConnection,
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
  if (failure.code === "not_authenticated" && !keyed)
    return { field: "key", message: "This server needs an API key." }
  const keyField = failure.code === "api_key_invalid" || failure.code === "api_key_expired"
  if (failure.detail) return { field: keyField ? "key" : null, message: failure.detail }
  return { field: null, message: `${host} answered with status ${failure.status ?? "unknown"}.` }
}

async function settle(promise: Promise<boolean>): Promise<boolean> {
  try {
    return await promise
  } catch {
    return false
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
  const wasGrantedCheck = settle(deps.chrome.permissions.contains(permissions))
  const grantRequest = settle(deps.chrome.permissions.request(permissions))

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

  const rollBack = async () => {
    if (!wasGranted) await deps.chrome.permissions.remove(permissions)
  }

  const key = input.key.trim() || null
  let result: Awaited<ReturnType<FetchConnection>>
  try {
    result = await deps.fetchConnection({ origin, key })
  } catch {
    result = { ok: false, failure: { networkError: true } }
  }
  if (!result.ok) {
    await rollBack()
    return { ok: false, ...failureMessage(result.failure, host, key !== null) }
  }
  const { connection } = result
  if (connection.mode === "disabled" && key !== null) {
    await rollBack()
    return { ok: false, field: "key", message: AUTH_OFF_WITH_KEY_MESSAGE }
  }

  const previous = await getConnection(deps.chrome)
  const stored: StoredConnection = {
    origin,
    pattern,
    key,
    keyless: key === null,
    verifiedScope: connection.mode === "apiKey" ? connection.scope : null,
    connection,
    savedAt: (deps.now ?? Date.now)(),
  }
  await setConnection(stored, deps.chrome)
  if (previous && previous.origin !== origin) {
    await clearLocalServerData(deps.chrome)
    if (previous.pattern !== pattern)
      await deps.chrome.permissions.remove({ origins: [previous.pattern] })
    await notifyServerChanged(deps.chrome)
  }
  return { ok: true, stored }
}

export async function disconnect(deps: { chrome: ChromeApi }): Promise<void> {
  const stored = await getConnection(deps.chrome)
  await removeConnection(deps.chrome)
  await clearLocalServerData(deps.chrome)
  if (stored) await deps.chrome.permissions.remove({ origins: [stored.pattern] })
  await notifyServerChanged(deps.chrome)
}

/** Like `connect`, call it straight from the click handler. */
export async function grantAccess(deps: {
  chrome: ChromeApi
  stored: StoredConnection
}): Promise<boolean> {
  return settle(deps.chrome.permissions.request({ origins: [deps.stored.pattern] }))
}
