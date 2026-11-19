import { createClient, createConfig, type Client } from "@/generated/api/client"
import { apiV1AuthConnectionConnection } from "@/generated/api/sdk.gen"
import type { FailureInput } from "./failures"
import type { ConnectionResponse } from "./storage"

export type ExtensionClient = Client

export const REQUEST_TIMEOUT_MS = 10_000

export interface ClientTarget {
  origin: string
  key: string | null
}

export interface ClientDeps {
  fetch?: typeof fetch
  timeoutSignal?: (ms: number) => AbortSignal
}

// The SDK hands back `{}` for an empty 2xx JSON body, which would pass as data.
const emptyJsonBodies = new WeakSet<Response>()

/** Empty once decoded, with a byte order mark and whitespace trimmed. */
async function hasEmptyBody(response: Response): Promise<boolean> {
  const body = response.clone().body
  if (!body) return true
  const reader = body.getReader()
  const decoder = new TextDecoder()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return decoder.decode().trim() === ""
      if (decoder.decode(value, { stream: true }).trim() !== "") return false
    }
  } catch {
    return false
  } finally {
    reader.cancel().catch(() => {})
  }
}

export function createExtensionClient(target: ClientTarget, deps: ClientDeps = {}): Client {
  const baseFetch = deps.fetch ?? globalThis.fetch
  const timeoutSignal = deps.timeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms))
  // A signal per request: one shared signal would expire 10 s after the
  // client was made and fail every later request.
  const guardedFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : null)
    const timeout = timeoutSignal(REQUEST_TIMEOUT_MS)
    const response = await baseFetch(
      new Request(input, {
        ...init,
        credentials: "omit",
        redirect: "error",
        signal: callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout,
      }),
    )
    if (
      response.ok &&
      response.status !== 204 &&
      isJson(response) &&
      (await hasEmptyBody(response))
    )
      emptyJsonBodies.add(response)
    return response
  }
  return createClient(
    createConfig({
      baseUrl: target.origin,
      credentials: "omit",
      redirect: "error",
      headers: target.key ? { Authorization: `Bearer ${target.key}` } : undefined,
      fetch: guardedFetch as typeof fetch,
    }),
  )
}

export type Unwrapped<T> = { ok: true; data: T } | { ok: false; failure: FailureInput }

function isJson(response: Response): boolean {
  const type = response.headers.get("Content-Type") ?? ""
  return /^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i.test(type)
}

function isTimeout(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  )
}

/** Turns a generated SDK result into data or a failure. A body that isn't
 *  JSON (a proxy's login page, say), is empty or couldn't be read is a
 *  failure even with a 200; an empty 204 is success. */
export function unwrap<T>(result: {
  data?: unknown
  error?: unknown
  response?: Response
}): Unwrapped<T> {
  const { response, error } = result
  if (!response) {
    return {
      ok: false,
      failure: isTimeout(error) ? { timedOut: true } : { networkError: true },
    }
  }
  // The SDK also sets `error` after the headers arrived: a body that failed
  // to parse as JSON, or a timeout while reading it.
  const bodyFailed = response.ok ? error !== undefined : error instanceof Error
  if (bodyFailed) {
    return {
      ok: false,
      failure: isTimeout(error) ? { timedOut: true } : { status: response.status, notJson: true },
    }
  }
  if (!response.ok) {
    const envelope =
      isJson(response) && typeof error === "object" && error !== null
        ? (error as { code?: unknown; detail?: unknown })
        : null
    return {
      ok: false,
      failure: {
        status: response.status,
        ...(envelope ? {} : { notJson: true }),
        ...(typeof envelope?.code === "string" ? { code: envelope.code } : {}),
        ...(typeof envelope?.detail === "string" ? { detail: envelope.detail } : {}),
      },
    }
  }
  if (response.status !== 204 && (!isJson(response) || emptyJsonBodies.has(response))) {
    return { ok: false, failure: { status: response.status, notJson: true } }
  }
  return { ok: true, data: result.data as T }
}

const ISO_DATE =
  /^(\d{4})-(\d{2})-(\d{2})([Tt]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?([Zz]|[+-]\d{2}:?\d{2})?$/

function offsetMinutes(zone: string): number {
  if (zone.toUpperCase() === "Z") return 0
  const digits = zone.slice(1).replace(":", "")
  const minutes = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))
  return zone.startsWith("-") ? -minutes : minutes
}

/** Date.parse rolls an impossible day such as 2026-02-30 over into March,
 *  so the parsed date has to give back the calendar date that was sent. */
function isRealDate(value: string): boolean {
  const parsed = Date.parse(value)
  const match = ISO_DATE.exec(value)
  if (Number.isNaN(parsed) || !match) return false
  const [, year, month, day, time, zone] = match
  const offset =
    zone !== undefined
      ? offsetMinutes(zone)
      : time !== undefined
        ? -new Date(parsed).getTimezoneOffset()
        : 0
  const wall = new Date(parsed + offset * 60_000)
  return (
    wall.getUTCFullYear() === Number(year) &&
    wall.getUTCMonth() + 1 === Number(month) &&
    wall.getUTCDate() === Number(day)
  )
}

function isConnectionResponse(value: unknown): value is ConnectionResponse {
  if (typeof value !== "object" || value === null) return false
  const body = value as Record<string, unknown>
  if (
    body.mode === "apiKey" &&
    !(
      (body.scope === "read" || body.scope === "read_write") &&
      typeof body.name === "string" &&
      (body.expiresAt === null ||
        (typeof body.expiresAt === "string" && isRealDate(body.expiresAt)))
    )
  )
    return false
  return (
    (body.mode === "apiKey" || body.mode === "disabled") &&
    typeof body.appVersion === "string" &&
    typeof body.apiVersion === "string" &&
    Array.isArray(body.capabilities)
  )
}

/** `GET /auth/connection`. Credentials are omitted, so a `session` answer
 *  can't be GeoMetrikks talking to this extension and counts as not its JSON. */
export async function fetchConnection(
  target: ClientTarget,
  deps: ClientDeps = {},
): Promise<{ ok: true; connection: ConnectionResponse } | { ok: false; failure: FailureInput }> {
  const client = createExtensionClient(target, deps)
  const result = unwrap<unknown>(await apiV1AuthConnectionConnection({ client }))
  if (!result.ok) return result
  if (!isConnectionResponse(result.data))
    return { ok: false, failure: { status: 200, notJson: true } }
  return { ok: true, connection: result.data }
}
