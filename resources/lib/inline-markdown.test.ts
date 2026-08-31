import { describe, expect, it } from "vitest"
import { tokenizeInline } from "./inline-markdown"

describe("tokenizeInline", () => {
  it("passes plain text through", () => {
    expect(tokenizeInline("The map runs on MapLibre GL JS 6.")).toEqual([
      { type: "text", value: "The map runs on MapLibre GL JS 6." },
    ])
  })

  it("turns backticks into code", () => {
    expect(tokenizeInline("Set `GEOIP_ASN_ENABLED=false` to opt out.")).toEqual([
      { type: "text", value: "Set " },
      { type: "code", value: "GEOIP_ASN_ENABLED=false" },
      { type: "text", value: " to opt out." },
    ])
  })

  it("turns double asterisks into bold", () => {
    expect(tokenizeInline("**Breaking:** the mount moved.")).toEqual([
      { type: "bold", value: "Breaking:" },
      { type: "text", value: " the mount moved." },
    ])
  })

  it("turns markdown links into links", () => {
    expect(tokenizeInline("See [Keep a Changelog](https://keepachangelog.com/) for the format.")).toEqual([
      { type: "text", value: "See " },
      { type: "link", value: "Keep a Changelog", href: "https://keepachangelog.com/" },
      { type: "text", value: " for the format." },
    ])
  })

  it("leaves an unclosed backtick as text", () => {
    expect(tokenizeInline("a `broken span")).toEqual([{ type: "text", value: "a `broken span" }])
  })

  it("handles several spans in one entry", () => {
    expect(tokenizeInline("`a` and `b`, **c**")).toEqual([
      { type: "code", value: "a" },
      { type: "text", value: " and " },
      { type: "code", value: "b" },
      { type: "text", value: ", " },
      { type: "bold", value: "c" },
    ])
  })
})
