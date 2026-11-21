import { describe, expect, it } from "vite-plus/test"
import {
  focusIdAfterRemoval,
  MUTED_IPS_CAP,
  mutedIpAddErrorMessage,
  mutedIpCodeOf,
  mutedIpErrorMessage,
  mutedIpsCountLine,
  mutedIpsHomeLine,
} from "./muted-ips"

describe("mutedIpErrorMessage", () => {
  it.each([
    ["muted_ip_exists", "That IP or range is already muted."],
    ["muted_ip_list_full", "The list is full (20 entries). Remove one first."],
    ["invalid_network", "Enter an IP address or CIDR range."],
    ["invalid_note", "Keep the note to 100 characters."],
    ["something_else", "Couldn't save. Try again."],
    [undefined, "Couldn't save. Try again."],
    ["constructor", "Couldn't save. Try again."],
    ["toString", "Couldn't save. Try again."],
  ])("maps %s", (code, message) => {
    expect(mutedIpErrorMessage(code)).toBe(message)
  })
})

describe("mutedIpAddErrorMessage", () => {
  it("shows the server detail for invalid_network", () => {
    const detail =
      "10.0.0.5/8 is not the start of a range. Enter 10.0.0.0/8 for the range, or 10.0.0.5 for one address"
    expect(mutedIpAddErrorMessage({ status_code: 400, detail, code: "invalid_network" })).toBe(
      detail,
    )
  })
  it("falls back to the code message", () => {
    expect(mutedIpAddErrorMessage({ status_code: 400, detail: "", code: "invalid_network" })).toBe(
      "Enter an IP address or CIDR range.",
    )
    expect(mutedIpAddErrorMessage({ status_code: 409, detail: "x", code: "muted_ip_exists" })).toBe(
      "That IP or range is already muted.",
    )
    expect(mutedIpAddErrorMessage(new Error("boom"))).toBe("Couldn't save. Try again.")
  })
})

describe("mutedIpCodeOf", () => {
  it("reads the code from the Litestar envelope", () => {
    expect(mutedIpCodeOf({ status_code: 409, detail: "x", code: "muted_ip_exists" })).toBe(
      "muted_ip_exists",
    )
  })
  it("is undefined for anything else", () => {
    expect(mutedIpCodeOf(new Error("boom"))).toBeUndefined()
    expect(mutedIpCodeOf(null)).toBeUndefined()
    expect(mutedIpCodeOf({ code: 5 })).toBeUndefined()
  })
})

describe("count and home lines", () => {
  it("mirrors the cap", () => {
    expect(MUTED_IPS_CAP).toBe(20)
    expect(mutedIpsCountLine(3)).toBe("3 of 20")
  })
  it("reads none for an empty or unknown list", () => {
    expect(mutedIpsHomeLine(undefined)).toBe("None")
    expect(mutedIpsHomeLine(0)).toBe("None")
    expect(mutedIpsHomeLine(3)).toBe("3 muted")
  })
})

describe("focusIdAfterRemoval", () => {
  it("prefers the next row, then the previous one", () => {
    expect(focusIdAfterRemoval(["a", "b", "c"], "b")).toBe("c")
    expect(focusIdAfterRemoval(["a", "b", "c"], "c")).toBe("b")
  })
  it("is null for the only row or an unknown id", () => {
    expect(focusIdAfterRemoval(["a"], "a")).toBeNull()
    expect(focusIdAfterRemoval(["a"], "z")).toBeNull()
  })
})
