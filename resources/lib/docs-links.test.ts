import { describe, expect, it } from "vitest"
import * as docsLinks from "./docs-links"

const DOCS_URL = /^https:\/\/geometrikks\.dev\/docs\/(?!next\/)(?!\d+\.\d+\.\d+\/)[a-z0-9-]+(\/[a-z0-9-]+)*\/$/

describe("docs links", () => {
  it("exports the three setup links", () => {
    expect(Object.keys(docsLinks).sort()).toEqual(["AGENT_DOCS_URL", "CROWDSEC_DOCS_URL", "GEOLITE2_DOCS_URL"])
  })

  it.each(Object.entries(docsLinks))("%s is an unversioned geometrikks.dev docs URL", (_name, url) => {
    expect(url).toMatch(DOCS_URL)
  })
})
