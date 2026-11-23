import { AxiosError } from "axios"
import { describe, expect, it } from "vite-plus/test"
import { crowdsecErrorMessage, isClientError } from "./crowdsec-errors"

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

describe("isClientError", () => {
  const withStatus = (status: number) =>
    new AxiosError("Request failed", "ERR_BAD_REQUEST", undefined, undefined, {
      data: {},
      status,
    } as never)

  it("is true for a 4xx answer", () => {
    expect(isClientError(withStatus(400))).toBe(true)
    expect(isClientError(withStatus(409))).toBe(true)
  })

  it("is false for server errors, network errors and anything else", () => {
    expect(isClientError(withStatus(502))).toBe(false)
    expect(isClientError(new AxiosError("network down", "ERR_NETWORK"))).toBe(false)
    expect(isClientError(new Error("boom"))).toBe(false)
  })
})
