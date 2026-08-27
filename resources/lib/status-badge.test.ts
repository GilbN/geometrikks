import { describe, expect, it } from "vitest"
import { statusBadgeClass } from "./status-badge"

describe("statusBadgeClass", () => {
  it("maps 2xx to the emerald chip", () => {
    expect(statusBadgeClass(200)).toBe("bg-emerald-500/15 text-emerald-600 dark:text-emerald-400")
  })
  it("maps 3xx to the sky chip", () => {
    expect(statusBadgeClass(304)).toBe("bg-sky-500/15 text-sky-600 dark:text-sky-400")
  })
  it("maps 4xx to the amber chip", () => {
    expect(statusBadgeClass(404)).toBe("bg-amber-500/15 text-amber-600 dark:text-amber-400")
  })
  it("maps 5xx to the red chip, from the boundary up", () => {
    expect(statusBadgeClass(500)).toBe("bg-red-500/15 text-red-600 dark:text-red-400")
    expect(statusBadgeClass(502)).toBe("bg-red-500/15 text-red-600 dark:text-red-400")
  })
})
