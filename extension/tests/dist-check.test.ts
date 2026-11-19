import { describe, expect, it } from "vite-plus/test"
import { attributes, pageProblems, scriptProblem } from "./dist.check"

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

describe("pageProblems", () => {
  it("fails a remote src after a slash with no space", () => {
    expect(pageProblems("popup.html", `<img/src="https://evil/x">`)).toEqual([
      "popup.html loads a remote src: https://evil/x",
    ])
  })

  it("fails a remote src after a quoted > in an earlier attribute", () => {
    expect(pageProblems("popup.html", `<img alt=">" src="https://evil/x">`)).toEqual([
      "popup.html loads a remote src: https://evil/x",
    ])
  })

  it("fails an inline event handler after a slash", () => {
    expect(pageProblems("popup.html", `<div/onclick="x()">`)).toEqual([
      "popup.html has an inline event handler onclick",
    ])
  })

  it("fails a remote src after a quote inside an unquoted value", () => {
    expect(pageProblems("popup.html", `<img alt=a"b src="https://evil/x"><p>`)).toEqual([
      "popup.html loads a remote src: https://evil/x",
    ])
    expect(
      pageProblems("popup.html", `<script type=a'b src="https://evil/x.js"></script>`),
    ).toContain('popup.html has a <script src="https://evil/x.js"> that is not a file in dist/')
  })

  it("fails a script in a page with more than one src", () => {
    expect(pageProblems("popup.html", `<script src="/a.js" SRC="/b.js"></script>`)).toContain(
      "popup.html has a <script> with more than one src",
    )
  })

  it("ignores tags inside comments and attribute values", () => {
    expect(
      pageProblems("popup.html", `<!-- <img src="https://evil/x"> --><p title="<img src=//x>">`),
    ).toEqual([])
  })

  it("checks tags inside template and noscript", () => {
    expect(
      pageProblems(
        "popup.html",
        `<template><img src="https://evil/a"></template><noscript><img src="https://evil/b"></noscript>`,
      ),
    ).toEqual([
      "popup.html loads a remote src: https://evil/a",
      "popup.html loads a remote src: https://evil/b",
    ])
  })

  it("passes local, fragment and data references", () => {
    expect(
      pageProblems("popup.html", `<a href="#top"><img alt="a > b" src="data:image/png;base64,AA">`),
    ).toEqual([])
  })
})
