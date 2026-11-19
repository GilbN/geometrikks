import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { apiV1AnalyticsTimeSeriesGetTimeSeries } from "@/generated/api/sdk.gen"
import { createExtensionClient, fetchConnection, unwrap } from "./client"

const target = { origin: "https://geo.example.net", key: "gmk_secret" }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function recordingFetch(answer: (request: Request) => Response | Promise<Response>) {
  const requests: Request[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    requests.push(request)
    return answer(request)
  }
  return { requests, fetch: fetchImpl as typeof fetch }
}

const apiKeyBody = {
  mode: "apiKey",
  name: "laptop",
  scope: "read",
  expiresAt: null,
  appVersion: "0.26.0",
  apiVersion: "1",
  capabilities: ["crowdsec"],
}

afterEach(() => {
  vi.useRealTimers()
})

describe("createExtensionClient", () => {
  it("sends the key, omits cookies, refuses redirects and sets a signal on every request", async () => {
    const recorder = recordingFetch(() => json(apiKeyBody))
    await fetchConnection(target, { fetch: recorder.fetch })
    const client = createExtensionClient(target, { fetch: recorder.fetch })
    await apiV1AnalyticsTimeSeriesGetTimeSeries({ client, query: { hostIn: ["a.example"] } })
    expect(recorder.requests).toHaveLength(2)
    for (const request of recorder.requests) {
      expect(request.url.startsWith("https://geo.example.net/api/v1/")).toBe(true)
      expect(request.headers.get("Authorization")).toBe("Bearer gmk_secret")
      expect(request.credentials).toBe("omit")
      expect(request.redirect).toBe("error")
      expect(request.signal).toBeInstanceOf(AbortSignal)
      expect(request.signal.aborted).toBe(false)
    }
  })

  it("sends no Authorization header without a key", async () => {
    const recorder = recordingFetch(() => json({ ...apiKeyBody, mode: "disabled" }))
    await fetchConnection({ origin: target.origin, key: null }, { fetch: recorder.fetch })
    expect(recorder.requests[0]?.headers.has("Authorization")).toBe(false)
  })

  it("gives each request its own timeout, so a later one isn't born aborted", async () => {
    vi.useFakeTimers()
    const timeoutSignal = (ms: number) => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), ms)
      return controller.signal
    }
    const recorder = recordingFetch(() => json([]))
    const client = createExtensionClient(target, { fetch: recorder.fetch, timeoutSignal })
    await apiV1AnalyticsTimeSeriesGetTimeSeries({ client })
    vi.advanceTimersByTime(11_000)
    await apiV1AnalyticsTimeSeriesGetTimeSeries({ client })
    const [first, second] = recorder.requests
    expect(first?.signal.aborted).toBe(true)
    expect(second?.signal.aborted).toBe(false)
  })

  it("aborts the request when the caller's signal aborts", async () => {
    const recorder = recordingFetch(() => json([]))
    const client = createExtensionClient(target, { fetch: recorder.fetch })
    const controller = new AbortController()
    await apiV1AnalyticsTimeSeriesGetTimeSeries({ client, signal: controller.signal })
    expect(recorder.requests[0]?.signal.aborted).toBe(false)
    controller.abort()
    expect(recorder.requests[0]?.signal.aborted).toBe(true)
  })
})

