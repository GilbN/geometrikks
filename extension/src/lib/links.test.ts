import { describe, expect, it } from "vite-plus/test"
import { analyticsUrl, inspectorUrl } from "./links"

const origin = "https://geo.example.net"

describe("links", () => {
  it("opens the IP inspector", () => {
    expect(inspectorUrl(origin, "45.148.10.82")).toBe(
      "https://geo.example.net/?inspect=45.148.10.82",
    )
  })

  it("encodes the hosts as the JSON array the app's router reads", () => {
    expect(analyticsUrl(origin, ["a.example"])).toBe(
      "https://geo.example.net/analytics?host=%5B%22a.example%22%5D",
    )
    const url = new URL(analyticsUrl(origin, ["[2001:db8::1]", "2001:db8::1"]))
    expect(JSON.parse(url.searchParams.get("host") ?? "")).toEqual(["[2001:db8::1]", "2001:db8::1"])
  })
})
