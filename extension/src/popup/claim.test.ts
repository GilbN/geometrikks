import { describe, expect, it } from "vite-plus/test"
import { fakeChrome } from "../../tests/fake-chrome"
import type { PendingItem } from "../lib/storage"
import { claimFromWorker } from "./claim"

const A = "https://a.example"

const item: PendingItem = {
  id: "item-1",
  kind: "lookup",
  ip: "45.148.10.82",
  text: "45.148.10.82",
  result: null,
  origin: A,
  windowId: 7,
  createdAt: 1,
  reservedForPage: false,
}

function answering(answer: unknown) {
  const chromeApi = fakeChrome()
  const sent: unknown[] = []
  chromeApi.runtime.sendMessage = async (message) => {
    sent.push(message)
    return answer
  }
  return { chromeApi, sent }
}

describe("claimFromWorker", () => {
  it("claims by window from the toolbar popup", async () => {
    const { chromeApi, sent } = answering(item)
    const ctx = { windowId: 7, tabUrl: undefined, pendingId: null }
    expect(await claimFromWorker(ctx, A, chromeApi)).toEqual(item)
    expect(sent).toEqual([{ type: "claimPending", windowId: 7, origin: A }])
  })

  it("claims by id from the fallback page", async () => {
    const { chromeApi, sent } = answering(null)
    const ctx = { windowId: 7, tabUrl: undefined, pendingId: "item-1" }
    expect(await claimFromWorker(ctx, A, chromeApi)).toBeNull()
    expect(sent).toEqual([{ type: "claimPending", id: "item-1", origin: A }])
  })

  it("ignores an answer for another server or of the wrong shape", async () => {
    const ctx = { windowId: 7, tabUrl: undefined, pendingId: null }
    expect(
      await claimFromWorker(ctx, A, answering({ ...item, origin: "https://b.example" }).chromeApi),
    ).toBeNull()
    expect(await claimFromWorker(ctx, A, answering({ id: 1 }).chromeApi)).toBeNull()
  })
})
