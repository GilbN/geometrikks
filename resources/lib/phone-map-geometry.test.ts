import { describe, expect, it } from "vitest"
import { panToBox, sideFitPadding, sidePanelWidth, sideToastArea, sideVisibleBox } from "@/lib/phone-map-geometry"

const IPHONE = { left: 59, right: 59, bottom: 21 }
const NONE = { left: 0, right: 0, bottom: 0 }

describe("sideFitPadding", () => {
  it("keeps fitted points clear of the rail and the bottom inset", () => {
    expect(sideFitPadding(60, IPHONE)).toEqual({ top: 60, right: 195, bottom: 81, left: 60 })
  })

  it("uses the rail's 12px edge when there is no inset", () => {
    expect(sideFitPadding(60, NONE).right).toBe(148)
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
      sideVisibleBox({ mapWidth: 821, mapHeight: 367, panelLeft: 393, topInset: 72, bottomInset: 21, margin: 24 }),
    ).toEqual({ left: 24, right: 369, top: 72, bottom: 322 })
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

describe("sideToastArea", () => {
  const map = { viewportWidth: 932, mapLeft: 111, mapRight: 932, insets: IPHONE }

  it("sits between the attribution pill and the rail", () => {
    expect(sideToastArea({ ...map, panelOpen: false })).toEqual({ left: 159, right: 147 })
  })

  it("stops short of an open panel", () => {
    expect(sideToastArea({ ...map, panelOpen: true })).toEqual({ left: 159, right: 440 })
  })
})
