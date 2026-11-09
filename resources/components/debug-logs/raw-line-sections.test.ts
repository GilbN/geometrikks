import { describe, expect, it } from "vitest"

import type { RawLineField, RawLineFields } from "@/lib/api"
import { breakSegments, rawLineSections } from "./raw-line-sections"

const field = (key: string, group: RawLineField["group"], storedAs: string | null = null): RawLineField => ({
  key,
  value: "v",
  group,
  storedAs,
})

const sectionKeys = (rawFields: RawLineFields) =>
  rawLineSections(rawFields).map((section) => [section.title, section.fields.map((f) => f.key)])

describe("rawLineSections", () => {
  it("orders unstored headers, then not stored, then everything stored, keeping line order inside each", () => {
    const rawFields: RawLineFields = {
      format: "traefik-json",
      fields: [
        field("ClientHost", "field", "IP address"),
        field("TLSVersion", "field"),
        field("Content-Type", "response_header"),
        field("User-Agent", "request_header", "User agent"),
        field("entryPointName", "field"),
        field("X-Upstream", "origin_header"),
        field("X-Tenant-Id", "request_header"),
        field("DownstreamStatus", "field", "Status"),
      ],
    }
    expect(sectionKeys(rawFields)).toEqual([
      ["Request headers", ["X-Tenant-Id"]],
      ["Response headers", ["Content-Type"]],
      ["Origin response headers", ["X-Upstream"]],
      ["Not stored", ["TLSVersion", "entryPointName"]],
      ["Stored in the access log", ["ClientHost", "User-Agent", "DownstreamStatus"]],
    ])
  })

  it("drops empty sections", () => {
    const rawFields: RawLineFields = {
      format: "caddy-json",
      fields: [field("status", "field", "Status")],
    }
    expect(sectionKeys(rawFields)).toEqual([["Stored in the access log", ["status"]]])
  })

  it("lists every field together when no parser read the line", () => {
    const rawFields: RawLineFields = {
      format: null,
      fields: [field("event", "field"), field("X-Id", "request_header"), field("level", "field")],
    }
    expect(sectionKeys(rawFields)).toEqual([
      ["Request headers", ["X-Id"]],
      ["Fields", ["event", "level"]],
    ])
  })
})

describe("breakSegments", () => {
  it("splits camel case keys between words", () => {
    expect(breakSegments("DownstreamContentSize", { key: true })).toEqual(["Downstream", "Content", "Size"])
  })

  it("splits after separators, keeping them on the left", () => {
    expect(breakSegments("203.0.113.40:51022")).toEqual(["203.0.113.40:", "51022"])
    expect(breakSegments("TLS_AES_128")).toEqual(["TLS_", "AES_", "128"])
    expect(breakSegments("request.tls.version", { key: true })).toEqual(["request.", "tls.", "version"])
    expect(breakSegments("/api/orders?page=2")).toEqual(["/", "api/", "orders?", "page=", "2"])
  })

  it("keeps camel case and dotted numbers whole in values", () => {
    expect(breakSegments("AppleWebKit/537.36")).toEqual(["AppleWebKit/", "537.36"])
  })

  it("leaves acronyms and plain words whole", () => {
    expect(breakSegments("TLSVersion", { key: true })).toEqual(["TLSVersion"])
    expect(breakSegments("https")).toEqual(["https"])
    expect(breakSegments("")).toEqual([""])
  })
})
