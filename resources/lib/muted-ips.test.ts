import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test"
import type { Query } from "@tanstack/react-query"
import {
  getVersionStore,
  keepIfSameMuted,
  listVersion,
  markUnconfirmed,
  muteAction,
  mutedIpErrorMessage,
  mutedListPending,
  runUnmute,
  mutedKeyFields,
  mutedScope,
  noteFirstLoadFailed,
  noteListLoaded,
  currentWriteSequence,
  resetMutedIpsStoreForTests,
  readMutedIpsHiddenForTests,
  resolveVersion,
  subscribeVersionStore,
  setMutedIpsHidden,
} from "./muted-ips"

function stubStorage(items: Record<string, string> = {}) {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => items[key] ?? null,
    setItem: (key: string, value: string) => {
      items[key] = value
    },
    removeItem: (key: string) => {
      delete items[key]
    },
  })
  return items
}

beforeEach(() => {
  resetMutedIpsStoreForTests()
  stubStorage()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const current = () => resolveVersion(getVersionStore())

describe("listVersion", () => {
  it("is empty for no entries", () => {
    expect(listVersion([])).toBe("empty")
  })

  it("ignores entry order and is 8 hex characters", () => {
    const first = listVersion(["10.0.0.0/8", "1.2.3.4/32"])
    expect(first).toBe(listVersion(["1.2.3.4/32", "10.0.0.0/8"]))
    expect(first).toMatch(/^[0-9a-f]{8}$/)
  })

  it("changes with membership", () => {
    expect(listVersion(["1.2.3.4/32"])).not.toBe(listVersion(["1.2.3.5/32"]))
  })
})

describe("mutedScope", () => {
  const cases: Array<[boolean, string, boolean, string, boolean]> = [
    [true, "empty", false, "none", false],
    [false, "empty", false, "none", false],
    [true, "empty", true, "none", false],
    [false, "abcd0123", false, "shown", false],
    [false, "abcd0123", true, "shown", false],
    [true, "abcd0123", true, "greyed", false],
    [true, "abcd0123", false, "hiding", true],
    [true, "unknown-3", false, "hiding", true],
  ]
  it.each(cases)(
    "switch %s, version %s, include %s gives %s",
    (switchOn, version, hasIpInclude, chip, flag) => {
      expect(mutedScope({ switchOn, version, count: null, hasIpInclude })).toEqual({
        flag,
        version,
        count: null,
        chip,
      })
    },
  )
})

describe("resolveVersion", () => {
  it("uses a stored empty before the first attempt", () => {
    stubStorage({ mutedIpsVersion: "empty" })
    expect(current()).toBe("empty")
  })

  it("stays unknown across retries of a failed first load", () => {
    stubStorage({ mutedIpsVersion: "empty" })
    noteFirstLoadFailed()
    const first = current()
    expect(first).toMatch(/^unknown-/)
    noteFirstLoadFailed()
    expect(current()).toBe(first)
    markUnconfirmed()
    expect(current()).not.toBe(first)
  })

  it("does not notify when a failure changes nothing", () => {
    noteListLoaded(["1.2.3.4/32"])
    const listener = vi.fn()
    const unsubscribe = subscribeVersionStore(listener)
    noteFirstLoadFailed()
    unsubscribe()
    expect(listener).not.toHaveBeenCalled()
  })

  it("gives each write a new unknown version", () => {
    markUnconfirmed()
    const first = current()
    markUnconfirmed()
    expect(current()).not.toBe(first)
    expect(current()).toMatch(/^unknown-/)
  })

  it("stays confirmed after a later fetch error", () => {
    noteListLoaded(["1.2.3.4/32"])
    const confirmed = current()
    noteFirstLoadFailed()
    expect(current()).toBe(confirmed)
  })

  it("lets unconfirmed outrank a pending first load", () => {
    stubStorage({ mutedIpsVersion: "empty" })
    markUnconfirmed()
    expect(current()).toMatch(/^unknown-/)
  })

  it("clears the stored version on a write", () => {
    const items = stubStorage({ mutedIpsVersion: "empty" })
    markUnconfirmed()
    expect(items.mutedIpsVersion).toBeUndefined()
  })

  it("writes the version of a loaded list", () => {
    const items = stubStorage()
    noteListLoaded(["1.2.3.4/32"])
    expect(items.mutedIpsVersion).toBe(listVersion(["1.2.3.4/32"]))
  })

  it("confirms only from a GET that started after the write", () => {
    const startedBefore = currentWriteSequence()
    markUnconfirmed()
    const unconfirmed = current()
    noteListLoaded(["1.2.3.4/32"], startedBefore)
    expect(current()).toBe(unconfirmed)
    noteListLoaded(["1.2.3.4/32"], currentWriteSequence())
    expect(current()).toBe(listVersion(["1.2.3.4/32"]))
  })
})

describe("storage that throws", () => {
  it("defaults the switch on and the version to unknown", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked")
      },
      setItem: () => {
        throw new Error("blocked")
      },
      removeItem: () => {
        throw new Error("blocked")
      },
    })
    resetMutedIpsStoreForTests()
    expect(current()).toMatch(/^unknown-/)
    expect(readMutedIpsHiddenForTests()).toBe(true)
    expect(() => setMutedIpsHidden(false)).not.toThrow()
    expect(() => markUnconfirmed()).not.toThrow()
  })
})

describe("mutedKeyFields", () => {
  it("is empty when the flag is off", () => {
    const scope = mutedScope({
      switchOn: false,
      version: "abcd0123",
      count: 1,
      hasIpInclude: false,
    })
    expect(mutedKeyFields(scope)).toEqual({})
  })

  it("carries the flag and version when on", () => {
    const scope = mutedScope({ switchOn: true, version: "abcd0123", count: 1, hasIpInclude: false })
    expect(mutedKeyFields(scope)).toEqual({ excludeMutedIps: true, mutedIpsVersion: "abcd0123" })
  })
})

