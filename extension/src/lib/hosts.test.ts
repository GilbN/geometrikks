import { describe, expect, it } from "vite-plus/test"
import { hostValuesFromUrl } from "./hosts"

describe("hostValuesFromUrl", () => {
  it("gives the hostname for a plain URL", () => {
    expect(hostValuesFromUrl("https://Shop.Example.com/cart?x=1")).toEqual(["shop.example.com"])
  })

  it("adds host:port when the port is explicit", () => {
    expect(hostValuesFromUrl("http://shop.example.com:8080/")).toEqual([
      "shop.example.com",
      "shop.example.com:8080",
    ])
  })

  it("gives an IPv6 literal with and without brackets", () => {
    expect(hostValuesFromUrl("https://[2001:db8::1]:8443/x")).toEqual([
      "[2001:db8::1]",
      "2001:db8::1",
      "[2001:db8::1]:8443",
    ])
  })

  it("is null for pages that aren't http(s)", () => {
    for (const url of [
      "chrome://extensions",
      "file:///tmp/a.html",
      "chrome-extension://abc/popup.html",
      "about:blank",
      undefined,
      "nonsense",
    ])
      expect(hostValuesFromUrl(url)).toBeNull()
  })
})
