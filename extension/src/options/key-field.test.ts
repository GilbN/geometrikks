import { describe, expect, it, vi } from "vite-plus/test"
import { fakeChrome } from "../../tests/fake-chrome"
import type { StoredConnection } from "../lib/storage"
import { connect, loadDisplayed, type FetchConnection } from "./connect"
import { EMPTY_KEY_PLACEHOLDER, keyPlaceholder, keyToSend, submission } from "./key-field"

const A = "https://a.example"
const B = "https://b.example"
const C = "https://c.example"

describe("keyToSend", () => {
  it("sends exactly what was typed, trimmed, to any origin", () => {
    for (const submittedOrigin of [A, B, null])
      expect(
        keyToSend({ typed: " gmk_typed ", storedKey: "gmk_a", storedOrigin: A, submittedOrigin }),
      ).toBe("gmk_typed")
  })

  it("reuses the stored key only for the origin it was saved for", () => {
    const stored = { storedKey: "gmk_a", storedOrigin: A }
    expect(keyToSend({ typed: "", ...stored, submittedOrigin: A })).toBe("gmk_a")
    expect(keyToSend({ typed: "  ", ...stored, submittedOrigin: B })).toBe("")
    expect(keyToSend({ typed: "", ...stored, submittedOrigin: null })).toBe("")
  })

  it("sends nothing for a keyless connection or no connection", () => {
    expect(keyToSend({ typed: "", storedKey: null, storedOrigin: A, submittedOrigin: A })).toBe("")
    expect(
      keyToSend({ typed: "", storedKey: null, storedOrigin: null, submittedOrigin: null }),
    ).toBe("")
  })
})

function storedFor(origin: string, key: string | null): StoredConnection {
  return {
    origin,
    pattern: `${origin}:443/*`,
    key,
    keyless: key === null,
    verifiedScope: "read",
    connection: {
      mode: "apiKey",
      appVersion: "0.26.0",
      apiVersion: "1",
      capabilities: [],
      name: "Laptop Chrome",
      scope: "read",
      expiresAt: null,
    },
    savedAt: 1,
    generation: 1,
  }
}

describe("keyPlaceholder", () => {
  const stored = storedFor(A, "gmk_abcdefghijkl")

  it("masks the stored key after its prefix while an empty field would reuse it", () => {
    expect(keyPlaceholder({ address: `${A}/map`, showKey: false }, stored)).toBe(
      `gmk_abcd${"•".repeat(24)}`,
    )
    expect(keyPlaceholder({ address: A, showKey: true }, stored)).toBe("gmk_abcdefghijkl")
  })

  it("shows no stored key for another address", () => {
    expect(keyPlaceholder({ address: B, showKey: true }, stored)).toBe(EMPTY_KEY_PLACEHOLDER)
    expect(keyPlaceholder({ address: "b.example", showKey: false }, stored)).toBe(
      EMPTY_KEY_PLACEHOLDER,
    )
  })
})

const answered: FetchConnection = async () => ({
  ok: true,
  connection: {
    mode: "apiKey",
    appVersion: "0.26.0",
    apiVersion: "1",
    capabilities: [],
    name: "Laptop Chrome",
    scope: "read",
    expiresAt: null,
  },
})

describe("two Options tabs over one storage", () => {
  /** One tab's form: what it last loaded, what the user typed, and whether the
   *  address was edited, which keeps a refresh from replacing it. */
  function tab(chromeApi: ReturnType<typeof fakeChrome>) {
    const form = { stored: null as StoredConnection | null, address: "", typed: "", edited: false }
    return {
      form,
      async refresh() {
        form.stored = (await loadDisplayed(chromeApi)).stored
        if (form.stored && !form.edited) form.address = form.stored.origin
      },
      editAddress(address: string) {
        form.address = address
        form.edited = true
      },
      async submit(fetchConnection: FetchConnection) {
        const sent = submission(form, form.stored)
        await connect(
          { address: sent.address, key: sent.key },
          { chrome: chromeApi, fetchConnection },
        )
      },
    }
  }

  it("never sends one server's stored key to another server", async () => {
    const chromeApi = fakeChrome({ local: { connection: storedFor(A, "gmk_a") } })
    chromeApi.granted.add(`${A}:443/*`)
    const first = tab(chromeApi)
    const second = tab(chromeApi)
    await first.refresh()
    await second.refresh()

    first.editAddress(C)
    second.editAddress(B)
    second.form.typed = "gmk_b"
    await second.submit(answered)
    await first.refresh()

    expect(first.form.stored).toMatchObject({ origin: B, key: "gmk_b" })
    expect(first.form.address).toBe(C)
    const seen = vi.fn(answered)
    await first.submit(seen)
    expect(seen).toHaveBeenCalledWith({ origin: C, key: null })

    first.editAddress(`${A}/map`)
    await first.refresh()
    const again = vi.fn(answered)
    await first.submit(again)
    expect(again).toHaveBeenCalledWith({ origin: A, key: null })
  })

  it("reuses the stored key for its own server after another tab changed it", async () => {
    const chromeApi = fakeChrome({ local: { connection: storedFor(A, "gmk_a") } })
    chromeApi.granted.add(`${A}:443/*`)
    const first = tab(chromeApi)
    const second = tab(chromeApi)
    await first.refresh()
    await second.refresh()

    second.form.typed = "gmk_rotated"
    await second.submit(answered)
    await first.refresh()

    const seen = vi.fn(answered)
    await first.submit(seen)
    expect(seen).toHaveBeenCalledWith({ origin: A, key: "gmk_rotated" })
  })
})
