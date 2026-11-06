import { describe, expect, it } from "vitest"
import { panToBox, phoneFitPadding, sidePanelWidth, sideVisibleBox } from "@/lib/phone-map-geometry"

const IPHONE = { left: 59, right: 59, bottom: 21 }
const NONE = { left: 0, right: 0, bottom: 0 }

describe("phoneFitPadding", () => {
  it("keeps fitted points clear of the pill and the bar in portrait", () => {
    expect(phoneFitPadding(60, { side: false, insets: NONE, barTop: 84, pillWidth: 54, pillEdge: 20 })).toEqual({
      top: 60,
      right: 134,
      bottom: 156,
      left: 60,
    })
  })

  it("also clears the left cutout on a phone held sideways", () => {
    expect(phoneFitPadding(60, { side: true, insets: IPHONE, barTop: 65, pillWidth: 54, pillEdge: 59 })).toEqual({
      top: 60,
      right: 173,
      bottom: 137,
      left: 119,
    })
  })

  it("ignores the left inset in portrait", () => {
    expect(phoneFitPadding(60, { side: false, insets: IPHONE, barTop: 84, pillWidth: 50, pillEdge: 20 }).left).toBe(60)
  })
})

describe("sidePanelWidth", () => {
  it("takes 45% of the map up to 400px", () => {
    expect(sidePanelWidth(821)).toBe(369)
    expect(sidePanelWidth(1000)).toBe(400)
    expect(sidePanelWidth(667)).toBe(300)
  })
})

describe("sideVisibleBox", () => {
  it("is the map left of the panel, below the top inset and above the bottom inset", () => {
    expect(
      sideVisibleBox({ mapWidth: 821, mapHeight: 367, panelLeft: 393, topInset: 72, leftInset: 0, bottomInset: 21, margin: 24 }),
    ).toEqual({ left: 24, right: 369, top: 72, bottom: 322 })
  })

  it("keeps the point clear of a left cutout", () => {
    expect(
      sideVisibleBox({ mapWidth: 932, mapHeight: 382, panelLeft: 473, topInset: 24, leftInset: 59, bottomInset: 21, margin: 24 }).left,
    ).toBe(83)
  })
})

describe("panToBox", () => {
  const box = { left: 24, right: 369, top: 72, bottom: 322 }

  it("leaves a point inside the box alone", () => {
    expect(panToBox({ x: 200, y: 200 }, box)).toEqual({ dx: 0, dy: 0 })
  })

  it("centres a point that is outside on one axis", () => {
    expect(panToBox({ x: 600, y: 200 }, box)).toEqual({ dx: 600 - (24 + 369) / 2, dy: 0 })
  })

  it("centres a point that is outside on both axes", () => {
    expect(panToBox({ x: 0, y: 340 }, box)).toEqual({ dx: 0 - (24 + 369) / 2, dy: 340 - (72 + 322) / 2 })
  })
})
