import { describe, expect, it } from "vitest"
import { describeUnban } from "./pending-ip-actions"

const origins = (...values: string[]) => values.map((origin) => ({ origin }))

describe("describeUnban", () => {
  it("falls back to the rule when the decisions aren't known", () => {
    expect(describeUnban(undefined)).toBe("Removes every decision on this IP, from every origin.")
    expect(describeUnban([])).toBe("Removes every decision on this IP, from every origin.")
  })

  it("counts the decisions and the ones from the crowd", () => {
    expect(describeUnban(origins("crowdsec"))).toBe("Removes 1 decision.")
    expect(describeUnban(origins("crowdsec", "cscli", "geometrikks"))).toBe("Removes 3 decisions.")
    expect(describeUnban(origins("crowdsec", "CAPI", "crowdsec", "lists"))).toBe("Removes 4 decisions, 2 of them from the crowd.")
    expect(describeUnban(origins("CAPI"))).toBe("Removes 1 decision from the crowd.")
  })
})
