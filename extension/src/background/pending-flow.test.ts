import { describe, expect, it } from "vite-plus/test"
import { A, B, storedFor, testDeps, type TestDeps } from "../../tests/worker-deps"
import type { PendingItem } from "../lib/storage"
import {
  claimPending,
  claimRequestFrom,
  clearPending,
  deliverPending,
  enqueuePending,
  refreshFrom,
} from "./pending-flow"

function item(deps: TestDeps, overrides: Partial<PendingItem> = {}): PendingItem {
  return {
    id: deps.newId(),
    kind: "lookup",
    ip: "45.148.10.82",
    text: "45.148.10.82",
    result: null,
    origin: A,
    windowId: 7,
    createdAt: deps.now(),
    reservedForPage: false,
    ...overrides,
  }
}

const pending = (deps: TestDeps) =>
  (deps.chrome.storage.session.data.pending ?? []) as PendingItem[]

const tabCalls = (deps: TestDeps) =>
  deps.chrome.calls.filter((call) => call.name === "tabs.create" || call.name === "windows.create")

async function stored(deps: TestDeps, overrides: Partial<PendingItem> = {}) {
  const added = await enqueuePending(item(deps, overrides), storedFor(A), deps)
  if (!added) throw new Error("not enqueued")
  return added
}

describe("enqueuePending", () => {
  it("stores nothing when the connection it was made under is gone", async () => {
    const deps = testDeps(storedFor(B, { generation: 2 }))
    expect(await enqueuePending(item(deps), storedFor(A), deps)).toBeNull()
    expect(pending(deps)).toEqual([])
  })
})

describe("deliverPending", () => {
  it("opens the toolbar popup on the click's window and opens no tab", async () => {
    const deps = testDeps()
    const added = await stored(deps)
    await deliverPending(added, deps)
    expect(deps.chrome.calls.find((call) => call.name === "action.openPopup")?.arg).toEqual({
      windowId: 7,
    })
    expect(tabCalls(deps)).toEqual([])
    expect(pending(deps)[0]?.reservedForPage).toBe(false)
  })

  it("reserves the item and opens the fallback page when openPopup rejects", async () => {
    const deps = testDeps()
    deps.chrome.action.openPopup = async () => {
      throw new Error("Could not find an active browser window.")
    }
    const added = await stored(deps)
    await deliverPending(added, deps)
    expect(pending(deps)[0]?.reservedForPage).toBe(true)
    expect(tabCalls(deps)).toEqual([
      { name: "tabs.create", arg: { windowId: 7, url: `popup.html?pending=${added.id}` } },
    ])
  })

  it("opens a new window when the click's window has closed", async () => {
    const deps = testDeps()
    deps.chrome.action.openPopup = async () => {
      throw new Error("No window with id: 7.")
    }
    deps.chrome.tabs.create = async () => {
      throw new Error("No window with id: 7.")
    }
    const added = await stored(deps)
    await deliverPending(added, deps)
    expect(deps.chrome.calls.find((call) => call.name === "windows.create")?.arg).toEqual({
      url: `popup.html?pending=${added.id}`,
    })
  })

  it("opens no tab when a popup claimed the item before the reservation", async () => {
    const deps = testDeps()
    const added = await stored(deps)
    deps.chrome.action.openPopup = async () => {
      await claimPending({ windowId: 7, origin: A }, deps)
      throw new Error("Failed to open popup.")
    }
    await deliverPending(added, deps)
    expect(tabCalls(deps)).toEqual([])
    expect(pending(deps)).toEqual([])
  })
})

describe("claimPending", () => {
  it("grants an item once when a popup claim and a reservation start together", async () => {
    const deps = testDeps()
    const added = await stored(deps)
    let claimed: Promise<PendingItem | null> = Promise.resolve(null)
    deps.chrome.action.openPopup = async () => {
      claimed = claimPending({ windowId: 7, origin: A }, deps)
      throw new Error("Failed to open popup.")
    }
    await deliverPending(added, deps)
    const popupGot = await claimed
    const pageGot = await claimPending({ id: added.id, origin: A }, deps)
    expect([popupGot, pageGot].filter((got) => got !== null)).toHaveLength(1)
    expect(popupGot?.id).toBe(added.id)
    expect(tabCalls(deps)).toEqual([])
  })

  it("gives the item to the page when the reservation came first", async () => {
    const deps = testDeps()
    deps.chrome.action.openPopup = async () => {
      throw new Error("Failed to open popup.")
    }
    const added = await stored(deps)
    await deliverPending(added, deps)
    const popupGot = await claimPending({ windowId: 7, origin: A }, deps)
    const pageGot = await claimPending({ id: added.id, origin: A }, deps)
    expect(popupGot).toBeNull()
    expect(pageGot?.id).toBe(added.id)
    expect(await claimPending({ id: added.id, origin: A }, deps)).toBeNull()
  })

  it("removes the item it grants", async () => {
    const deps = testDeps()
    const added = await stored(deps)
    expect((await claimPending({ windowId: 7, origin: A }, deps))?.id).toBe(added.id)
    expect(pending(deps)).toEqual([])
    expect(await claimPending({ windowId: 7, origin: A }, deps)).toBeNull()
  })

  it("never gives a reserved item to the toolbar popup, only to its page", async () => {
    const deps = testDeps()
    const added = await stored(deps, { reservedForPage: true })
    expect(await claimPending({ windowId: 7, origin: A }, deps)).toBeNull()
    expect((await claimPending({ id: added.id, origin: A }, deps))?.id).toBe(added.id)
  })

  it("answers null for a page claim with no match", async () => {
    const deps = testDeps()
    await stored(deps)
    expect(await claimPending({ id: "gone", origin: A }, deps)).toBeNull()
    expect(await claimPending({ id: "item-1", origin: B }, deps)).toBeNull()
  })

  it("takes the newest item for the window", async () => {
    const deps = testDeps()
    await stored(deps)
    const newer = await stored(deps)
    await stored(deps, { windowId: 8 })
    expect((await claimPending({ windowId: 7, origin: A }, deps))?.id).toBe(newer.id)
    expect(pending(deps)).toHaveLength(2)
  })
})

describe("clearPending", () => {
  it("empties pending storage inside the queue", async () => {
    const deps = testDeps()
    await stored(deps)
    const adding = enqueuePending(item(deps), storedFor(A), deps)
    await clearPending(deps)
    await adding
    expect(pending(deps)).toEqual([])
  })
})

describe("message parsing", () => {
  it("reads both claim forms and refuses anything else", () => {
    expect(claimRequestFrom({ type: "claimPending", windowId: 3, origin: A })).toEqual({
      windowId: 3,
      origin: A,
    })
    expect(claimRequestFrom({ type: "claimPending", id: "x", origin: A })).toEqual({
      id: "x",
      origin: A,
    })
    expect(claimRequestFrom({ type: "claimPending", windowId: 3 })).toBeNull()
  })

  it("refuses a refresh without a connection answer or a start", () => {
    expect(refreshFrom({ fresh: { mode: "apiKey", capabilities: [] } })).toBeNull()
    expect(refreshFrom({ fresh: null, started: { origin: A, savedAt: 1 } })).toBeNull()
    expect(
      refreshFrom({
        fresh: { mode: "disabled", capabilities: [] },
        started: { origin: A, savedAt: 1 },
      }),
    ).not.toBeNull()
  })
})
