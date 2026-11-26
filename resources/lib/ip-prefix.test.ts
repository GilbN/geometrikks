import { describe, expect, it } from "vite-plus/test"
import { ipv4InCidr, parseIpQuery } from "@/lib/ip-prefix"

describe("parseIpQuery, IPv4", () => {
  it("waits for a whole first octet and its dot", () => {
    expect(parseIpQuery("1")).toBeNull()
    expect(parseIpQuery("45")).toBeNull()
    expect(parseIpQuery("45.")).toMatchObject({ ranges: ["45.0.0.0/8"], cidr: "45.0.0.0/8" })
  })

  it("turns a partial octet into the ranges that start with it", () => {
    expect(parseIpQuery("203.0.11")?.ranges).toEqual([
      "203.0.11.0/24",
      "203.0.110.0/23",
      "203.0.112.0/21",
    ])
    expect(parseIpQuery("203.0.11")?.cidr).toBeNull()
  })

  it("names a two-octet prefix as one range", () => {
    expect(parseIpQuery("198.51")).toMatchObject({
      ranges: ["198.51.0.0/16"],
      cidr: "198.51.0.0/16",
    })
  })

  it("never needs more than nine ranges", () => {
    for (let first = 0; first < 256; first += 17) {
      for (const second of ["1", "2", "25", "10", "9"]) {
        expect(parseIpQuery(`${first}.${second}`)!.ranges.length).toBeLessThanOrEqual(9)
      }
    }
  })

  it("knows a whole address, and still matches longer ones", () => {
    const query = parseIpQuery("198.51.100.1")
    expect(query?.address).toBe("198.51.100.1")
    expect(query?.ranges).toContain("198.51.100.1/32")
    expect(query?.ranges).toContain("198.51.100.10/31")
  })

  it("rejects what can't be an address", () => {
    expect(parseIpQuery("256.1")).toBeNull()
    expect(parseIpQuery("1..2")).toBeNull()
    expect(parseIpQuery("01.2")).toBeNull()
    expect(parseIpQuery("1.2.3.4.5")).toBeNull()
    expect(parseIpQuery("example.com")).toBeNull()
  })
})

describe("parseIpQuery, IPv6", () => {
  it("waits for a whole first group and its colon", () => {
    expect(parseIpQuery("2001")).toBeNull()
    expect(parseIpQuery("2001:")).toMatchObject({ ranges: ["2001:0:0:0:0:0:0:0/16"] })
  })

  it("turns a partial group into aligned blocks", () => {
    expect(parseIpQuery("2001:db8:a")?.ranges).toEqual([
      "2001:db8:a000:0:0:0:0:0/36",
      "2001:db8:a00:0:0:0:0:0/40",
      "2001:db8:a0:0:0:0:0:0/44",
      "2001:db8:a:0:0:0:0:0/48",
    ])
  })

  it("takes an address with a dotted IPv4 tail as itself", () => {
    expect(parseIpQuery("0:0:0:0:0:ffff:192.0.2.1")?.address).toBe("192.0.2.1")
  })

  it("reads a leading zero as written, not as a shorter group", () => {
    expect(parseIpQuery("2001:0")?.ranges).toEqual(["2001:0:0:0:0:0:0:0/32"])
    expect(parseIpQuery("2001:0d")?.ranges).toEqual(["2001:d00:0:0:0:0:0:0/24"])
  })

  it("leaves IPv4-mapped prefixes to the IPv4 search, and maps a whole one", () => {
    expect(parseIpQuery("0:0:0:0:0:ffff:")).toBeNull()
    expect(parseIpQuery("::ffff:198.51.100.7")).toMatchObject({
      ranges: ["198.51.100.7/32"],
      address: "198.51.100.7",
    })
  })

  it("maps an expanded IPv4-mapped address and refuses mapped prefixes", () => {
    expect(parseIpQuery("0:0:0:0:0:ffff:c633:6407")?.address).toBe("198.51.100.7")
    expect(parseIpQuery("0:0:0:0:0:ffff")).toBeNull()
    expect(parseIpQuery("0:0:0:0:0:f")).toBeNull()
  })

  it("keeps the exact address when the last group is padded", () => {
    const ranges = parseIpQuery("2001:db8:1:2:3:4:5:0d")?.ranges
    expect(ranges).toContain("2001:db8:1:2:3:4:5:d/128")
    expect(ranges).toContain("2001:db8:1:2:3:4:5:d00/120")
  })

  it("writes a whole address the way the server does", () => {
    expect(parseIpQuery("2001:db8:0:0:0:0:0:1")?.address).toBe("2001:db8::1")
    expect(parseIpQuery("::1]/foo")).toBeNull()
  })

  it("matches an address written with :: only as itself", () => {
    expect(parseIpQuery("2001:db8::1")).toMatchObject({
      ranges: ["2001:db8::1/128"],
      address: "2001:db8::1",
    })
  })
})

describe("ipv4InCidr", () => {
  it("tells whether an address sits in a range", () => {
    expect(ipv4InCidr("198.51.100.14", "198.51.100.0/24")).toBe(true)
    expect(ipv4InCidr("198.51.101.14", "198.51.100.0/24")).toBe(false)
    expect(ipv4InCidr("2001:db8::1", "198.51.100.0/24")).toBe(false)
  })
})
