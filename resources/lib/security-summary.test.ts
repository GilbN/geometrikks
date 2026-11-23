import { describe, expect, it } from "vite-plus/test"
import {
  alertTotalText,
  barLabel,
  weekday,
  expiryPhrase,
  scenarioRow,
  localDateKey,
  originPhrases,
  splitPhrases,
} from "./security-summary"
import { formatNumber } from "./format-number"

describe("splitPhrases", () => {
  it("keeps the parts that hold a decision, each with its own plural", () => {
    expect(splitPhrases({ bans: 12, ranges: 1, captchas: 0, other: 2 })).toEqual([
      { count: 12, words: "bans" },
      { count: 1, words: "range" },
      { count: 2, words: "other" },
    ])
  })

  it("is empty without decisions", () => {
    expect(splitPhrases({ bans: 0, ranges: 0, captchas: 0, other: 0 })).toEqual([])
  })
})

describe("expiryPhrase", () => {
  it("counts the decisions expiring soon", () => {
    expect(expiryPhrase(3, 4)).toEqual({ count: 3, words: "expire within 4 hours" })
    expect(expiryPhrase(1, 4)).toEqual({ count: 1, words: "expires within 4 hours" })
    expect(expiryPhrase(0, 4)).toEqual({ count: 0, words: "expire within 4 hours" })
  })
})

describe("originPhrases", () => {
  it("counts by hand, detected and blocklist decisions, leaving out empty ones", () => {
    expect(
      originPhrases([
        { origin: "crowdsec", count: 9 },
        { origin: "appsec", count: 6 },
        { origin: "geometrikks", count: 2 },
        { origin: "cscli", count: 1 },
        { origin: "console", count: 1 },
        { origin: "cscli-import", count: 3 },
        { origin: "CAPI", count: 400 },
        { origin: "lists", count: 20 },
      ]),
    ).toEqual([
      { count: 7, words: "set by hand" },
      { count: 15, words: "detected by CrowdSec" },
      { count: 420, words: "from blocklists" },
    ])
    expect(originPhrases([{ origin: "crowdsec", count: 4 }])).toEqual([
      { count: 4, words: "detected by CrowdSec" },
    ])
  })
})

describe("localDateKey", () => {
  it("writes the local date with zero padding", () => {
    expect(localDateKey(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05")
  })
})

describe("alert days", () => {
  it("names the weekday of a date", () => {
    const monday = new Date(2026, 10, 23, 12)
    expect(weekday("2026-11-23")).toEqual({
      short: monday.toLocaleDateString(undefined, { weekday: "short" }),
      initial: monday.toLocaleDateString(undefined, { weekday: "narrow" }),
    })
  })

  it("marks a total the server stopped counting", () => {
    expect(alertTotalText(2000, true)).toBe(`${formatNumber(2000)}+`)
    expect(alertTotalText(24, false)).toBe("24")
  })
})

describe("barLabel", () => {
  it("writes a quiet day out and shortens a busy one", () => {
    expect(barLabel(0)).toBe("0")
    expect(barLabel(412)).toBe("412")
    expect(barLabel(1200)).toBe(
      new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(
        1200,
      ),
    )
  })
})

describe("scenarioRow", () => {
  it("labels a manual decision with its type and reason", () => {
    expect(scenarioRow("geometrikks/manual-ban: Repeated probing")).toEqual({
      manualType: "ban",
      label: "Repeated probing",
    })
    expect(scenarioRow("geometrikks/manual-captcha: manual captcha from GeoMetrikks")).toEqual({
      manualType: "captcha",
      label: "Set by hand",
    })
  })

  it("shows any other scenario by name", () => {
    expect(scenarioRow("crowdsecurity/http-probing")).toEqual({
      manualType: null,
      label: "http-probing",
    })
  })
})
