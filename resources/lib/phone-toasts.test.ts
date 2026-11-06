import { describe, expect, it } from "vitest"
import { phoneToastPlacement } from "./phone-toasts"

const base = { side: false, onMap: false, covered: false, barSide: 20, rightInset: 0, headerBottom: 56 }

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

  it("moves under the header while a surface covers the bottom", () => {
    for (const side of [false, true]) {
      const placement = phoneToastPlacement({ ...base, side, onMap: true, covered: true })
      expect(placement.position).toBe("top-center")
      expect(placement.offset).toEqual({ top: "64px", left: "20px", right: "20px" })
    }
  })

  it("gives spanning and centred placements different classes", () => {
    expect(phoneToastPlacement(base).className).not.toBe(phoneToastPlacement({ ...base, side: true }).className)
    expect(phoneToastPlacement({ ...base, covered: true }).className).toBe(phoneToastPlacement(base).className)
  })
})
