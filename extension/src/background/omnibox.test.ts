import { describe, expect, it, vi } from "vite-plus/test"
import { A, storedFor, testDeps, type TestDeps } from "../../tests/worker-deps"
import type { RecentLookup } from "../lib/storage"
import { handleOmniboxEnter, handleOmniboxInput, NOT_CONNECTED_SUGGESTION } from "./omnibox"

const recent: RecentLookup = {
  ip: "45.148.10.82",
  countryCode: "US",
  asn: 7018,
  asOrganization: "AT&T <Services>",
  decisionType: "ban",
  dropSblId: null,
  at: 1,
}

function withRecent(deps: TestDeps, items: RecentLookup[]): TestDeps {
  deps.chrome.storage.local.data[`recent:${A}:lifetime-1`] = items
  return deps
}

const defaults = (deps: TestDeps) =>
  deps.chrome.calls
    .filter((call) => call.name === "omnibox.setDefaultSuggestion")
    .map((call) => (call.arg as chrome.omnibox.DefaultSuggestResult).description)

describe("handleOmniboxInput", () => {
  it("offers the inspector by default and the recent lookup as an escaped row", async () => {
    const deps = withRecent(testDeps(), [recent])
    const suggest = vi.fn()
    await handleOmniboxInput("45.148.10.82", suggest, deps)
    expect(defaults(deps)).toEqual(["Open 45.148.10.82 in the IP inspector"])
    expect(suggest).toHaveBeenCalledWith([
      {
        content: "45.148.10.82 (recent)",
        description: "45.148.10.82 · Banned · US · AS7018 AT&amp;T &lt;Services&gt;",
      },
    ])
  })

  it("offers no recent row for an IP that wasn't looked up", async () => {
    const deps = withRecent(testDeps(), [recent])
    const suggest = vi.fn()
    await handleOmniboxInput("  192.0.2.1 extra", suggest, deps)
    expect(defaults(deps)).toEqual(["Open 192.0.2.1 in the IP inspector"])
    expect(suggest).toHaveBeenCalledWith([])
  })

  it("asks to connect first when nothing is stored", async () => {
    const deps = testDeps(null)
    const suggest = vi.fn()
    await handleOmniboxInput("45.148.10.82", suggest, deps)
    expect(defaults(deps)).toEqual([NOT_CONNECTED_SUGGESTION])
    expect(NOT_CONNECTED_SUGGESTION).toBe("Connect GeoMetrikks first")
    expect(suggest).toHaveBeenCalledWith([])
  })

  it("offers the server root for text that isn't an IP", async () => {
    const deps = testDeps()
    await handleOmniboxInput("hello", vi.fn(), deps)
    expect(defaults(deps)).toEqual(["Open GeoMetrikks"])
  })
})

describe("handleOmniboxEnter", () => {
  const opened = (deps: TestDeps) =>
    deps.chrome.calls.filter((call) => call.name === "tabs.update" || call.name === "tabs.create")

  it("opens the inspector in the current tab", async () => {
    const deps = testDeps()
    await handleOmniboxEnter("45.148.10.82", "currentTab", deps)
    expect(opened(deps)).toEqual([
      { name: "tabs.update", arg: { url: `${A}/?inspect=45.148.10.82` } },
    ])
  })

  it("honors the new-tab dispositions", async () => {
    const deps = testDeps()
    await handleOmniboxEnter("45.148.10.82", "newForegroundTab", deps)
    await handleOmniboxEnter("45.148.10.82 (recent)", "newBackgroundTab", deps)
    expect(opened(deps)).toEqual([
      { name: "tabs.create", arg: { url: `${A}/?inspect=45.148.10.82`, active: true } },
      { name: "tabs.create", arg: { url: `${A}/?inspect=45.148.10.82`, active: false } },
    ])
  })

  it("opens the server root for anything else", async () => {
    const deps = testDeps(storedFor(A))
    await handleOmniboxEnter("hello", "currentTab", deps)
    expect(opened(deps)).toEqual([{ name: "tabs.update", arg: { url: A } }])
  })

  it("opens Options when not connected", async () => {
    const deps = testDeps(null)
    await handleOmniboxEnter("45.148.10.82", "currentTab", deps)
    expect(deps.chrome.calls.map((call) => call.name)).toEqual(["runtime.openOptionsPage"])
  })
})