describe("keepIfSameMuted", () => {
  const queryOf = (fields: object) =>
    ({ queryKey: ["logs", { page: 1, ...fields }] }) as unknown as Query
  const data = { rows: [1] }

  it("keeps the data for the same version", () => {
    const fields = { excludeMutedIps: true, mutedIpsVersion: "abcd0123" } as const
    expect(keepIfSameMuted(fields)(data, queryOf(fields))).toBe(data)
  })

  it("keeps the data while the flag stays off", () => {
    expect(keepIfSameMuted({})(data, queryOf({}))).toBe(data)
  })

  it("drops the data for a different version", () => {
    const before = { excludeMutedIps: true, mutedIpsVersion: "abcd0123" }
    const after = { excludeMutedIps: true, mutedIpsVersion: "ffff0000" } as const
    expect(keepIfSameMuted(after)(data, queryOf(before))).toBeUndefined()
  })

  it("drops the data when the flag changes", () => {
    const before = { excludeMutedIps: true, mutedIpsVersion: "abcd0123" }
    expect(keepIfSameMuted({})(data, queryOf(before))).toBeUndefined()
  })

  const fieldsFor = (version: string) =>
    ({ excludeMutedIps: true, mutedIpsVersion: version }) as const

  it("keeps the data from a write's unknown version to the version its GET confirmed", () => {
    markUnconfirmed()
    const from = current()
    noteListLoaded(["1.2.3.4/32"], currentWriteSequence())
    const to = current()
    expect(keepIfSameMuted(fieldsFor(to))(data, queryOf(fieldsFor(from)))).toBe(data)
  })

  it("drops the data between two unknown versions", () => {
    expect(
      keepIfSameMuted(fieldsFor("unknown-3"))(data, queryOf(fieldsFor("unknown-2"))),
    ).toBeUndefined()
  })

  it("does not carry write 1's data into write 2's confirmed version", () => {
    markUnconfirmed()
    const firstUnknown = current()
    noteListLoaded(["1.2.3.4/32"], currentWriteSequence())
    markUnconfirmed()
    noteListLoaded(["1.2.3.4/32", "5.6.7.8/32"], currentWriteSequence())
    expect(
      keepIfSameMuted(fieldsFor(current()))(data, queryOf(fieldsFor(firstUnknown))),
    ).toBeUndefined()
  })

  it("does not carry a failed first load's data into the confirmed version", () => {
    noteFirstLoadFailed()
    const failedUnknown = current()
    noteListLoaded(["1.2.3.4/32"])
    expect(
      keepIfSameMuted(fieldsFor(current()))(data, queryOf(fieldsFor(failedUnknown))),
    ).toBeUndefined()
  })
})

describe("muteAction", () => {
  const entry = (network: string, id = "id-1") => ({
    id,
    network,
    note: null,
    createdAt: "2026-11-20T00:00:00Z",
  })

  it("unmutes an uppercase, zero-padded IPv6 row against a stored /128", () => {
    expect(muteAction("2001:DB8:0::5", [entry("2001:db8::5/128")])).toEqual({
      kind: "unmute",
      id: "id-1",
    })
  })

  it("unmutes an IPv4-mapped row against a stored /32", () => {
    expect(muteAction("::ffff:203.0.113.7", [entry("203.0.113.7/32", "id-2")])).toEqual({
      kind: "unmute",
      id: "id-2",
    })
  })

  it("mutes an IP that only a range covers", () => {
    expect(muteAction("192.0.2.9", [entry("192.0.2.0/24")])).toEqual({ kind: "mute" })
  })

  it("mutes when the list is empty or the text is not an address", () => {
    expect(muteAction("198.51.100.1", [])).toEqual({ kind: "mute" })
    expect(muteAction("not-an-ip", [entry("198.51.100.1/32")])).toEqual({ kind: "mute" })
  })
})

describe("runUnmute", () => {
  it("counts a 404 envelope as unmuted", async () => {
    const remove = vi.fn().mockRejectedValue({ status_code: 404, detail: "gone" })
    expect(await runUnmute(remove, "id-1")).toEqual({ ok: true })
    expect(remove).toHaveBeenCalledWith("id-1")
  })

  it("is ok when the delete succeeds", async () => {
    expect(await runUnmute(vi.fn().mockResolvedValue(undefined), "id-1")).toEqual({ ok: true })
  })

  it("maps another error through mutedIpErrorMessage", async () => {
    const remove = vi.fn().mockRejectedValue({ status_code: 500, code: "invalid_note" })
    expect(await runUnmute(remove, "id-1")).toEqual({
      ok: false,
      message: mutedIpErrorMessage("invalid_note"),
    })
    const unknown = vi.fn().mockRejectedValue(new Error("network"))
    expect(await runUnmute(unknown, "id-1")).toEqual({
      ok: false,
      message: mutedIpErrorMessage(undefined),
    })
  })
})

describe("mutedListPending", () => {
  const entries = [
    { id: "id-1", network: "1.2.3.4/32", note: null, createdAt: "2026-11-20T00:00:00Z" },
  ]

  it("is pending without entries or with an unknown version", () => {
    expect(mutedListPending("abcd1234", undefined)).toBe(true)
    expect(mutedListPending("unknown-3", entries)).toBe(true)
  })

  it("is settled with a confirmed version and entries", () => {
    expect(mutedListPending("abcd1234", entries)).toBe(false)
    expect(mutedListPending("empty", [])).toBe(false)
  })
})
