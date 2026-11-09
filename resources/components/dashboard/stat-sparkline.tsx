import { useId, useState } from "react"
import { Area, AreaChart, YAxis } from "recharts"

import { ChartContainer } from "@/components/ui/chart"
import { cn } from "@/lib/utils"

/**
 * How a stat card's value moved across the range, drawn as a line in the
 * current text colour with a gradient fading down from it. It has no axes or
 * tooltip because the card's figure is the reading.
 *
 * The line sweeps in from the left once, when it is first drawn, as the
 * Analytics charts do. Later data redraws it in place: recharts would
 * otherwise slide every point on each refresh, and a new hour shifts them all.
 * Remount it to sweep again.
 */
export function StatSparkline({
  values,
  className,
}: {
  values: readonly number[]
  className?: string
}) {
  // url(#...) does not resolve an id with the colons useId puts in it.
  const gradientId = `sparkline-${useId().replace(/:/g, "")}`
  const [sweeping, setSweeping] = useState(() => !prefersReducedMotion())
  if (values.length < 2) return <div className={className} />
  const rows = values.map((value, index) => ({ index, value }))

  return (
    <ChartContainer
      config={{}}
      className={cn("aspect-auto text-primary", className)}
      aria-hidden
    >
      <AreaChart data={rows} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="currentColor" stopOpacity={0.5} />
            <stop offset="95%" stopColor="currentColor" stopOpacity={0.05} />
          </linearGradient>
        </defs>
        <YAxis hide domain={[0, "dataMax"]} />
        {/* monotone, unlike natural, never swings below zero around a spike. */}
        <Area
          dataKey="value"
          type="monotone"
          stroke="currentColor"
          strokeWidth={1.5}
          fill={`url(#${gradientId})`}
          dot={false}
          activeDot={false}
          isAnimationActive={sweeping}
          onAnimationEnd={() => setSweeping(false)}
        />
      </AreaChart>
    </ChartContainer>
  )
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
}
