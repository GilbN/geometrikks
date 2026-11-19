import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import type { DropListsResponse } from "@/generated/api/types.gen"
import { fakeChrome } from "../../tests/fake-chrome"
import { createExtensionClient } from "../lib/client"
import type { Access } from "../lib/connection"
import { DROP_CACHE_MS, getDropLists, setDropLists } from "../lib/storage"
import { ipMarks, loadDropIndex } from "./marks"

const access: Access = { write: false, crowdsec: true, drop: true, asn: true, hostFilter: true }
const serverA = { origin: "https://a.example.net", savedAt: 1 }
const serverB = { origin: "https://b.example.net", savedAt: 2 }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function lists(cidr: string, sblId: string): DropListsResponse {
  return {
    enabled: true,
    loaded: true,
    stale: false,
    updatedAt: null,
    copyright: null,
    feeds: [],
    asns: [],
    networks: [{ cidr, sblId }],
  }
}

function server(answer: (url: URL) => Response | Promise<Response>) {
  const requests: URL[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url)
    requests.push(url)
    return answer(url)
  }
  const client = createExtensionClient(
    { origin: "https://a.example.net", key: null },
    { fetch: fetchImpl as typeof fetch },
  )
  return { client, requests }
}

afterEach(() => {
  vi.useRealTimers()
})

describe("loadDropIndex", () => {
  it("returns null without DROP and makes no call", async () => {
    const { client, requests } = server(() => json(lists("45.148.10.0/24", "SBL1")))
    const chromeApi = fakeChrome()
    expect(await loadDropIndex(client, chromeApi, { ...access, drop: false }, serverA)).toBeNull()
    expect(requests).toHaveLength(0)
  })

  it("builds the index from a fresh cache without a call", async () => {
    const { client, requests } = server(() => json(lists("10.0.0.0/8", "SBL9")))
    const chromeApi = fakeChrome()
    await setDropLists(serverA, lists("45.148.10.0/24", "SBL1"), chromeApi)
    const index = await loadDropIndex(client, chromeApi, access, serverA)
    expect(requests).toHaveLength(0)
    const marks = await ipMarks(client, ["45.148.10.82"], { ...access, crowdsec: false }, index)
    expect(marks["45.148.10.82"]?.dropSblId).toBe("SBL1")
  })

  it("fetches once and rewrites the cache when it is stale", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-11-18T00:00:00Z"))
    const chromeApi = fakeChrome()
    await setDropLists(serverA, lists("45.148.10.0/24", "SBL1"), chromeApi)
    vi.setSystemTime(Date.now() + DROP_CACHE_MS + 1)
    const { client, requests } = server(() => json(lists("185.224.128.0/24", "SBL2")))
    const index = await loadDropIndex(client, chromeApi, access, serverA)
    expect(requests.map((url) => url.pathname)).toEqual(["/api/v1/drop/lists"])
    expect((await getDropLists(serverA, chromeApi))?.networks[0]?.sblId).toBe("SBL2")
    const marks = await ipMarks(client, ["185.224.128.17"], { ...access, crowdsec: false }, index)
    expect(marks["185.224.128.17"]?.dropSblId).toBe("SBL2")
  })

  it("treats server A's cache as a miss for server B", async () => {
    const chromeApi = fakeChrome()
    await setDropLists(serverA, lists("45.148.10.0/24", "SBL1"), chromeApi)
    const { client, requests } = server(() => json(lists("10.0.0.0/8", "SBL9")))
    await loadDropIndex(client, chromeApi, access, serverB)
    expect(requests).toHaveLength(1)
  })

  it("tags a fetch started under A with A even when it lands after a switch to B", async () => {
    const chromeApi = fakeChrome()
    let release: (response: Response) => void = () => {}
    const { client, requests } = server(
      () => new Promise<Response>((resolve) => (release = resolve)),
    )
    const loading = loadDropIndex(client, chromeApi, access, serverA)
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    // Options switches to B here; the late answer still belongs to A.
    release(json(lists("45.148.10.0/24", "SBL1")))
    await loading
    expect(await getDropLists(serverB, chromeApi)).toBeNull()
    expect(await getDropLists(serverA, chromeApi)).not.toBeNull()
  })
})

describe("ipMarks", () => {
  const decision = (type: string) => ({
    id: 1,
    ip: "45.148.10.82",
    scope: "Ip",
    type,
    scenario: "manual",
    duration: "3h",
    origin: "cscli",
    city: null,
    countryCode: null,
    countryName: null,
    requestCount24h: null,
  })

  it("makes no CrowdSec calls without crowdsec", async () => {
    const { client, requests } = server(() => json([decision("ban")]))
    const marks = await ipMarks(client, ["45.148.10.82"], { ...access, crowdsec: false }, null)
    expect(requests).toHaveLength(0)
    expect(marks["45.148.10.82"]).toEqual({ decisionType: null, dropSblId: null })
  })

  it("matches no DROP network without drop", async () => {
    const { client } = server(() => json([]))
    const chromeApi = fakeChrome()
    await setDropLists(serverA, lists("45.148.10.0/24", "SBL1"), chromeApi)
    const index = await loadDropIndex(client, chromeApi, access, serverA)
    const marks = await ipMarks(client, ["45.148.10.82"], { ...access, drop: false }, index)
    expect(marks["45.148.10.82"]?.dropSblId).toBeNull()
  })

  it("leaves an IP unmarked when its lookup fails", async () => {
    const { client, requests } = server((url) =>
      url.searchParams.get("ip") === "1.1.1.1"
        ? json({ status_code: 503, detail: "LAPI down", code: "crowdsec_unavailable" }, 503)
        : json([decision("ban")]),
    )
    const marks = await ipMarks(client, ["1.1.1.1", "45.148.10.82"], access, null)
    expect(requests.map((url) => url.pathname)).toEqual([
      "/api/v1/crowdsec/decisions/lookup",
      "/api/v1/crowdsec/decisions/lookup",
    ])
    expect(marks["1.1.1.1"]?.decisionType).toBeNull()
    expect(marks["45.148.10.82"]?.decisionType).toBe("ban")
  })

  it("leaves an IP unmarked when the request throws", async () => {
    const { client } = server(() => Promise.reject(new TypeError("Failed to fetch")))
    const marks = await ipMarks(client, ["45.148.10.82"], access, null)
    expect(marks["45.148.10.82"]?.decisionType).toBeNull()
  })

  it("reports a captcha decision as captcha", async () => {
    const { client } = server(() => json([decision("captcha")]))
    const marks = await ipMarks(client, ["45.148.10.82"], access, null)
    expect(marks["45.148.10.82"]?.decisionType).toBe("captcha")
  })
})
