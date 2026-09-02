import { describe, expect, it } from "vitest"

import { HTTP_METHODS } from "./http-methods"

const IANA_HTTP_METHODS = [
  "*", "ACL", "BASELINE-CONTROL", "BIND", "CHECKIN", "CHECKOUT", "CONNECT", "COPY",
  "DELETE", "GET", "HEAD", "LABEL", "LINK", "LOCK", "MERGE", "MKACTIVITY", "MKCALENDAR",
  "MKCOL", "MKREDIRECTREF", "MKWORKSPACE", "MOVE", "OPTIONS", "ORDERPATCH", "PATCH", "POST",
  "PRI", "PROPFIND", "PROPPATCH", "PUT", "QUERY", "REBIND", "REPORT", "SEARCH", "TRACE",
  "UNBIND", "UNCHECKOUT", "UNLINK", "UNLOCK", "UPDATE", "UPDATEREDIRECTREF", "VERSION-CONTROL",
] as const

describe("HTTP_METHODS", () => {
  it("contains every registered IANA method exactly once", () => {
    expect([...HTTP_METHODS].sort()).toEqual(IANA_HTTP_METHODS)
  })
})
