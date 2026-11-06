import { describe, expect, it } from "vitest"
import { isKeyboardOpen, isPortraitList } from "./phone-layout"

describe("isPortraitList", () => {
  it("is the narrow portrait case only", () => {
    expect(isPortraitList(true, false)).toBe(true)
    expect(isPortraitList(true, true)).toBe(false) // a 667x375 SE held sideways gets chips
    expect(isPortraitList(false, false)).toBe(false)
  })
})

describe("isKeyboardOpen", () => {
  const base = { focusedEditable: true, scale: 1, viewportHeight: 400, innerHeight: 852 }
  it("opens with focus, no zoom and a shrunk viewport", () => expect(isKeyboardOpen(base)).toBe(true))
  it("ignores a pinch zoom", () => expect(isKeyboardOpen({ ...base, scale: 1.6 })).toBe(false))
  it("needs an editable element focused", () => expect(isKeyboardOpen({ ...base, focusedEditable: false })).toBe(false))
  it("ignores small shrinks such as the URL bar", () => expect(isKeyboardOpen({ ...base, viewportHeight: 760 })).toBe(false))
})
