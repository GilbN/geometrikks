import { describe, expect, it } from "vite-plus/test"
import { escapeXml, firstToken } from "./omnibox"

describe("omnibox helpers", () => {
  it("escapes XML", () => {
    expect(escapeXml("AT&T <x>")).toBe("AT&amp;T &lt;x&gt;")
  })

  it("takes the first token", () => {
    expect(firstToken("  45.148.10.82 (recent)")).toBe("45.148.10.82")
    expect(firstToken("   ")).toBe("")
  })
})
