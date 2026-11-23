import { describe, expect, it, vi } from "vite-plus/test"
import { fakeChrome } from "../../tests/fake-chrome"
import type { ConnectionResponse, StoredConnection } from "../lib/storage"
import { deriveAccess } from "../lib/connection"
import {
  readStoredConnection,
  sendWhileCurrent,
  sessionIsCurrent,
  type PopupSession,
} from "./open-context"

const saved: StoredConnection = {
  origin: "https://geo.example.net",
  pattern: "https://geo.example.net/*",
  key: "gmk_test",
  keyless: false,
  verifiedScope: "read",
  connection: { mode: "apiKey", appVersion: "0.26.0", apiVersion: "1", capabilities: [] },
  savedAt: 1,
} as unknown as StoredConnection

const fresh = {
  ...saved.connection,
  capabilities: ["crowdsec"],
} as unknown as ConnectionResponse

describe("readStoredConnection", () => {
  it("applies a refresh taken under the saved connection", async () => {
    const chromeApi = fakeChrome({
      local: {
        connection: saved,
        connectionRefresh: { origin: saved.origin, savedAt: 1, connection: fresh },
      },
    })
    expect((await readStoredConnection(chromeApi))?.connection).toEqual(fresh)
  })

  it("keeps the saved connection when the refresh can't be read", async () => {
    const chromeApi = fakeChrome({ local: { connection: saved } })
    const read = chromeApi.storage.local.get
    chromeApi.storage.local.get = async (keys) => {
      if (keys === "connectionRefresh") throw new Error("storage broke")
      return read(keys)
    }
    expect(await readStoredConnection(chromeApi)).toEqual(saved)
  })

  it("is null without a saved connection", async () => {
    expect(await readStoredConnection(fakeChrome())).toBeNull()
  })
})

const writable: StoredConnection = {
  ...saved,
  verifiedScope: "read_write",
  connection: { ...saved.connection, capabilities: ["crowdsecWrite"] },
  lifetime: "lifetime-1",
} as unknown as StoredConnection

function sessionFor(stored: StoredConnection): PopupSession {
  return {
    stored,
    connection: stored.connection,
    access: deriveAccess(stored, stored.connection),
  } as unknown as PopupSession
}

describe("sessionIsCurrent", () => {
  it("holds while the stored connection is the one the session opened with", () => {
    expect(sessionIsCurrent(sessionFor(writable), { ...writable })).toBe(true)
  })

  it("fails after a reconnect, a key change, a new lifetime or a disconnect", () => {
    const session = sessionFor(writable)
    expect(sessionIsCurrent(session, { ...writable, savedAt: 2 })).toBe(false)
    expect(sessionIsCurrent(session, { ...writable, key: "gmk_other" })).toBe(false)
    expect(sessionIsCurrent(session, { ...writable, lifetime: "lifetime-2" })).toBe(false)
    expect(sessionIsCurrent(session, { ...writable, origin: "https://b.example" })).toBe(false)
    expect(sessionIsCurrent(session, null)).toBe(false)
  })

  it("fails when the stored key's write access differs from the session's", () => {
    expect(sessionIsCurrent(sessionFor(writable), { ...writable, verifiedScope: "read" })).toBe(
      false,
    )
  })
})

describe("sendWhileCurrent", () => {
  it("sends while the connection is unchanged", async () => {
    const chromeApi = fakeChrome({ local: { connection: writable } })
    const send = vi.fn(async () => "banned")
    expect(await sendWhileCurrent(sessionFor(writable), send, chromeApi)).toEqual({
      stale: false,
      value: "banned",
    })
    expect(send).toHaveBeenCalledOnce()
  })

  it("sends nothing after a same-origin reconnect with a Read key", async () => {
    const chromeApi = fakeChrome({ local: { connection: writable } })
    const session = sessionFor(writable)
    chromeApi.storage.local.data.connection = {
      ...writable,
      key: "gmk_read",
      verifiedScope: "read",
      savedAt: 2,
    }
    const send = vi.fn(async () => "banned")
    expect(await sendWhileCurrent(session, send, chromeApi)).toEqual({ stale: true })
    expect(send).not.toHaveBeenCalled()
  })

  it("sends nothing when the connection changes during another read", async () => {
    const chromeApi = fakeChrome({ local: { connection: writable } })
    const read = chromeApi.storage.local.get
    chromeApi.storage.local.get = async (keys) => {
      const answer = await read(keys)
      if (keys === "connectionRefresh") {
        chromeApi.storage.local.data.connection = {
          ...writable,
          key: "gmk_read",
          verifiedScope: "read",
          savedAt: 2,
        }
      }
      return answer
    }
    const send = vi.fn(async () => "banned")
    expect(await sendWhileCurrent(sessionFor(writable), send, chromeApi)).toEqual({ stale: true })
    expect(send).not.toHaveBeenCalled()
  })

  it("sends nothing when the connection can't be read", async () => {
    const chromeApi = fakeChrome({ local: { connection: writable } })
    chromeApi.storage.local.get = async () => {
      throw new Error("storage broke")
    }
    const send = vi.fn(async () => "banned")
    expect(await sendWhileCurrent(sessionFor(writable), send, chromeApi)).toEqual({ stale: true })
    expect(send).not.toHaveBeenCalled()
  })
})
