/**
 * The chart tooltip regression these guard: `ChartTooltipContent` used to render
 * the raw UTC ISO string as its header while the axis ticks were browser-local.
 *
 * TZ is set before the dynamic imports on purpose: `formatTs` builds its
 * `Intl.DateTimeFormat` instances at module load, so they capture whatever
 * timezone is in effect at import time.
 */
import { describe, expect, it } from "vitest"

process.env.TZ = "America/New_York"

const { formatTs } = await import("@/lib/datetime")
const { TimeSeriesTooltip } = await import("@/components/analytics/time-series-tooltip")

// 05:00 UTC is 01:00 the same day in America/New_York (EDT, UTC-4).
const ISO = "2026-08-09T05:00:00+00:00"

/** Pull the label formatter the tooltip hands to ChartTooltipContent. */
function labelFormatterOf(granularity: string) {
  const element = TimeSeriesTooltip({ granularity }) as {
    props: { labelFormatter?: (value: unknown, payload: unknown[]) => unknown }
  }
  return element.props.labelFormatter
}

describe("formatTs", () => {
  it("renders in the host timezone, not UTC", () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe("America/New_York")

    const formatted = formatTs(ISO, "hourly")

    // Hour and minutes, tolerant of the locale's time separator.
    expect(formatted).toMatch(/0?1\D?00/)
    expect(formatted).not.toContain("05")
    expect(formatted).not.toBe(ISO)
  })

  it("drops the hour for daily buckets", () => {
    expect(formatTs(ISO, "daily")).not.toContain("01")
  })

  it("passes through unparseable input", () => {
    expect(formatTs("not a timestamp", "hourly")).toBe("not a timestamp")
  })
})

describe("TimeSeriesTooltip", () => {
  it("formats the tooltip label instead of rendering the raw ISO string", () => {
    const labelFormatter = labelFormatterOf("hourly")

    expect(labelFormatter).toBeTypeOf("function")
    expect(labelFormatter?.(ISO, [])).not.toBe(ISO)
  })

  it("formats the label exactly like the axis tick", () => {
    for (const granularity of ["hourly", "daily"]) {
      expect(labelFormatterOf(granularity)?.(ISO, [])).toBe(formatTs(ISO, granularity))
    }
  })

  it("lets a caller override the label formatter", () => {
    const element = TimeSeriesTooltip({
      granularity: "hourly",
      labelFormatter: () => "custom",
    }) as { props: { labelFormatter?: (value: unknown, payload: unknown[]) => unknown } }

    expect(element.props.labelFormatter?.(ISO, [])).toBe("custom")
  })
})
