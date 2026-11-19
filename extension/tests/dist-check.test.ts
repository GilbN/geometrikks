import { describe, expect, it } from "vite-plus/test"
import { attributes, scriptProblem } from "./dist.check"

describe("attributes", () => {
  it("reads quoted, unquoted and bare attributes, lower-casing names", () => {
    expect(attributes(` type="module" SRC='/popup.js' defer data-x=1`)).toEqual({
      values: new Map([
        ["type", "module"],
        ["src", "/popup.js"],
        ["defer", ""],
        ["data-x", "1"],
      ]),
      repeated: new Set(),
    })
  })

  it("splits attributes with no space between them, as the HTML tokenizer does", () => {
    expect(attributes(` src="/a.js"SRC="/b.js"`)).toEqual({
      values: new Map([["src", "/a.js"]]),
      repeated: new Set(["src"]),
    })
    expect(attributes(` type='module'defer/src=/a.js`).values).toEqual(
      new Map([
        ["type", "module"],
        ["defer", ""],
        ["src", "/a.js"],
      ]),
    )
  })

  it("reads an attribute name that starts with = and spaces around =", () => {
    expect(attributes(` =x src = "/a.js"`).values).toEqual(
      new Map([
        ["=x", ""],
        ["src", "/a.js"],
      ]),
    )
  })

  it("keeps the first of a repeated attribute, as browsers do", () => {
    const { values, repeated } = attributes(` src="/popup.js" SRC="https://evil.example/x.js"`)
    expect(values.get("src")).toBe("/popup.js")
    expect(repeated).toEqual(new Set(["src"]))
  })
})

describe("scriptProblem", () => {
  it("fails a script with two src attributes", () => {
    expect(scriptProblem("popup.html", ` src="/a.js" src="/b.js"`)).toBe(
      "popup.html has a <script> with more than one src",
    )
  })

  it("fails a script whose second src follows a quote with no space", () => {
    expect(scriptProblem("popup.html", ` src="/a.js"SRC="/b.js"`)).toBe(
      "popup.html has a <script> with more than one src",
    )
  })

  it("fails an inline script", () => {
    expect(scriptProblem("popup.html", ` type="module"`)).toBe("popup.html has an inline <script>")
  })

  it("fails a script that isn't a packaged file", () => {
    expect(scriptProblem("popup.html", ` src="https://evil.example/x.js"`)).toBe(
      'popup.html has a <script src="https://evil.example/x.js"> that is not a file in dist/',
    )
  })
})
