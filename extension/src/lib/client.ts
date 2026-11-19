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

export function createExtensionClient(target: ClientTarget, deps: ClientDeps = {}): Client {
  const baseFetch = deps.fetch ?? globalThis.fetch
  const timeoutSignal = deps.timeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms))
  // A signal per request: one shared signal would expire 10 s after the
  // client was made and fail every later request.
  const guardedFetch = (input: RequestInfo | URL, init?: RequestInit) =>
    baseFetch(
      new Request(input, {
        ...init,
        credentials: "omit",
        redirect: "error",
        signal: timeoutSignal(REQUEST_TIMEOUT_MS),
      }),
    )
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
 *  JSON (a proxy's login page, say) is a failure even with a 200; an empty
 *  204 is success. */
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
  if (response.status !== 204 && !isJson(response)) {
    return { ok: false, failure: { status: response.status, notJson: true } }
  }
  return { ok: true, data: result.data as T }
}

function isConnectionResponse(value: unknown): value is ConnectionResponse {
  if (typeof value !== "object" || value === null) return false
  const body = value as Record<string, unknown>
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
