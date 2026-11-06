import { describe, expect, it, vi } from "vitest"
import { createMemoryHistory } from "@tanstack/react-router"
import { createOverlayHistory, overlayCloseAction, overlaysAbove, planOverlaySteps } from "./overlay-history"

describe("overlayCloseAction", () => {
  it("goes back when the overlay owns the current entry", () => {
    expect(overlayCloseAction("panel", "panel")).toBe("back")
  })

  it("leaves history alone when another overlay owns the entry", () => {
    expect(overlayCloseAction("inspector", "panel")).toBe("none")
  })

  it("leaves history alone on a plain entry", () => {
    expect(overlayCloseAction(undefined, "panel")).toBe("none")
  })
})

describe("planOverlaySteps", () => {
  it("goes back when the top overlay closes", () => {
    expect(planOverlaySteps("more", ["more"], [])).toEqual([{ type: "back" }])
  })

  it("reuses the entry when the top overlay hands over to another", () => {
    expect(planOverlaySteps("feed", ["feed"], ["detail"])).toEqual([{ type: "replace", overlay: "detail" }])
  })

  it("pushes an entry per opened overlay", () => {
    expect(planOverlaySteps(undefined, [], ["layers", "detail"])).toEqual([
      { type: "push", overlay: "layers" },
      { type: "push", overlay: "detail" },
    ])
  })

  it("does nothing when a lower overlay closes", () => {
    expect(planOverlaySteps("inspector", ["layers"], [])).toEqual([])
  })
})

describe("overlaysAbove", () => {
  it("lists the overlays opened after the entry's", () => {
    expect(overlaysAbove(["layers", "detail", "inspector"], "layers")).toEqual(["detail", "inspector"])
  })

  it("lists every overlay for a plain or unknown entry", () => {
    expect(overlaysAbove(["layers", "detail"], undefined)).toEqual(["layers", "detail"])
    expect(overlaysAbove(["layers"], "more")).toEqual(["layers"])
  })
})

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function setup(initialEntries = ["/map"]) {
  const history = createMemoryHistory({ initialEntries })
  const overlays = createOverlayHistory(history)
  overlays.setActive(true)
  const stop = overlays.start()
  const entry = (id: string, adopt = false) => {
    const close = vi.fn(() => overlays.closed(id))
    overlays.register(id, adopt, close)
    return close
  }
  return { history, overlays, stop, entry }
}

describe("createOverlayHistory", () => {
  it("pushes the same href for an opened overlay and goes back when it closes", async () => {
    const { history, overlays, entry } = setup(["/", "/map?layer=x"])
    entry("more")
    overlays.opened("more")
    await settle()
    expect(history.location.href).toBe("/map?layer=x")
    expect(history.location.state.overlay).toBe("more")
    expect(history.location.state.__TSR_index).toBe(2)

    overlays.closed("more")
    await settle()
    expect(history.location.state.__TSR_index).toBe(1)
    expect(history.location.state.overlay).toBeUndefined()
  })

  it("closes the top overlay on Back, one per entry", async () => {
    const { history, overlays, entry } = setup()
    const closeLayers = entry("layers")
    const closeDetail = entry("detail")
    overlays.opened("layers")
    await settle()
    overlays.opened("detail")
    await settle()

    history.back()
    await settle()
    expect(closeDetail).toHaveBeenCalledOnce()
    expect(closeLayers).not.toHaveBeenCalled()
    expect(history.location.state.overlay).toBe("layers")

    history.back()
    await settle()
    expect(closeLayers).toHaveBeenCalledOnce()
    expect(history.location.state.__TSR_index).toBe(0)
  })

  it("replaces the entry when one overlay hands over to another", async () => {
    const { history, overlays, entry } = setup()
    entry("feed")
    entry("detail")
    overlays.opened("feed")
    await settle()
    overlays.closed("feed")
    overlays.opened("detail")
    await settle()
    expect(history.location.state.__TSR_index).toBe(1)
    expect(history.location.state.overlay).toBe("detail")
  })

  it("pushes nothing for an adopted overlay and never closes it on a pop", async () => {
    const { history, overlays, entry } = setup()
    const closeDetail = entry("detail")
    const closeInspector = entry("inspector", true)
    overlays.opened("detail")
    await settle()
    history.push("/map?inspect=1.2.3.4", { overlay: "inspector" })
    overlays.opened("inspector")
    await settle()
    expect(history.location.state.__TSR_index).toBe(2)

    history.back()
    await settle()
    expect(closeInspector).not.toHaveBeenCalled()
    expect(closeDetail).not.toHaveBeenCalled()
  })

  it("lets an adopted overlay go back only from its own entry", async () => {
    const { history, overlays, entry } = setup(["/", "/map"])
    entry("inspector", true)
    expect(overlays.backFrom("inspector")).toBe(false)

    history.push("/map?inspect=1.2.3.4", { overlay: "inspector" })
    expect(overlays.backFrom("inspector")).toBe(true)
    await settle()
    expect(history.location.state.__TSR_index).toBe(1)
  })

  it("skips the entry of a lower overlay that closed under an open one", async () => {
    const { history, overlays, entry } = setup(["/", "/map"])
    entry("layers")
    entry("detail")
    overlays.opened("layers")
    await settle()
    overlays.opened("detail")
    await settle()
    overlays.closed("layers")
    await settle()
    expect(history.location.state.overlay).toBe("detail")

    history.back()
    await settle()
    expect(history.location.state.__TSR_index).toBe(1)
    expect(history.location.href).toBe("/map")
  })

  it("replaces a closed overlay's entry with a plain one on Forward", async () => {
    const { history, overlays, entry } = setup()
    entry("more")
    overlays.opened("more")
    await settle()
    history.back()
    await settle()

    history.forward()
    await settle()
    expect(history.location.state.__TSR_index).toBe(1)
    expect(history.location.state.overlay).toBeUndefined()
  })

  it("replaces a stale overlay entry on start", () => {
    const history = createMemoryHistory({ initialEntries: ["/map"] })
    history.replace("/map", { overlay: "more" })
    const overlays = createOverlayHistory(history)
    overlays.start()
    expect(history.location.state.overlay).toBeUndefined()
    expect(history.location.href).toBe("/map")
  })

  it("keeps the overlay's entry and its URL when the page replaces it", async () => {
    const { history, overlays, entry } = setup()
    const closeLayers = entry("layers")
    overlays.opened("layers")
    await settle()
    history.replace("/map?country=NO", {})
    await settle()
    expect(history.location.state.overlay).toBe("layers")

    history.back()
    await settle()
    expect(closeLayers).toHaveBeenCalledOnce()
    expect(history.location.state.__TSR_index).toBe(0)
    expect(history.location.href).toBe("/map?country=NO")
  })

  it("does nothing while inactive", async () => {
    const { history, overlays, entry } = setup()
    overlays.setActive(false)
    entry("more")
    overlays.opened("more")
    await settle()
    expect(history.location.state.__TSR_index).toBe(0)
    expect(overlays.backFrom("more")).toBe(false)
  })
})
