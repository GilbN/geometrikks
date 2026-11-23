import { describe, expect, it } from "vite-plus/test"
import { formatBytes } from "./api"

describe("formatBytes", () => {
  it("names units past terabytes, which log ceilings reach", () => {
    expect(formatBytes(1.5 * 1024 ** 4)).toBe("1.5 TB")
    expect(formatBytes(1024 ** 5)).toBe("1.0 PB")
    expect(formatBytes(1024 ** 6)).toBe("1.0 EB")
  })

  it("counts whole bytes below a kilobyte", () => {
    expect(formatBytes(455)).toBe("455 B")
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(1536)).toBe("1.5 KB")
    expect(formatBytes(454.54545)).toBe("455 B")
  })
})
