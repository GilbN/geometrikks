import { AxiosError } from "axios"
import { describe, expect, it } from "vitest"
import { crowdsecErrorMessage } from "./crowdsec"

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
