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
  it("treats an empty 204 as success", () => {
    expect(unwrap({ data: {}, response: new Response(null, { status: 204 }) })).toEqual({
      ok: true,
      data: {},
    })
  })
})
