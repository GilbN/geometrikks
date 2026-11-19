import { describe, expect, it, vi } from "vite-plus/test"
import {
  A,
  B,
  noWriteAnswer,
  readAnswer,
  storedFor,
  testDeps,
  writeAnswer,
  type TestDeps,
} from "../../tests/worker-deps"
import type { Access } from "../lib/connection"
import type { PendingItem, StoredConnection } from "../lib/storage"
import {
  buildMenus,
  handleMenuClick,
  handleRefreshConnection,
  MAX_SELECTION_LENGTH,
  rebuildMenus,
} from "./menus"

const readOnly: Access = { write: false, crowdsec: true, drop: true, asn: true, hostFilter: true }
const writable: Access = { ...readOnly, write: true }

const menuCalls = (deps: TestDeps) =>
  deps.chrome.calls.filter((call) => call.name.startsWith("contextMenus."))

const created = (deps: TestDeps) =>
  menuCalls(deps)
    .filter((call) => call.name === "contextMenus.create")
    .map((call) => call.arg as chrome.contextMenus.CreateProperties)

const pending = (deps: TestDeps) =>
  (deps.chrome.storage.session.data.pending ?? []) as PendingItem[]

const tab = { windowId: 7 } as chrome.tabs.Tab
const ban24h = (selectionText: string) => ({ menuItemId: "gmk-ban:24h", selectionText })

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("buildMenus", () => {
  it("registers nothing when not connected, after clearing the old menus", async () => {
    const deps = testDeps(null)
    await buildMenus(null, deps)
    expect(menuCalls(deps).map((call) => call.name)).toEqual(["contextMenus.removeAll"])
  })

  it("registers the parent and Look up only for a read-only connection", async () => {
    const deps = testDeps()
    await buildMenus(readOnly, deps)
    expect(menuCalls(deps)[0]?.name).toBe("contextMenus.removeAll")
    expect(created(deps).map((item) => item.id)).toEqual(["gmk", "gmk-lookup"])
  })

  it("adds Ban with the five durations when the connection may write", async () => {
    const deps = testDeps()
    await buildMenus(writable, deps)
    const items = created(deps)
    expect(items.map((item) => item.id)).toEqual([
      "gmk",
      "gmk-lookup",
      "gmk-ban",
      "gmk-ban:1h",
      "gmk-ban:4h",
      "gmk-ban:24h",
      "gmk-ban:168h",
      "gmk-ban:87600h",
    ])
    expect(items.filter((item) => item.parentId === "gmk-ban").map((item) => item.title)).toEqual([
      "1 hour",
      "4 hours",
      "24 hours",
      "7 days",
      "Forever",
    ])
    expect(items.find((item) => item.id === "gmk-lookup")?.title).toBe("Look up %s")
    expect(items.find((item) => item.id === "gmk-ban")?.title).toBe("Ban %s")
    for (const item of items) expect(item.contexts).toEqual(["selection"])
  })

  it("never interleaves two overlapping rebuilds", async () => {
    const deps = testDeps()
    const firstRemove = deferred<void>()
    let removes = 0
    deps.chrome.contextMenus.removeAll = async () => {
      deps.chrome.calls.push({ name: "contextMenus.removeAll", arg: undefined })
      if (++removes === 1) await firstRemove.promise
    }
    const first = buildMenus(writable, deps)
    const second = buildMenus(readOnly, deps)
    await Promise.resolve()
    firstRemove.resolve()
    await Promise.all([first, second])
    expect(menuCalls(deps).map((call) => (call.arg as { id?: string })?.id ?? call.name)).toEqual([
      "contextMenus.removeAll",
      "gmk",
      "gmk-lookup",
      "gmk-ban",
      "gmk-ban:1h",
      "gmk-ban:4h",
      "gmk-ban:24h",
      "gmk-ban:168h",
      "gmk-ban:87600h",
      "contextMenus.removeAll",
      "gmk",
      "gmk-lookup",
    ])
  })

  it("rebuilds from storage, with a matching refresh applied", async () => {
    const deps = testDeps(storedFor(A))
    deps.chrome.storage.local.data.connectionRefresh = {
      origin: A,
      savedAt: 1,
      connection: noWriteAnswer,
    }
    await rebuildMenus(deps)
    expect(created(deps).map((item) => item.id)).toEqual(["gmk", "gmk-lookup"])
  })

  it("never shows Ban for a Read key even when the server allows bans", async () => {
    const deps = testDeps(storedFor(A, { verifiedScope: "read", connection: readAnswer }))
    await rebuildMenus(deps)
    expect(created(deps).map((item) => item.id)).toEqual(["gmk", "gmk-lookup"])
  })
})

