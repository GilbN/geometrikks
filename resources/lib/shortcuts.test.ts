import { describe, expect, it } from "vite-plus/test"
import {
  SHORTCUTS,
  isPaletteKey,
  keyLabel,
  matchKey,
  shortcutKeyLabels,
  type KeyInput,
} from "@/lib/shortcuts"

const press = (key: string, extra: Partial<KeyInput> = {}): KeyInput => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  repeat: false,
  ...extra,
})

function matched(key: string, prefix: string | null = null, extra: Partial<KeyInput> = {}) {
  const result = matchKey(press(key, extra), prefix)
  return result.kind === "match" ? result.shortcut.id : result.kind
}

describe("matchKey", () => {
  it("matches single keys", () => {
    expect(matched("t")).toBe("time-range")
    expect(matched("/")).toBe("focus-filter")
    expect(matched("?", null, {})).toBe("cheat-sheet")
    expect(matched("j")).toBe("row-next")
    expect(matched("ArrowRight")).toBe("page-next")
  })

  it("reads letters the same with Caps Lock on", () => {
    expect(matched("T")).toBe("time-range")
  })

  it("waits for the second key of a go-to sequence", () => {
    expect(matchKey(press("g"), null)).toEqual({ kind: "pending", prefix: "g" })
    expect(matched("a", "g")).toBe("go-access-logs")
    expect(matched("g", "g")).toBe("go-geo-logs")
    expect(matched(",", "g")).toBe("go-settings")
    expect(matched("d", "g")).toBe("go-debug-logs")
  })

  it("keeps waiting while the first key of a sequence is held", () => {
    expect(matchKey(press("g", { repeat: true }), "g")).toEqual({ kind: "waiting" })
    expect(matched("a", "g")).toBe("go-access-logs")
  })

  it("keeps waiting when Shift goes down between the two keys", () => {
    expect(matchKey(press("Shift"), "g")).toEqual({ kind: "waiting" })
    expect(matchKey(press("Shift"), null)).toEqual({ kind: "none" })
  })

  it("keeps waiting through a bare Ctrl or Alt press", () => {
    expect(matchKey(press("Control", { ctrlKey: true }), "g")).toEqual({ kind: "waiting" })
    expect(matchKey(press("Alt", { altKey: true }), "g")).toEqual({ kind: "waiting" })
  })

  it("reads letters by position on a non-Latin layout", () => {
    expect(matched("о", null, { code: "KeyJ" })).toBe("row-next")
    expect(matched("ע", null, { code: "KeyG" })).toBe("pending")
    expect(matched("п", "g", { code: "KeyA" })).toBe("go-access-logs")
  })

  it("drops a sequence with an unknown second key", () => {
    expect(matched("x", "g")).toBe("none")
    expect(matched("t", "g")).toBe("none")
  })

  it("leaves keys held with Ctrl, Cmd or Alt to the browser", () => {
    expect(matched("b", null, { ctrlKey: true })).toBe("none")
    expect(matched("k", null, { metaKey: true })).toBe("none")
    expect(matched("t", null, { altKey: true })).toBe("none")
  })

  it("repeats only the moving keys while held", () => {
    expect(matched("j", null, { repeat: true })).toBe("row-next")
    expect(matched("ArrowLeft", null, { repeat: true })).toBe("page-previous")
    expect(matched("r", null, { repeat: true })).toBe("none")
    expect(matched("g", null, { repeat: true })).toBe("none")
  })

  it("never binds Enter itself, which the rows handle", () => {
    expect(matched("Enter")).toBe("none")
  })
})

describe("labels", () => {
  it("prints keys the way the cheat sheet shows them", () => {
    expect(keyLabel("g")).toBe("G")
    expect(keyLabel("Enter")).toBe("↵")
    expect(keyLabel(",")).toBe(",")
    const sidebar = SHORTCUTS.find((shortcut) => shortcut.id === "toggle-sidebar")!
    expect(shortcutKeyLabels(sidebar, false)).toEqual(["Ctrl", "B"])
    expect(shortcutKeyLabels(sidebar, true)).toEqual(["⌘", "B"])
  })

  it("has one binding per key", () => {
    const bound = SHORTCUTS.filter((shortcut) => !shortcut.external).map(
      (shortcut) => `${shortcut.mod ? "mod+" : ""}${shortcut.keys.join(" ")}`,
    )
    expect(new Set(bound).size).toBe(bound.length)
  })
})

describe("isPaletteKey", () => {
  it("takes Ctrl+K off a Mac and Cmd+K on one", () => {
    expect(isPaletteKey(press("k", { ctrlKey: true }), false)).toBe(true)
    expect(isPaletteKey(press("k", { metaKey: true }), false)).toBe(false)
    expect(isPaletteKey(press("k", { metaKey: true }), true)).toBe(true)
    expect(isPaletteKey(press("k", { ctrlKey: true }), true)).toBe(false)
  })

  it("follows the key's position only on a non-Latin layout", () => {
    expect(isPaletteKey(press("л", { ctrlKey: true, code: "KeyK" }), false)).toBe(true)
    expect(isPaletteKey(press("e", { ctrlKey: true, code: "KeyK" }), false)).toBe(false)
    expect(isPaletteKey(press("î", { ctrlKey: true, code: "KeyK" }), false)).toBe(false)
  })
})
