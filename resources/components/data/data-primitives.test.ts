import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { DataTableFrame } from "./data-table-frame"
import { FilterField, FilterPair, FilterRail } from "./filter-rail"
import { FilterChip, TagInput } from "./tag-input"
import { SignalPanel } from "./signal-panel"
import { dataState, type DataState } from "./types"

const STATES: DataState[] = ["loading", "error", "empty", "ready"]

describe("dataState", () => {
  it("orders loading over error over empty", () => {
    expect(dataState(true, true, 0)).toBe("loading")
    expect(dataState(false, true, 5)).toBe("error")
    expect(dataState(false, false, 0)).toBe("empty")
    expect(dataState(false, false, 1)).toBe("ready")
  })
})

describe("DataTableFrame", () => {
  it.each(STATES)("keeps title, count, tools and footer in the %s state", (state) => {
    const html = renderToStaticMarkup(
      createElement(DataTableFrame, {
        title: "Request history",
        description: "Help text",
        count: 12345,
        tools: createElement("button", null, "Columns"),
        footer: createElement("nav", null, "Pages"),
        state,
        children: createElement("table"),
      }),
    )
    expect(html).toContain("Request history")
    expect(html).toContain("Help text")
    expect(html).toContain((12345).toLocaleString())
    expect(html).toContain("Columns")
    expect(html).toContain("Pages")
    expect(html).toContain(`data-state="${state}"`)
    expect(html.includes("<table")).toBe(state === "ready")
  })

  it("labels the section by its heading and reports busy while loading", () => {
    const html = renderToStaticMarkup(
      createElement(DataTableFrame, { title: "T", state: "loading", children: null }),
    )
    const id = html.match(/aria-labelledby="([^"]+)"/)?.[1]
    expect(id).toBeTruthy()
    expect(html).toContain(`<h2 id="${id}"`)
    expect(html).toContain('aria-busy="true"')
  })

  it("renders the error state through ErrorBanner", () => {
    const html = renderToStaticMarkup(
      createElement(DataTableFrame, { title: "T", state: "error", error: "Boom", children: null }),
    )
    expect(html).toContain('role="alert"')
    expect(html).toContain("Boom")
  })
})

describe("SignalPanel", () => {
  it.each(STATES)("keeps title, actions and legend in the %s state", (state) => {
    const html = renderToStaticMarkup(
      createElement(SignalPanel, {
        title: "Requests",
        description: "Volume",
        actions: createElement("span", null, "Hourly"),
        legend: createElement("span", null, "Legend"),
        state,
        children: createElement("div", { "data-chart": "" }),
      }),
    )
    expect(html).toContain("Requests")
    expect(html).toContain("Hourly")
    expect(html).toContain("Legend")
    expect(html.includes("data-chart")).toBe(state === "ready")
  })

  it("offers retry only when a handler is given", () => {
    const without = renderToStaticMarkup(
      createElement(SignalPanel, { title: "T", state: "error", children: null }),
    )
    const withRetry = renderToStaticMarkup(
      createElement(SignalPanel, { title: "T", state: "error", onRetry: () => {}, children: null }),
    )
    expect(without).not.toContain("Try again")
    expect(withRetry).toContain("Try again")
  })
})

describe("FilterRail", () => {
  it("is a named region whose Clear button carries the active count", () => {
    const html = renderToStaticMarkup(
      createElement(FilterRail, { label: "Request filters", activeCount: 3, onClear: () => {}, children: null }),
    )
    expect(html).toContain('role="region"')
    expect(html).toContain('aria-label="Request filters"')
    expect(html).not.toContain(">Request filters<")
    expect(html).toContain("Clear 3 filters")
  })

  it("hides Clear when nothing is active", () => {
    const html = renderToStaticMarkup(
      createElement(FilterRail, { label: "L", activeCount: 0, onClear: () => {}, children: null }),
    )
    expect(html).not.toContain("Clear")
  })
})

describe("FilterField and FilterPair", () => {
  it("labels its control", () => {
    const html = renderToStaticMarkup(
      createElement(FilterField, { label: "Country", children: createElement("input") }),
    )
    expect(html).toMatch(/<label[^>]*>.*Country.*<input/)
  })

  it("joins include and exclude on desktop and splits them when stacked", () => {
    const props = {
      label: "IP address",
      excludeLabel: "Exclude IP",
      include: createElement("input", { id: "a" }),
      exclude: createElement("input", { id: "b" }),
    }
    const joined = renderToStaticMarkup(createElement(FilterPair, props))
    expect(joined).toContain('data-pair="start"')
    expect(joined).toContain('data-pair="end"')
    expect(joined).not.toContain(">Exclude IP<")
    const stacked = renderToStaticMarkup(createElement(FilterPair, { ...props, stacked: true }))
    expect(stacked).not.toContain("data-pair")
    expect(stacked).toContain(">Exclude IP<")
  })
})

describe("TagInput and FilterChip", () => {
  it("marks the exclude variants", () => {
    expect(renderToStaticMarkup(createElement(TagInput, { onAdd: () => {}, exclude: true }))).toContain("pl-7")
    const chip = renderToStaticMarkup(
      createElement(FilterChip, { value: "10.0.0.1", exclude: true, onRemove: () => {} }),
    )
    expect(chip).toContain('aria-label="Remove exclusion 10.0.0.1"')
    expect(chip).toContain("text-destructive")
  })
})
