import { describe, expect, it, vi } from "vite-plus/test"
import { createChartCursor } from "./chart-cursor"

describe("createChartCursor", () => {
  it("tells listeners about a new bucket once", () => {
    const cursor = createChartCursor()
    const listener = vi.fn()
    cursor.subscribe(listener)
    cursor.set(1000)
    cursor.set(1000)
    expect(cursor.get().bucket).toBe(1000)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("drops the hovered bucket during a drag and ignores hover until it ends", () => {
    const cursor = createChartCursor()
    cursor.set(1000)
    cursor.setDrag({ source: "requests", from: 0, to: 3000 })
    expect(cursor.get().bucket).toBeNull()
    cursor.set(2000)
    expect(cursor.get().bucket).toBeNull()
    cursor.setDrag(null)
    cursor.set(2000)
    expect(cursor.get()).toEqual({ bucket: 2000, drag: null })
  })
})
