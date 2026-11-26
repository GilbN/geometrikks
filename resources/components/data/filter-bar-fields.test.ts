import { describe, expect, it } from "vite-plus/test"
import { activeModes, orderChips, parseChipId, switchMode, typedField } from "./filter-bar-fields"
import { Hash } from "lucide-react"

const ipField = (include: string[], exclude: string[]) =>
  typedField({
    id: "ip",
    label: "IP address",
    icon: Hash,
    include,
    exclude,
    onChange: () => {},
    labelFor: String,
    validate: () => true,
    placeholder: "",
    help: "",
  })

describe("orderChips", () => {
  it("keeps known chips in place and adds new ones at the end", () => {
    expect(orderChips(["country:is", "ip:not"], ["ip:not", "host:is", "country:is"])).toEqual([
      "country:is",
      "ip:not",
      "host:is",
    ])
  })

  it("drops chips that are gone", () => {
    expect(orderChips(["country:is", "ip:not"], ["ip:not"])).toEqual(["ip:not"])
  })
})

describe("switchMode", () => {
  it("moves the values to is not, merged with what is there", () => {
    expect(switchMode(["a", "b"], ["b", "c"], "not")).toEqual({
      include: [],
      exclude: ["b", "c", "a"],
    })
  })

  it("moves them back to is", () => {
    expect(switchMode([1], [2], "is")).toEqual({ include: [1, 2], exclude: [] })
  })
})

describe("activeModes", () => {
  it("gives a field an is chip and an is not chip when both lists hold values", () => {
    expect(activeModes(ipField(["10.0.0.1"], ["10.0.0.2"]))).toEqual(["is", "not"])
    expect(activeModes(ipField([], ["10.0.0.2"]))).toEqual(["not"])
    expect(activeModes(ipField([], []))).toEqual([])
  })
})

describe("parseChipId", () => {
  it("splits the field from the mode", () => {
    expect(parseChipId("ip:not")).toEqual({ fieldId: "ip", mode: "not" })
    expect(parseChipId("host:is")).toEqual({ fieldId: "host", mode: "is" })
  })
})
