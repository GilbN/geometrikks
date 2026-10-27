import type { MouseEvent } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { rowActivation, stopRowActivation } from "./row-activation"

const inside = { id: "cell text" }
const portaled = { id: "drawer item" }
const row = { contains: (node: unknown) => node === inside }

function click(selection: { isCollapsed: boolean; anchorNode: unknown } | null, target: unknown = inside) {
  vi.stubGlobal("window", { getSelection: () => selection })
  const open = vi.fn()
  rowActivation<HTMLTableRowElement>(open).onClick({ currentTarget: row, target } as unknown as MouseEvent<HTMLTableRowElement>)
  return open
}

afterEach(() => {
  vi.unstubAllGlobals()
})

function stopClick(target: unknown) {
  const stopPropagation = vi.fn()
  stopRowActivation.onClick({ currentTarget: row, target, stopPropagation } as unknown as MouseEvent)
  return stopPropagation
}

describe("stopRowActivation", () => {
  it("stops clicks on the wrapped control", () => {
    expect(stopClick(inside)).toHaveBeenCalledOnce()
  })

  it("lets clicks from portaled content reach the document", () => {
    expect(stopClick(portaled)).not.toHaveBeenCalled()
  })
})

describe("rowActivation", () => {
  it("opens on a plain click", () => {
    expect(click({ isCollapsed: true, anchorNode: inside })).toHaveBeenCalledOnce()
  })

  it("does not open when the click ends a text selection inside the row", () => {
    expect(click({ isCollapsed: false, anchorNode: inside })).not.toHaveBeenCalled()
  })

  it("ignores clicks that bubble from a menu or drawer outside the row", () => {
    expect(click({ isCollapsed: true, anchorNode: null }, portaled)).not.toHaveBeenCalled()
  })

  it("opens when the selection sits elsewhere on the page", () => {
    expect(click({ isCollapsed: false, anchorNode: { id: "other" } })).toHaveBeenCalledOnce()
  })
})
