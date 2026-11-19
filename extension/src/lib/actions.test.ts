import { describe, expect, it } from "vite-plus/test"
import { BAN_DURATIONS } from "@/lib/crowdsec"
import { banIp, unbanIp } from "./actions"
import { createExtensionClient } from "./client"

const target = { origin: "https://geo.example.net", key: "gmk_secret" }

function clientAnswering(answer: () => Response) {
  const requests: Request[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input, init))
    return answer()
  }
  return { requests, client: createExtensionClient(target, { fetch: fetchImpl as typeof fetch }) }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

const day = BAN_DURATIONS.find((duration) => duration.value === "24h")!
const forever = BAN_DURATIONS.find((duration) => duration.label === "Forever")!

describe("banIp", () => {
  it("posts the IP and duration and takes an empty 204 as success", async () => {
    const { requests, client } = clientAnswering(() => new Response(null, { status: 204 }))
    const result = await banIp(client, "45.148.10.82", day)
    expect(requests[0]?.method).toBe("POST")
    expect(new URL(requests[0]!.url).pathname).toBe("/api/v1/crowdsec/ban")
    expect(await requests[0]?.json()).toEqual({ ip: "45.148.10.82", duration: "24h" })
    expect(result).toEqual({
      ok: true,
      ip: "45.148.10.82",
      durationLabel: "24 hours",
      message: "Banned 45.148.10.82 for 24 hours",
    })
  })

  it("says for good for Forever", async () => {
    const { client } = clientAnswering(() => new Response(null, { status: 204 }))
    expect((await banIp(client, "45.148.10.82", forever)).message).toBe(
      "Banned 45.148.10.82 for good",
    )
  })

  it("shows the server's detail on failure", async () => {
    const { client } = clientAnswering(() =>
      json(
        { status_code: 503, code: "crowdsec_unavailable", detail: "CrowdSec LAPI is unreachable" },
        503,
      ),
    )
    expect(await banIp(client, "45.148.10.82", day)).toMatchObject({
      ok: false,
      message: "CrowdSec LAPI is unreachable",
    })
  })
})

describe("unbanIp", () => {
  it("reports what it deleted", async () => {
    const { requests, client } = clientAnswering(() => json({ deleted: 2 }))
    expect(await unbanIp(client, "45.148.10.82")).toEqual({
      ok: true,
      deleted: 2,
      message: "Unbanned 45.148.10.82",
    })
    expect(await requests[0]?.json()).toEqual({ ip: "45.148.10.82" })
  })

  it("fails when nothing was deleted", async () => {
    const { client } = clientAnswering(() => json({ deleted: 0 }))
    expect(await unbanIp(client, "45.148.10.82")).toMatchObject({ ok: false, deleted: 0 })
  })

  it("fails with the server's detail", async () => {
    const { client } = clientAnswering(() =>
      json({ status_code: 403, code: "forbidden", detail: "Needs a Read/write API key." }, 403),
    )
    expect(await unbanIp(client, "45.148.10.82")).toEqual({
      ok: false,
      deleted: 0,
      message: "Needs a Read/write API key.",
    })
  })
})
