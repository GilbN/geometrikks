import { describe, expect, it } from "vitest"
import { phoneToastPlacement, toastTopEdge } from "./phone-toasts"

const base = { side: false, onMap: false, covered: false, barSide: 20, leftInset: 0, rightInset: 0, topEdge: 56 }

describe("phoneToastPlacement", () => {
  it("spans the bar's width above it in portrait", () => {
    const placement = phoneToastPlacement(base)
    expect(placement.position).toBe("bottom-center")
    expect(placement.offset).toEqual({ bottom: "var(--tab-bar-clear)", left: "20px", right: "20px" })
  })

  it("stops short of the map pill in portrait", () => {
    const placement = phoneToastPlacement({ ...base, onMap: true })
    expect(placement.offset).toEqual({ bottom: "var(--tab-bar-clear)", left: "20px", right: "82px" })
  })

  it("clears a right safe area wider than the bar's margin on the map", () => {
    const placement = phoneToastPlacement({ ...base, onMap: true, rightInset: 30 })
    expect(placement.offset.right).toBe("92px")
  })

  it("centres above the bar held sideways", () => {
    const placement = phoneToastPlacement({ ...base, side: true, onMap: true })
    expect(placement.position).toBe("bottom-center")
    expect(placement.offset).toEqual({ bottom: "var(--tab-bar-clear)" })
  })

  it("moves to the top while a surface covers the bottom", () => {
    for (const side of [false, true]) {
      const placement = phoneToastPlacement({ ...base, side, onMap: true, covered: true })
      expect(placement.position).toBe("top-center")
      expect(placement.offset).toEqual({ top: "64px", left: "20px", right: "20px" })
    }
  })

  it("keeps covered toasts clear of the notch held sideways", () => {
    const placement = phoneToastPlacement({ ...base, side: true, covered: true, leftInset: 59, rightInset: 59 })
    expect(placement.offset).toEqual({ top: "64px", left: "59px", right: "59px" })
  })

  it("keeps covered toasts on the bar's margins in portrait", () => {
    const placement = phoneToastPlacement({ ...base, covered: true, leftInset: 0, rightInset: 0 })
    expect(placement.offset).toEqual({ top: "64px", left: "20px", right: "20px" })
  })

  it("gives spanning and centred placements different classes", () => {
    expect(phoneToastPlacement(base).className).not.toBe(phoneToastPlacement({ ...base, side: true }).className)
    expect(phoneToastPlacement({ ...base, covered: true }).className).toBe(phoneToastPlacement(base).className)
  })
})

describe("toastTopEdge", () => {
  const edges = { shellBottom: 0, chipBottom: 115, mapTopInset: 59 }

  it("is the header's bottom off the map", () => {
    expect(toastTopEdge({ ...edges, onMap: false, chipShown: false, shellBottom: 115 })).toBe(115)
  })

  it("is the range chip's bottom on the map", () => {
    expect(toastTopEdge({ ...edges, onMap: true, chipShown: true })).toBe(115)
  })

  it("is the top safe area while the chip hides", () => {
    expect(toastTopEdge({ ...edges, onMap: true, chipShown: false })).toBe(59)
  })

  it("starts under a banner above the map", () => {
    expect(toastTopEdge({ onMap: true, chipShown: true, shellBottom: 89, chipBottom: 56, mapTopInset: 0 })).toBe(145)
    expect(toastTopEdge({ onMap: true, chipShown: false, shellBottom: 89, chipBottom: 56, mapTopInset: 0 })).toBe(89)
  })
})
