import { describe, expect, it } from "vitest"
import { formatBytes } from "./api"

describe("formatBytes", () => {
  it("names units past terabytes, which log ceilings reach", () => {
    expect(formatBytes(1.5 * 1024 ** 4)).toBe("1.5 TB")
    expect(formatBytes(1024 ** 5)).toBe("1.0 PB")
    expect(formatBytes(1024 ** 6)).toBe("1.0 EB")
  })
})
