import { describe, expect, it } from "vite-plus/test"
import { createSerialQueue, selectById, selectForPopup } from "./pending"
import type { PendingItem } from "./storage"

const A = "https://a.example"
const now = 1_000_000

function item(overrides: Partial<PendingItem>): PendingItem {
  return {
    id: "x",
    kind: "lookup",
    ip: "45.148.10.82",
    text: "45.148.10.82",
    result: null,
    origin: A,
    windowId: 1,
    createdAt: now - 1000,
    reservedForPage: false,
    ...overrides,
  }
}

describe("selectForPopup", () => {
  const where = { windowId: 1, origin: A, now }

  it("takes the newest live item for this window and server", () => {
    const items = [
      item({ id: "old", createdAt: now - 5000 }),
      item({ id: "new", createdAt: now - 10 }),
    ]
    expect(selectForPopup(items, where)?.id).toBe("new")
  })

  it("skips reserved items, other windows, other servers and items over 2 minutes old", () => {
    const items = [
      item({ id: "reserved", reservedForPage: true }),
      item({ id: "other-window", windowId: 2 }),
      item({ id: "other-origin", origin: "https://b.example" }),
      item({ id: "stale", createdAt: now - 3 * 60_000 }),
    ]
    expect(selectForPopup(items, where)).toBeNull()
  })
})

describe("selectById", () => {
  it("finds a reserved item by id for the page", () => {
    const items = [item({ id: "a", reservedForPage: true })]
    expect(selectById(items, { id: "a", origin: A, now })?.id).toBe("a")
  })

  it("is null for another server, a stale item or no match", () => {
    expect(
      selectById([item({ id: "a" })], { id: "a", origin: "https://b.example", now }),
    ).toBeNull()
    expect(
      selectById([item({ id: "a", createdAt: now - 3 * 60_000 })], { id: "a", origin: A, now }),
    ).toBeNull()
    expect(selectById([item({ id: "a" })], { id: "b", origin: A, now })).toBeNull()
  })
})

describe("createSerialQueue", () => {
  it("runs overlapping jobs one at a time, in order", async () => {
    const enqueue = createSerialQueue()
    const log: string[] = []
    const job = (name: string, ms: number) => async () => {
      log.push(`start ${name}`)
      await new Promise((resolve) => setTimeout(resolve, ms))
      log.push(`end ${name}`)
      return name
    }
    const results = await Promise.all([
      enqueue(job("a", 20)),
      enqueue(job("b", 1)),
      enqueue(job("c", 5)),
    ])
    expect(results).toEqual(["a", "b", "c"])
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"])
  })

  it("keeps going after a job fails", async () => {
    const enqueue = createSerialQueue()
    const failed = enqueue(async () => {
      throw new Error("boom")
    })
    const next = enqueue(async () => "ok")
    await expect(failed).rejects.toThrow("boom")
    await expect(next).resolves.toBe("ok")
  })
})
