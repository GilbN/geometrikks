import { AxiosError } from "axios"
import { describe, expect, it } from "vitest"
import {
  bgpAsUrl,
  crowdsecCtiUrl,
  crowdsecErrorMessage,
  crowdsecHubUrl,
  decisionLabel,
  decisionPopupColor,
  decisionWinner,
  isValidBanDuration,
  isValidBanTarget,
  rangeSizeLabel,
  resolveDecision,
  winningDecision,
} from "./crowdsec"

describe("crowdsecErrorMessage", () => {
  it("prefers the backend detail from an axios error", () => {
    const err = new AxiosError(
      "Request failed with status code 502",
      "ERR_BAD_RESPONSE",
      undefined,
      undefined,
      // Minimal AxiosResponse shape; only .data is read
      { data: { detail: "CrowdSec LAPI is unreachable" }, status: 502 } as never,
    )
    expect(crowdsecErrorMessage(err, "fallback")).toBe("CrowdSec LAPI is unreachable")
  })

  it("falls back for non-axios errors and missing detail", () => {
    expect(crowdsecErrorMessage(new Error("boom"), "fallback")).toBe("fallback")
    const bare = new AxiosError("network down", "ERR_NETWORK")
    expect(crowdsecErrorMessage(bare, "fallback")).toBe("fallback")
  })
})

describe("decisionWinner", () => {
  it("ranks ban over captcha over any other name", () => {
    expect(decisionWinner(null, "captcha")).toBe("captcha")
    expect(decisionWinner("captcha", "ban")).toBe("ban")
    expect(decisionWinner("ban", "captcha")).toBe("ban")
    expect(decisionWinner("throttle", "captcha")).toBe("captcha")
    expect(decisionWinner("throttle", "allow")).toBe("allow")
  })

  it("treats prototype property names as ordinary custom types", () => {
    expect(decisionWinner("ban", "toString")).toBe("ban")
    expect(decisionWinner("constructor", "captcha")).toBe("captcha")
    expect(decisionWinner("__proto__", "hasOwnProperty")).toBe("__proto__")
  })
})

describe("winningDecision", () => {
  it("returns the decision whose type wins, or null", () => {
    const captcha = { type: "captcha", scenario: "a" }
    const ban = { type: "ban", scenario: "b" }
    expect(winningDecision([captcha, ban])).toBe(ban)
    expect(winningDecision([])).toBeNull()
    expect(winningDecision(undefined)).toBeNull()
  })

  it("keeps the first decision when a later one has the same type", () => {
    const first = { type: "ban", scenario: "ssh-bf", origin: "crowdsec", duration: "3h" }
    const second = { type: "ban", scenario: "manual", origin: "cscli", duration: "24h" }
    expect(winningDecision([first, second])).toBe(first)
  })
})

describe("resolveDecision", () => {
  it("uses the caller's type only until the badge map has loaded", () => {
    expect(resolveDecision(undefined, "1.2.3.4", "captcha")).toBe("captcha")
    expect(resolveDecision(undefined, "1.2.3.4", null)).toBeNull()
    expect(resolveDecision(new Map([["1.2.3.4", "ban"]]), "1.2.3.4", "captcha")).toBe("ban")
  })

  it("treats a missing entry in a loaded map as no decision", () => {
    expect(resolveDecision(new Map(), "1.2.3.4", "ban")).toBeNull()
    expect(resolveDecision(new Map([["5.6.7.8", "ban"]]), "1.2.3.4", "ban")).toBeNull()
  })
})

describe("decisionLabel and decisionPopupColor", () => {
  it("names ban and captcha, passes other types through", () => {
    expect(decisionLabel("ban")).toBe("Banned")
    expect(decisionLabel("captcha")).toBe("Captcha")
    expect(decisionLabel("throttle")).toBe("throttle")
  })

  it("colors ban red, captcha amber, anything else muted", () => {
    expect(decisionPopupColor("ban")).toBe("var(--destructive)")
    expect(decisionPopupColor("captcha")).toBe("#f59e0b")
    expect(decisionPopupColor("throttle")).toBe("var(--popup-muted)")
  })
})

describe("isValidBanTarget", () => {
  it("accepts IPs and ranges", () => {
    for (const value of ["203.0.113.7", "2001:db8::1", "203.0.113.0/24", "203.0.113.9/24", "2001:db8::/48", "10.0.0.1/32"]) {
      expect(isValidBanTarget(value), value).toBe(true)
    }
  })

  it("rejects partial values, bad prefixes and /0", () => {
    for (const value of ["203.0.113", "203.0.113.0/", "203.0.113.0/33", "2001:db8::/129", "0.0.0.0/0", "::/0", "10.0.0.0/08", "10.0.0.0/2a"]) {
      expect(isValidBanTarget(value), value).toBe(false)
    }
  })
})

describe("rangeSizeLabel", () => {
  it("counts the addresses a range covers", () => {
    expect(rangeSizeLabel("203.0.113.0/24")).toBe("256 addresses")
    expect(rangeSizeLabel("10.0.0.0/8")).toBe("16,777,216 addresses")
    expect(rangeSizeLabel("203.0.113.0/31")).toBe("2 addresses")
  })

  it("writes huge IPv6 ranges as a power of two", () => {
    expect(rangeSizeLabel("2001:db8::/64")).toBe("2^64 addresses")
    expect(rangeSizeLabel("2001:db8::/120")).toBe("256 addresses")
  })

  it("is null for a single address or an invalid value", () => {
    expect(rangeSizeLabel("203.0.113.7")).toBeNull()
    expect(rangeSizeLabel("203.0.113.7/32")).toBeNull()
    expect(rangeSizeLabel("nonsense/24")).toBeNull()
  })
})

describe("isValidBanDuration", () => {
  it("accepts days, hours, minutes and seconds in order", () => {
    for (const value of ["4h", "30m", "7d", "1d12h", "1h30m", "90s"]) {
      expect(isValidBanDuration(value), value).toBe(true)
    }
  })

  it("rejects zero, empty, other units and wrong order", () => {
    for (const value of ["", "0h", "0d0m", "1w", "4 hours", "30m1h", "h"]) {
      expect(isValidBanDuration(value), value).toBe(false)
    }
  })
})

describe("external links", () => {
  it("links an IP to CrowdSec CTI", () => {
    expect(crowdsecCtiUrl("2001:db8::1")).toBe("https://app.crowdsec.net/cti/2001%3Adb8%3A%3A1")
  })

  it("links hub scenarios and WAF rules", () => {
    expect(crowdsecHubUrl("crowdsecurity/http-probing")).toBe(
      "https://app.crowdsec.net/hub/author/crowdsecurity/scenarios/http-probing",
    )
    expect(crowdsecHubUrl("crowdsecurity/vpatch-CVE-2023-1234")).toBe(
      "https://app.crowdsec.net/hub/author/crowdsecurity/appsec-rules/vpatch-CVE-2023-1234",
    )
  })

  it("has no hub link for our own, list or free-text scenarios", () => {
    for (const scenario of ["geometrikks/manual-ban", "geometrikks/manual-ban: scanner", "lists:firehol_cruzit", "update : +15000/-0 IPs", "manual ban"]) {
      expect(crowdsecHubUrl(scenario), scenario).toBeNull()
    }
  })

  it("links an AS number to bgp.he.net", () => {
    expect(bgpAsUrl(13335)).toBe("https://bgp.he.net/AS13335")
    expect(bgpAsUrl("13335")).toBe("https://bgp.he.net/AS13335")
    expect(bgpAsUrl(null)).toBeNull()
    expect(bgpAsUrl("")).toBeNull()
  })
})
