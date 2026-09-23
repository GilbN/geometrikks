import { describe, expect, it } from "vitest"
import {
  chartOptionChips,
  chartOptionsLabel,
  chartOptionsStorageKey,
  loadChartOptions,
  parseChartOptions,
  resolveChartOptions,
  saveChartOptions,
  type ChartOptionsSpec,
} from "./chart-options"

const spec = {
  views: [
    { id: "stacked", label: "Stacked counts", scales: ["clip", "full", "log"] },
    { id: "share", label: "Share of responses", chip: "Share", scales: ["full"] },
    { id: "error-rate", label: "Error rate", scales: ["clip", "full"] },
  ],
} satisfies ChartOptionsSpec

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  }
}

const throwingStorage = {
  getItem: () => { throw new Error("blocked") },
  setItem: () => { throw new Error("blocked") },
}

describe("parseChartOptions", () => {
  it("defaults to the first view and its first scale", () => {
    expect(parseChartOptions(spec, undefined)).toEqual({ view: "stacked", scale: "clip" })
    expect(parseChartOptions(spec, "junk")).toEqual({ view: "stacked", scale: "clip" })
  })

  it("replaces an unknown view and an unknown scale", () => {
    expect(parseChartOptions(spec, { view: "pie", scale: "cubic" })).toEqual({ view: "stacked", scale: "clip" })
  })

  it("keeps a known scale even when the view does not allow it", () => {
    expect(parseChartOptions(spec, { view: "share", scale: "log" })).toEqual({ view: "share", scale: "log" })
  })
})

describe("resolveChartOptions", () => {
  it("maps a scale the view does not allow to the view's default", () => {
    expect(resolveChartOptions(spec, { view: "share", scale: "log" })).toEqual({ view: "share", scale: "full" })
    expect(resolveChartOptions(spec, { view: "error-rate", scale: "log" })).toEqual({ view: "error-rate", scale: "clip" })
  })

  it("restores the stored scale when the view allows it again", () => {
    expect(resolveChartOptions(spec, { view: "stacked", scale: "log" })).toEqual({ view: "stacked", scale: "log" })
  })
})

describe("loadChartOptions / saveChartOptions", () => {
  it("round-trips through storage under the chart key", () => {
    const storage = fakeStorage()
    saveChartOptions("t-roundtrip", { view: "share", scale: "log" }, storage)
    expect(storage.data.get(chartOptionsStorageKey("t-roundtrip"))).toBe('{"view":"share","scale":"log"}')
    expect(loadChartOptions("t-roundtrip", storage)).toEqual({ view: "share", scale: "log" })
  })

  it("returns undefined for unparsable JSON with nothing in memory", () => {
    const storage = fakeStorage({ [chartOptionsStorageKey("t-bad")]: "{nope" })
    expect(loadChartOptions("t-bad", storage)).toBeUndefined()
  })

  it("keeps a successful read for when storage starts throwing", () => {
    const storage = fakeStorage({ [chartOptionsStorageKey("t-read")]: '{"view":"share","scale":"full"}' })
    expect(loadChartOptions("t-read", storage)).toEqual({ view: "share", scale: "full" })
    expect(loadChartOptions("t-read", throwingStorage)).toEqual({ view: "share", scale: "full" })
  })

  it("prefers the newer in-memory choice when a write fails but reads still work", () => {
    const data = new Map([[chartOptionsStorageKey("t-quota"), '{"view":"stacked","scale":"clip"}']])
    const quotaFull = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: () => { throw new Error("quota exceeded") },
    }
    saveChartOptions("t-quota", { view: "share", scale: "full" }, quotaFull)
    expect(loadChartOptions("t-quota", quotaFull)).toEqual({ view: "share", scale: "full" })

    const working = fakeStorage()
    saveChartOptions("t-quota", { view: "error-rate", scale: "clip" }, working)
    working.data.set(chartOptionsStorageKey("t-quota"), '{"view":"stacked","scale":"log"}')
    expect(loadChartOptions("t-quota", working)).toEqual({ view: "stacked", scale: "log" })
  })

  it("falls back to the in-memory copy when storage throws", () => {
    saveChartOptions("t-blocked", { view: "error-rate", scale: "full" }, throwingStorage)
    expect(loadChartOptions("t-blocked", throwingStorage)).toEqual({ view: "error-rate", scale: "full" })
  })
})

describe("chips and label", () => {
  const view = (id: string) => spec.views.find((v) => v.id === id)!

  it("shows nothing at defaults", () => {
    const chips = chartOptionChips({ view: view("stacked"), scale: "clip", isDefault: { view: true, scale: true } })
    expect(chips).toEqual([])
    expect(chartOptionsLabel("Status classes", chips)).toBe("Chart options: Status classes")
  })

  it("names the view chip and the scale chip", () => {
    const chips = chartOptionChips({ view: view("share"), scale: "full", isDefault: { view: false, scale: true } })
    expect(chips).toEqual(["Share"])
    const both = chartOptionChips({ view: view("stacked"), scale: "log", isDefault: { view: true, scale: false } })
    expect(both).toEqual(["Log"])
    expect(chartOptionsLabel("Status classes", ["Share", "Log"])).toBe("Chart options: Status classes, Share, Log")
  })
})
