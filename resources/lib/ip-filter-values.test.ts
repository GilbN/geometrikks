import { describe, expect, it } from "vite-plus/test"

import { ipFilterHint, isValidIpFilter } from "@/lib/ip-filter-values"

describe("isValidIpFilter", () => {
  it("accepts addresses and ranges that start on their network address", () => {
    for (const value of [
      "203.0.113.7",
      "2001:db8::1",
      "203.0.113.0/24",
      "10.0.0.1/32",
      "2001:db8:1:2::/64",
      "2001:DB8:0001:0002::/64",
      "::ffff:203.0.113.0/120",
      "0.0.0.0/0",
      "::/0",
      "203.0.113.0/024",
    ]) {
      expect(isValidIpFilter(value), value).toBe(true)
    }
  })

  it("rejects host bits, partial values and bad prefixes", () => {
    for (const value of [
      "203.0.113.9/24",
      "2001:db8:1:2::5/64",
      "203.0.113",
      "203.0.113.0/",
      "203.0.113.0/33",
      "example.com",
    ]) {
      expect(isValidIpFilter(value), value).toBe(false)
    }
  })
})

describe("ipFilterHint", () => {
  it("names the range a host-bits value belongs to", () => {
    expect(ipFilterHint("203.0.113.9/24")).toBe("Use 203.0.113.0/24")
    expect(ipFilterHint("2600:1700:abcd:1234:5678:9abc:def0:1234/64")).toBe(
      "Use 2600:1700:abcd:1234::/64",
    )
    expect(ipFilterHint("2001:db8:0:0:1::1/80")).toBe("Use 2001:db8:0:0:1::/80")
    expect(ipFilterHint("2001:db8:0:0:1::1/64")).toBe("Use 2001:db8::/64")
    expect(ipFilterHint("::ffff:198.51.100.9/120")).toBe("Use 198.51.100.0/24")
    expect(ipFilterHint("10.0.0.1/0")).toBe("Use 0.0.0.0/0")
  })

  it("stays quiet for valid values and for text that is no range", () => {
    for (const value of ["203.0.113.0/24", "2001:DB8::/64", "203.0.113.7", "203.0.113", "nope/8"]) {
      expect(ipFilterHint(value), value).toBeNull()
    }
  })
})
