import { describe, expect, it } from "vite-plus/test"
import { parseIpQuery } from "@/lib/ip-prefix"

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

  it("matches an address written with :: only as itself", () => {
    expect(parseIpQuery("2001:db8::1")).toMatchObject({
      ranges: ["2001:db8::1/128"],
      address: "2001:db8::1",
    })
  })
})
