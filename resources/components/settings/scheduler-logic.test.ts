import { describe, expect, it } from "vitest"
import { describeTrigger } from "./scheduler-logic"

describe("describeTrigger", () => {
  it.each([
    ["interval[0:00:15]", "Every 15 seconds"],
    ["interval[0:01:00]", "Every minute"],
    ["interval[0:05:00]", "Every 5 minutes"],
    ["interval[0:01:30]", "Every 90 seconds"],
    ["interval[6:00:00]", "Every 6 hours"],
    ["interval[1 day, 0:00:00]", "Every day"],
    ["interval[7 days, 0:00:00]", "Every 7 days"],
    ["interval[1 day, 12:00:00]", "Every 36 hours"],
  ])("reads %s as %s", (trigger, expected) => {
    expect(describeTrigger(trigger)).toBe(expected)
  })

  it("returns triggers it can't read unchanged", () => {
    expect(describeTrigger("cron[hour='3']")).toBe("cron[hour='3']")
    expect(describeTrigger("interval[0:00:00]")).toBe("interval[0:00:00]")
  })
})