describe("fetchConnection", () => {
  it("returns the connection", async () => {
    const recorder = recordingFetch(() => json(apiKeyBody))
    expect(await fetchConnection(target, { fetch: recorder.fetch })).toEqual({
      ok: true,
      connection: apiKeyBody,
    })
  })

  it("reports a coded 401", async () => {
    const recorder = recordingFetch(() =>
      json(
        { status_code: 401, code: "api_key_invalid", detail: "That API key is not valid." },
        401,
      ),
    )
    expect(await fetchConnection(target, { fetch: recorder.fetch })).toEqual({
      ok: false,
      failure: { status: 401, code: "api_key_invalid", detail: "That API key is not valid." },
    })
  })

  it("calls a login page answered with 200 not GeoMetrikks JSON", async () => {
    const recorder = recordingFetch(
      () => new Response("<html>Sign in</html>", { headers: { "Content-Type": "text/html" } }),
    )
    expect(await fetchConnection(target, { fetch: recorder.fetch })).toEqual({
      ok: false,
      failure: { status: 200, notJson: true },
    })
  })

  it("calls a 401 page from a proxy not GeoMetrikks JSON", async () => {
    const recorder = recordingFetch(
      () =>
        new Response("Unauthorized", { status: 401, headers: { "Content-Type": "text/plain" } }),
    )
    expect(await fetchConnection(target, { fetch: recorder.fetch })).toEqual({
      ok: false,
      failure: { status: 401, notJson: true },
    })
  })

  it("refuses JSON that isn't a connection answer, a session answer included", async () => {
    for (const body of [{ hello: "world" }, { ...apiKeyBody, mode: "session" }, []]) {
      const recorder = recordingFetch(() => json(body))
      expect(await fetchConnection(target, { fetch: recorder.fetch })).toEqual({
        ok: false,
        failure: { status: 200, notJson: true },
      })
    }
  })

  it("refuses an apiKey answer without a valid scope, name or expiry", async () => {
    const { scope: _scope, ...noScope } = apiKeyBody
    const { expiresAt: _expiresAt, ...noExpiry } = apiKeyBody
    for (const body of [
      noScope,
      noExpiry,
      { ...apiKeyBody, scope: "admin" },
      { ...apiKeyBody, name: 7 },
      { ...apiKeyBody, expiresAt: 0 },
      { ...apiKeyBody, expiresAt: "tomorrow-ish" },
    ]) {
      const recorder = recordingFetch(() => json(body))
      expect(await fetchConnection(target, { fetch: recorder.fetch })).toEqual({
        ok: false,
        failure: { status: 200, notJson: true },
      })
    }
  })

  it("accepts an apiKey answer with a dated expiry", async () => {
    const body = { ...apiKeyBody, expiresAt: "2027-01-01T00:00:00Z" }
    const recorder = recordingFetch(() => json(body))
    expect(await fetchConnection(target, { fetch: recorder.fetch })).toEqual({
      ok: true,
      connection: body,
    })
  })

  it("reports network errors and timeouts", async () => {
    const offline = recordingFetch(() => {
      throw new TypeError("Failed to fetch")
    })
    expect(await fetchConnection(target, { fetch: offline.fetch })).toEqual({
      ok: false,
      failure: { networkError: true },
    })
    const slow = recordingFetch(() => {
      throw new DOMException("The operation timed out.", "TimeoutError")
    })
    expect(await fetchConnection(target, { fetch: slow.fetch })).toEqual({
      ok: false,
      failure: { timedOut: true },
    })
  })
})

describe("unwrap", () => {
  it("fails a 200 whose JSON body doesn't parse", async () => {
    const recorder = recordingFetch(
      () => new Response("{not json", { headers: { "Content-Type": "application/json" } }),
    )
    const client = createExtensionClient(target, { fetch: recorder.fetch })
    expect(unwrap(await apiV1AnalyticsTimeSeriesGetTimeSeries({ client }))).toEqual({
      ok: false,
      failure: { status: 200, notJson: true },
    })
  })

  it("reports a timeout while reading the body as timed out", async () => {
    const recorder = recordingFetch(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("[1,"))
              controller.error(new DOMException("The operation timed out.", "TimeoutError"))
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    )
    const client = createExtensionClient(target, { fetch: recorder.fetch })
    expect(unwrap(await apiV1AnalyticsTimeSeriesGetTimeSeries({ client }))).toEqual({
      ok: false,
      failure: { timedOut: true },
    })
  })

  it.each([
    ["without", {}],
    ["with", { "Content-Length": "0" }],
  ])("fails an empty 200 JSON body %s Content-Length: 0", async (_label, headers) => {
    const recorder = recordingFetch(
      () => new Response("", { headers: { "Content-Type": "application/json", ...headers } }),
    )
    const client = createExtensionClient(target, { fetch: recorder.fetch })
    expect(unwrap(await apiV1AnalyticsTimeSeriesGetTimeSeries({ client }))).toEqual({
      ok: false,
      failure: { status: 200, notJson: true },
    })
  })

  it("treats an empty JSON 204 from the server as success", async () => {
    const recorder = recordingFetch(
      () => new Response(null, { status: 204, headers: { "Content-Type": "application/json" } }),
    )
    const client = createExtensionClient(target, { fetch: recorder.fetch })
    expect(unwrap(await apiV1AnalyticsTimeSeriesGetTimeSeries({ client }))).toEqual({
      ok: true,
      data: {},
    })
  })

  it("treats an empty 204 as success", () => {
    expect(unwrap({ data: {}, response: new Response(null, { status: 204 }) })).toEqual({
      ok: true,
      data: {},
    })
  })
})
