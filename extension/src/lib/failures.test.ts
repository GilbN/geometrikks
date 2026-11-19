import { describe, expect, it } from "vite-plus/test"
import { classifyFailure } from "./failures"

const keyed = { keyless: false, permissionMissing: false }
const keyless = { keyless: true, permissionMissing: false }

describe("classifyFailure", () => {
  it("puts a missing host permission first", () => {
    expect(
      classifyFailure(
        { status: 401, code: "api_key_invalid" },
        { keyless: false, permissionMissing: true },
      ),
    ).toBe("access-removed")
  })

  it("maps each code", () => {
    expect(classifyFailure({ status: 401, code: "api_key_invalid" }, keyed)).toBe("key-invalid")
    expect(classifyFailure({ status: 401, code: "api_key_expired" }, keyed)).toBe("key-invalid")
    expect(classifyFailure({ status: 401, code: "not_authenticated" }, keyless)).toBe("needs-key")
    expect(classifyFailure({ status: 503, code: "api_keys_unavailable" }, keyed)).toBe(
      "keys-unavailable",
    )
  })

  it("calls everything else unreachable", () => {
    expect(classifyFailure({ status: 200, notJson: true }, keyed)).toBe("unreachable")
    expect(classifyFailure({ status: 401 }, keyed)).toBe("unreachable")
    expect(classifyFailure({ status: 401, code: "not_authenticated" }, keyed)).toBe("unreachable")
    expect(classifyFailure({ networkError: true }, keyed)).toBe("unreachable")
    expect(classifyFailure({ timedOut: true }, keyless)).toBe("unreachable")
    expect(classifyFailure({ status: 500, code: "internal_error" }, keyed)).toBe("unreachable")
  })
})
