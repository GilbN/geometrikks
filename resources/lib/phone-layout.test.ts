import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { PHONE_QUERY, PHONE_SIDE_QUERY } from "@/hooks/use-phone-map"
import { drawerLayout, isKeyboardOpen, isPortraitList, settleDrawerLayout } from "./phone-layout"

describe("isPortraitList", () => {
  it("is the narrow portrait case only", () => {
    expect(isPortraitList(true, false)).toBe(true)
    expect(isPortraitList(true, true)).toBe(false) // a 667x375 SE held sideways gets chips
    expect(isPortraitList(false, false)).toBe(false)
    expect(isPortraitList(false, true)).toBe(false)
  })
})

describe("isKeyboardOpen", () => {
  const base = { focusedEditable: true, scale: 1, viewportHeight: 400, innerHeight: 852 }
  it("opens with focus, no zoom and a shrunk viewport", () => expect(isKeyboardOpen(base)).toBe(true))
  it("ignores a pinch zoom", () => expect(isKeyboardOpen({ ...base, scale: 1.6 })).toBe(false))
  it("needs an editable element focused", () => expect(isKeyboardOpen({ ...base, focusedEditable: false })).toBe(false))
  it("needs a shrink of more than 120px", () => {
    expect(isKeyboardOpen({ ...base, viewportHeight: base.innerHeight - 120 })).toBe(false)
    expect(isKeyboardOpen({ ...base, viewportHeight: base.innerHeight - 121 })).toBe(true)
  })
  it("treats a scale within 0.01 of 1 as unzoomed", () => {
    expect(isKeyboardOpen({ ...base, scale: 1.005 })).toBe(true)
    expect(isKeyboardOpen({ ...base, scale: 1.02 })).toBe(false)
  })
  it("ignores small shrinks such as the URL bar", () => expect(isKeyboardOpen({ ...base, viewportHeight: 760 })).toBe(false))
})

describe("main.css phone variants", () => {
  const css = readFileSync(new URL("../main.css", import.meta.url), "utf8")
  const variantBody = (name: string) => {
    const match = css.match(new RegExp(`@custom-variant ${name} \\((.*)\\);`))
    if (!match) throw new Error(`missing @custom-variant ${name}`)
    return match[1]
  }

  it("phone is the portrait query plus the side query", () => {
    expect(variantBody("phone")).toBe(`@media ${PHONE_QUERY.split(", ").join(", @media ")}`)
  })
  it("phone-side is the side query", () => {
    expect(variantBody("phone-side")).toBe(`@media ${PHONE_SIDE_QUERY}`)
  })
  it("phone-short narrows the side query to 22rem", () => {
    expect(variantBody("phone-short")).toBe(`@media ${PHONE_SIDE_QUERY.replace("(height < 30rem)", "(height < 22rem)")}`)
  })
})

describe("main.css app height", () => {
  const css = readFileSync(new URL("../main.css", import.meta.url), "utf8")
  const standaloneRules = css.slice(css.indexOf("@media (display-mode: standalone)"), css.indexOf("/* Later blocks win"))

  it("is the dynamic viewport by default", () => expect(css).toMatch(/:root \{[^}]*--app-height: 100dvh;/))
  it("is the large viewport in an installed app", () => {
    expect(standaloneRules).toMatch(/:root \{\s*--app-height: 100lvh;/)
  })
  it("gives the document the full height in an installed app", () => {
    expect(standaloneRules).toMatch(/html,\s*body,\s*#app \{\s*height: var\(--app-height\);/)
  })
})

describe("drawerLayout", () => {
  it("is the desktop version off a phone, whatever the side query says", () => {
    expect(drawerLayout(false, false)).toBe("desktop")
    expect(drawerLayout(false, true)).toBe("desktop")
  })
  it("opens from the bottom in portrait and from the right held sideways", () => {
    expect(drawerLayout(true, false)).toBe("bottom")
    expect(drawerLayout(true, true)).toBe("right")
  })
})

describe("settleDrawerLayout", () => {
  it("follows the viewport while closed", () => {
    expect(settleDrawerLayout("right", "bottom", "closed", false)).toEqual({ layout: "right", turned: false })
    expect(settleDrawerLayout("right", "bottom", "closed", true)).toEqual({ layout: "right", turned: false })
  })
  it("stays put while open in an unchanged layout", () => {
    expect(settleDrawerLayout("bottom", "bottom", "open", false)).toEqual({ layout: "bottom", turned: false })
  })
  it("turns an open drawer rotated to another side", () => {
    expect(settleDrawerLayout("right", "bottom", "open", false)).toEqual({ layout: "right", turned: true })
    expect(settleDrawerLayout("bottom", "right", "open", false)).toEqual({ layout: "bottom", turned: true })
  })
  it("turns an open overlay that crosses between phone and desktop", () => {
    expect(settleDrawerLayout("desktop", "bottom", "open", false)).toEqual({ layout: "desktop", turned: true })
    expect(settleDrawerLayout("right", "desktop", "open", false)).toEqual({ layout: "right", turned: true })
  })
  it("keeps the opening layout when asked to", () => {
    expect(settleDrawerLayout("right", "bottom", "open", true)).toEqual({ layout: "bottom", turned: false })
    expect(settleDrawerLayout("desktop", "right", "open", true)).toEqual({ layout: "right", turned: false })
  })
  it("slides a closing drawer out in the layout it opened in", () => {
    expect(settleDrawerLayout("right", "bottom", "closing", false)).toEqual({ layout: "bottom", turned: false })
    expect(settleDrawerLayout("bottom", "right", "closing", true)).toEqual({ layout: "right", turned: false })
    expect(settleDrawerLayout("bottom", "bottom", "closing", false)).toEqual({ layout: "bottom", turned: false })
  })
})
