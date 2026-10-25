import { afterEach, describe, expect, it, vi } from "vitest"
import { client } from "@/generated/api/client.gen"
import axios from "axios"
import { api, deleteServerLocation, fetchHealth, fetchCrowdsecAlertScenarios, fetchCrowdsecAlerts } from "./api"

afterEach(() => vi.restoreAllMocks())

function sentParams(get: ReturnType<typeof vi.spyOn>, call: number): Record<string, unknown> {
  const config = get.mock.calls[call][1] as { params: Record<string, unknown> }
  return config.params
}

describe("fetchCrowdsecAlerts", () => {
  it("sends hasActiveDecision as given: true, false, or not at all", async () => {
    const get = vi.spyOn(api, "get").mockResolvedValue({ data: { alerts: [], nextCursor: null } })
    await fetchCrowdsecAlerts({ hasActiveDecision: true })
    await fetchCrowdsecAlerts({ hasActiveDecision: false })
    await fetchCrowdsecAlerts({})
    expect(sentParams(get, 0).hasActiveDecision).toBe(true)
    expect(sentParams(get, 1).hasActiveDecision).toBe(false)
    expect(sentParams(get, 2).hasActiveDecision).toBeUndefined()
  })

  it("only sends a kind when one is chosen", async () => {
    const get = vi.spyOn(api, "get").mockResolvedValue({ data: { alerts: [], nextCursor: null } })
    await fetchCrowdsecAlerts({ kind: "bot-detection" })
    await fetchCrowdsecAlerts({})
    expect(sentParams(get, 0).kind).toBe("bot-detection")
    expect(sentParams(get, 1).kind).toBeUndefined()
  })

  it("passes the cursor and scenarios through, and leaves them out when unset", async () => {
    const get = vi.spyOn(api, "get").mockResolvedValue({ data: { alerts: [], nextCursor: null } })
    const scenarios = ["crowdsecurity/ssh-bf", "crowdsecurity/http-probing"]
    await fetchCrowdsecAlerts({ before: "cursor-1", scenarios })
    await fetchCrowdsecAlerts({ scenarios: [] })
    expect(sentParams(get, 0)).toMatchObject({ before: "cursor-1", scenario: scenarios })
    expect(sentParams(get, 1).before).toBeUndefined()
    expect(sentParams(get, 1).scenario).toBeUndefined()
  })

  it("repeats the scenario key for each scenario", () => {
    const query = api.getUri({ url: "/crowdsec/alerts", params: { scenario: ["a/b", "c/d"] } })
    expect(query).toContain("scenario=a%2Fb&scenario=c%2Fd")
  })

  it("returns the page envelope", async () => {
    const page = { alerts: [], nextCursor: "next" }
    vi.spyOn(api, "get").mockResolvedValue({ data: page })
    await expect(fetchCrowdsecAlerts({})).resolves.toEqual(page)
  })
})

describe("fetchCrowdsecAlertScenarios", () => {
  it("asks for the window and kind, leaving an unset kind out", async () => {
    const get = vi.spyOn(api, "get").mockResolvedValue({ data: [] })
    await fetchCrowdsecAlertScenarios({ since: "24h", kind: "waf" })
    await fetchCrowdsecAlertScenarios({ since: "168h" })
    expect(get.mock.calls[0][0]).toBe("/crowdsec/alerts/scenarios")
    expect(sentParams(get, 0)).toEqual({ since: "24h", kind: "waf" })
    expect(sentParams(get, 1)).toEqual({ since: "168h", kind: undefined })
  })
})

describe("deleteServerLocation", () => {
  afterEach(() => {
    client.setConfig({ baseUrl: "" })
    vi.unstubAllGlobals()
  })

  it("encodes the server name as one path segment", async () => {
    client.setConfig({ baseUrl: "http://geometrikks.test" })
    const fetch = vi.fn(async (_request: Request) => new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", fetch)
    await deleteServerLocation("edge 01")
    await deleteServerLocation("nas.lan")
    const sent = fetch.mock.calls.map(([request]) => [request.method, new URL(request.url).pathname])
    expect(sent).toEqual([
      ["DELETE", "/api/v1/geo-locations/server-locations/edge%2001"],
      ["DELETE", "/api/v1/geo-locations/server-locations/nas.lan"],
    ])
  })
})

describe("fetchHealth", () => {
  it("passes the request config through, so a caller can bound the wait", async () => {
    const get = vi.spyOn(axios, "get").mockResolvedValue({ data: { status: "healthy" } })
    await fetchHealth({ timeout: 3000 })
    expect(get).toHaveBeenCalledExactlyOnceWith("/health", { timeout: 3000 })
  })
})
