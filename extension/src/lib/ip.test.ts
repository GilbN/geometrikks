import { describe, expect, it } from "vite-plus/test"
import { parseSingleIp } from "./ip"

describe("parseSingleIp", () => {
  it("trims an IPv4 address", () => {
    expect(parseSingleIp("  45.148.10.82 ")).toBe("45.148.10.82")
  })

  it("refuses ranges, partial and zero-padded addresses, and other text", () => {
    for (const text of [
      "45.148.10.0/24",
      "45.148.10",
      "045.148.10.82",
      "hello",
      "",
      "1.2.3.4 5.6.7.8",
    ])
      expect(parseSingleIp(text)).toBeNull()
  })

  it("canonicalizes IPv6", () => {
    expect(parseSingleIp("2001:DB8:0:0:0:0:0:1")).toBe("2001:db8::1")
    expect(parseSingleIp(" ::1\n")).toBe("::1")
  })

  it("keeps the dotted IPv4 tail of an IPv4-mapped address", () => {
    expect(parseSingleIp("::ffff:1.2.3.4")).toBe("::ffff:1.2.3.4")
    expect(parseSingleIp("::FFFF:102:304")).toBe("::ffff:1.2.3.4")
    expect(parseSingleIp("0:0:0:0:0:ffff:203.0.113.255")).toBe("::ffff:203.0.113.255")
  })

  it("refuses IPv6 ranges, brackets and zone IDs", () => {
    for (const text of ["2001:db8::/32", "[2001:db8::1]", "fe80::1%eth0", "2001:db8::1::2"])
      expect(parseSingleIp(text)).toBeNull()
  })
})
