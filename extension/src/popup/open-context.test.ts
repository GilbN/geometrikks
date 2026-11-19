import { describe, expect, it } from "vite-plus/test"
import { fakeChrome } from "../../tests/fake-chrome"
import type { ConnectionResponse, StoredConnection } from "../lib/storage"
import { readStoredConnection } from "./open-context"

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
