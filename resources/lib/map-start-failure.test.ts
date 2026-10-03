import { describe, expect, it } from "vitest"
import { mapStartFailure } from "./map-start-failure"

function gpuError(statusMessage: string | null) {
  return Object.assign(new Error("WebGL2 is required to display this map."), {
    name: "GPUInitializationError",
    statusMessage,
  })
}

const map = {}

describe("mapStartFailure", () => {
  it("explains a WebGL2 failure from the constructor", () => {
    const failure = mapStartFailure({ error: gpuError(null), target: null })
    expect(failure?.title).toBe("Your browser could not start WebGL2")
    expect(failure?.detail).toBe(
      "The map needs WebGL2 to draw. Try another browser or device, or check that graphics acceleration is available.",
    )
  })

  it("passes on what the browser said about the context", () => {
    const status = "WebGL creation failed: * AllowWebgl2:false restricts context creation on this system"
    const failure = mapStartFailure({ error: gpuError(status), target: null })
    expect(failure?.detail).toBe(
      `The map needs WebGL2 to draw. Try another browser or device, or check that graphics acceleration is available. Browser message: ${status}`,
    )
  })

  it("explains a WebGL2 failure when a lost context cannot be restored", () => {
    const failure = mapStartFailure({ error: gpuError(null), target: map })
    expect(failure?.title).toMatch(/WebGL2/)
  })

  it("reports any other constructor failure with its message", () => {
    const failure = mapStartFailure({ error: new Error("Invalid mapLib"), target: null })
    expect(failure).toEqual({ title: "The map could not start", detail: "Invalid mapLib" })
  })

  it("ignores errors from a map that is already running", () => {
    expect(mapStartFailure({ error: new Error("Failed to fetch tile"), target: map })).toBeNull()
  })
})
