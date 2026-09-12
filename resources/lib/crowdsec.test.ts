import { AxiosError } from "axios"
import { describe, expect, it } from "vitest"
import {
  crowdsecErrorMessage,
  decisionLabel,
  decisionPopupColor,
  decisionWinner,
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
