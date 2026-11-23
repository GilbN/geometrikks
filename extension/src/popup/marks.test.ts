import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import type { DropListsResponse } from "@/generated/api/types.gen"
import { fakeChrome } from "../../tests/fake-chrome"
import { createExtensionClient } from "../lib/client"
import type { Access } from "../lib/connection"
import {
  DROP_CACHE_MS,
  getConnection,
  getDropLists,
  setConnection,
  setDropLists,
  type StoredConnection,
} from "../lib/storage"
import { ipMarks, loadDropIndex, withDecisionTypes } from "./marks"

const access: Access = { write: false, crowdsec: true, drop: true, asn: true, hostFilter: true }
const serverA = { origin: "https://a.example.net", savedAt: 1 }
const serverB = { origin: "https://b.example.net", savedAt: 2 }

function storedFor(identity: { origin: string; savedAt: number }): StoredConnection {
  return {
    origin: identity.origin,
    pattern: `${identity.origin}/*`,
    key: null,
    keyless: true,
    verifiedScope: null,
    connection: {
      mode: "disabled",
      appVersion: "0.26.0",
      apiVersion: "1",
      capabilities: [],
    },
    savedAt: identity.savedAt,
  }
}

function connectedChrome(identity: { origin: string; savedAt: number }) {
  return fakeChrome({ local: { connection: storedFor(identity) } })
}

async function identityOf(chromeApi: ReturnType<typeof fakeChrome>) {
  const stored = await getConnection(chromeApi)
  if (!stored) throw new Error("no stored connection")
  return { origin: stored.origin, savedAt: stored.savedAt }
}

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
    const chromeApi = connectedChrome(serverA)
    await setDropLists(serverA, lists("45.148.10.0/24", "SBL1"), chromeApi)
    const index = await loadDropIndex(client, chromeApi, access, serverA)
    expect(requests).toHaveLength(0)
    const marks = await ipMarks(client, ["45.148.10.82"], { ...access, crowdsec: false }, index)
    expect(marks["45.148.10.82"]?.dropSblId).toBe("SBL1")
  })

  it("fetches once and rewrites the cache when it is stale", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-11-18T00:00:00Z"))
    const chromeApi = connectedChrome(serverA)
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
    const chromeApi = connectedChrome(serverA)
    await setDropLists(serverA, lists("45.148.10.0/24", "SBL1"), chromeApi)
    const { client, requests } = server(() => json(lists("10.0.0.0/8", "SBL9")))
    await loadDropIndex(client, chromeApi, access, serverB)
    expect(requests).toHaveLength(1)
  })

  it("keeps a fetch started under A out of the cache when it lands after a switch to B", async () => {
    const chromeApi = fakeChrome()
    await setConnection(storedFor(serverA), chromeApi)
    let release: (response: Response) => void = () => {}
    const { client, requests } = server(
      () => new Promise<Response>((resolve) => (release = resolve)),
    )
    const startedUnder = await identityOf(chromeApi)
    const loading = loadDropIndex(client, chromeApi, access, startedUnder)
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    await setConnection(storedFor(serverB), chromeApi)
    release(json(lists("45.148.10.0/24", "SBL1")))
    expect(await loading).not.toBeNull()
    const now = await identityOf(chromeApi)
    expect(now).toEqual(serverB)
    expect(await getDropLists(now, chromeApi)).toBeNull()
    expect(await getDropLists(serverA, chromeApi)).toBeNull()
  })

  it("keeps the fetched index when the cache can't be read or written", async () => {
    const chromeApi = fakeChrome()
    chromeApi.storage.local.get = () => Promise.reject(new Error("storage broke"))
    chromeApi.storage.local.set = () => Promise.reject(new Error("quota"))
    const { client, requests } = server(() => json(lists("45.148.10.0/24", "SBL1")))
    const index = await loadDropIndex(client, chromeApi, access, serverA)
    expect(requests).toHaveLength(1)
    const marks = await ipMarks(client, ["45.148.10.82"], { ...access, crowdsec: false }, index)
    expect(marks["45.148.10.82"]?.dropSblId).toBe("SBL1")
  })

  it("resolves to null when /drop/lists fails or throws", async () => {
    const failing = server(() => json({ status_code: 503, detail: "down", code: "x" }, 503))
    expect(await loadDropIndex(failing.client, fakeChrome(), access, serverA)).toBeNull()
    const throwing = server(() => Promise.reject(new TypeError("Failed to fetch")))
    expect(await loadDropIndex(throwing.client, fakeChrome(), access, serverA)).toBeNull()
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
    const chromeApi = connectedChrome(serverA)
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

describe("withDecisionTypes", () => {
  it("lays a confirmed decision type over the mark and keeps its DROP match", () => {
    const marks = {
      "45.148.10.82": { decisionType: null, dropSblId: "SBL1" },
      "185.224.128.17": { decisionType: "ban", dropSblId: null },
    }
    expect(withDecisionTypes(marks, { "45.148.10.82": "ban", "185.224.128.17": null })).toEqual({
      "45.148.10.82": { decisionType: "ban", dropSblId: "SBL1" },
      "185.224.128.17": { decisionType: null, dropSblId: null },
    })
  })
})