describe("handleMenuClick", () => {
  it("sends nothing for text that isn't an IP and stores a not-ip item", async () => {
    for (const menuItemId of ["gmk-lookup", "gmk-ban:24h"]) {
      const deps = testDeps()
      const item = await handleMenuClick({ menuItemId, selectionText: "  hello " }, tab, deps)
      expect(item).toMatchObject({ kind: "not-ip", ip: null, text: "hello", windowId: 7 })
      expect(deps.fetchConnection).not.toHaveBeenCalled()
      expect(deps.banIp).not.toHaveBeenCalled()
      expect(pending(deps)).toEqual([item])
    }
  })

  it("stores a lookup item for Look up on an IP without calling the server", async () => {
    const deps = testDeps()
    const item = await handleMenuClick(
      { menuItemId: "gmk-lookup", selectionText: " 45.148.10.82 " },
      tab,
      deps,
    )
    expect(item).toMatchObject({
      kind: "lookup",
      ip: "45.148.10.82",
      origin: A,
      windowId: 7,
      reservedForPage: false,
    })
    expect(deps.fetchConnection).not.toHaveBeenCalled()
    expect(pending(deps)).toHaveLength(1)
  })

  it("does nothing when not connected", async () => {
    const deps = testDeps(null)
    expect(await handleMenuClick(ban24h("45.148.10.82"), tab, deps)).toBeNull()
    expect(deps.banIp).not.toHaveBeenCalled()
  })

  it("checks the connection, then bans and stores the result", async () => {
    const deps = testDeps()
    const item = await handleMenuClick(ban24h("45.148.10.82"), tab, deps)
    expect(deps.fetchConnection).toHaveBeenCalledWith({ origin: A, key: "gmk_rw" })
    expect(deps.banIp).toHaveBeenCalledWith(
      { origin: A, key: "gmk_rw" },
      "45.148.10.82",
      expect.objectContaining({ value: "24h", label: "24 hours" }),
    )
    expect(item).toMatchObject({ kind: "ban", ip: "45.148.10.82", result: { ok: true } })
    expect(pending(deps)).toEqual([item])
  })

  it("stores a failed ban item when the connection check fails", async () => {
    const deps = testDeps()
    deps.fetchConnection.mockResolvedValue({ ok: false, failure: { networkError: true } })
    const unreachable = await handleMenuClick(ban24h("45.148.10.82"), tab, deps)
    expect(unreachable?.result).toMatchObject({ ok: false })
    expect(unreachable?.result?.message).toContain("Can't reach a.example.")

    deps.fetchConnection.mockResolvedValue({
      ok: false,
      failure: { status: 401, code: "api_key_invalid", detail: "API key is invalid" },
    })
    const revoked = await handleMenuClick(ban24h("45.148.10.82"), tab, deps)
    expect(revoked?.result?.message).toContain("This key no longer works.")
    expect(deps.banIp).not.toHaveBeenCalled()
  })

  it("rebuilds the menus and sends nothing when the server stopped accepting bans", async () => {
    const deps = testDeps()
    deps.fetchConnection.mockResolvedValue({ ok: true, connection: noWriteAnswer })
    const item = await handleMenuClick(ban24h("45.148.10.82"), tab, deps)
    expect(deps.banIp).not.toHaveBeenCalled()
    expect(item?.result).toMatchObject({ ok: false })
    expect(item?.result?.message).toBe(
      "45.148.10.82 wasn't banned. a.example no longer accepts bans from this connection.",
    )
    expect(created(deps).map((menu) => menu.id)).toEqual(["gmk", "gmk-lookup"])
    expect(deps.chrome.storage.local.data.connectionRefresh).toEqual({
      origin: A,
      savedAt: 1,
      connection: noWriteAnswer,
    })
  })

  it("asks for a retry and sends nothing when the server started accepting bans", async () => {
    const deps = testDeps(storedFor(A, { connection: noWriteAnswer }))
    deps.fetchConnection.mockResolvedValue({ ok: true, connection: writeAnswer })
    const item = await handleMenuClick(ban24h("45.148.10.82"), tab, deps)
    expect(deps.banIp).not.toHaveBeenCalled()
    expect(item?.result?.message).toBe(
      "45.148.10.82 wasn't banned. Ban is now available; try again.",
    )
    expect(created(deps).map((menu) => menu.id)).toContain("gmk-ban")
  })

  it("sends nothing when the connection can't write before or after the check", async () => {
    const deps = testDeps(storedFor(A, { verifiedScope: "read", connection: readAnswer }))
    deps.fetchConnection.mockResolvedValue({ ok: true, connection: readAnswer })
    const item = await handleMenuClick(ban24h("45.148.10.82"), tab, deps)
    expect(deps.banIp).not.toHaveBeenCalled()
    expect(item?.result).toMatchObject({ ok: false })
  })

  it("sends no ban when the user reconnects with a Read key during the check", async () => {
    const deps = testDeps()
    const check = deferred<Awaited<ReturnType<TestDeps["fetchConnection"]>>>()
    deps.fetchConnection.mockReturnValue(check.promise)
    const click = handleMenuClick(ban24h("45.148.10.82"), tab, deps)
    await vi.waitFor(() => expect(deps.fetchConnection).toHaveBeenCalledOnce())
    const reconnected: StoredConnection = storedFor(A, {
      key: "gmk_read",
      verifiedScope: "read",
      connection: readAnswer,
      savedAt: 2,
    })
    deps.chrome.storage.local.data.connection = reconnected
    check.resolve({ ok: true, connection: writeAnswer })
    expect(await click).toBeNull()
    expect(deps.banIp).not.toHaveBeenCalled()
    expect(pending(deps)).toEqual([])
  })

  it("sends no ban when the key changes while the check is answered", async () => {
    const deps = testDeps()
    const stored = deps.chrome.storage.local.data.connection as StoredConnection
    deps.fetchConnection.mockImplementation(async () => {
      deps.chrome.storage.local.data.connection = { ...stored, key: "gmk_other" }
      return { ok: true, connection: writeAnswer }
    })
    expect(await handleMenuClick(ban24h("45.148.10.82"), tab, deps)).toBeNull()
    expect(deps.banIp).not.toHaveBeenCalled()
    expect(pending(deps)).toEqual([])
  })

  it("stores a failed ban item without calling the server when host access was removed", async () => {
    const deps = testDeps()
    deps.chrome.granted.clear()
    const item = await handleMenuClick(ban24h("45.148.10.82"), tab, deps)
    expect(deps.fetchConnection).not.toHaveBeenCalled()
    expect(deps.banIp).not.toHaveBeenCalled()
    expect(item).toMatchObject({ kind: "ban", result: { ok: false } })
    expect(item?.result?.message).toBe(
      "45.148.10.82 wasn't banned. GeoMetrikks for Chrome lost access to a.example.",
    )
    expect(pending(deps)).toEqual([item])
  })

  it("stores a failed ban item when the ban request throws", async () => {
    const deps = testDeps()
    deps.banIp.mockRejectedValue(new TypeError("Failed to fetch"))
    const item = await handleMenuClick(ban24h("45.148.10.82"), tab, deps)
    expect(item).toMatchObject({ kind: "ban", result: { ok: false } })
    expect(item?.result?.message).toBe("Ban failed for 45.148.10.82; the server didn't answer.")
    expect(pending(deps)).toEqual([item])
  })

  it("uses the current window when the click has no tab", async () => {
    for (const clickTab of [undefined, { windowId: -1 } as chrome.tabs.Tab]) {
      const deps = testDeps()
      const item = await handleMenuClick(
        { menuItemId: "gmk-lookup", selectionText: "45.148.10.82" },
        clickTab,
        deps,
      )
      expect(deps.chrome.calls.some((call) => call.name === "windows.getCurrent")).toBe(true)
      expect(item?.windowId).toBe(1)
    }
  })

  it("stores at most 256 characters of the selection", async () => {
    const deps = testDeps()
    const item = await handleMenuClick(
      { menuItemId: "gmk-lookup", selectionText: `  ${"x".repeat(5000)}  ` },
      tab,
      deps,
    )
    expect(item).toMatchObject({ kind: "not-ip", text: "x".repeat(MAX_SELECTION_LENGTH) })
    expect(pending(deps)[0]?.text).toHaveLength(MAX_SELECTION_LENGTH)
  })

  it("stores no item and logs the sent ban when the server changed while it was in flight", async () => {
    const deps = testDeps()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    deps.banIp.mockImplementation(async (_target, ip, duration) => {
      deps.chrome.storage.local.data.connection = storedFor(B, { lifetime: "lifetime-2" })
      return { ok: true, ip, durationLabel: duration.label, message: "Banned" }
    })
    expect(await handleMenuClick(ban24h("45.148.10.82"), tab, deps)).toBeNull()
    expect(pending(deps)).toEqual([])
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]?.[0]).toContain("45.148.10.82")
    expect(warn.mock.calls[0]?.[0]).toContain(A)
    warn.mockRestore()
  })

  it("logs nothing when a refused ban is dropped for a changed connection", async () => {
    const deps = testDeps()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    deps.chrome.granted.clear()
    const contains = deps.chrome.permissions.contains.bind(deps.chrome.permissions)
    deps.chrome.permissions.contains = async (permissions) => {
      deps.chrome.storage.local.data.connection = storedFor(B, { lifetime: "lifetime-2" })
      return contains(permissions)
    }
    expect(await handleMenuClick(ban24h("45.148.10.82"), tab, deps)).toBeNull()
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe("handleRefreshConnection", () => {
  it("keeps B's refresh when a late refresh for A arrives", async () => {
    const deps = testDeps(storedFor(B, { savedAt: 5, lifetime: "lifetime-2" }))
    expect(await handleRefreshConnection(noWriteAnswer, { origin: B, savedAt: 5 }, deps)).toBe(true)
    expect(await handleRefreshConnection(writeAnswer, { origin: A, savedAt: 1 }, deps)).toBe(false)
    expect(await handleRefreshConnection(writeAnswer, { origin: B, savedAt: 4 }, deps)).toBe(false)
    expect(deps.chrome.storage.local.data.connectionRefresh).toEqual({
      origin: B,
      savedAt: 5,
      connection: noWriteAnswer,
    })
  })

  it("rebuilds the menus from the refreshed answer", async () => {
    const deps = testDeps()
    await handleRefreshConnection(noWriteAnswer, { origin: A, savedAt: 1 }, deps)
    expect(created(deps).map((item) => item.id)).toEqual(["gmk", "gmk-lookup"])
  })
})
