/** Resolve the --map-ramp-* CSS variables to rgb() strings MapLibre accepts.
 * getComputedStyle returns custom-property text unresolved (oklch(calc(...)))
 * so each variable is read through a probe element's background-color, which
 * the browser resolves. Re-runs when theme or accent changes. */
import { useMemo } from "react"
import { useTheme } from "@/components/theme-provider"

export interface MapRamp {
  steps: [string, string, string, string, string]
  noData: string
  border: string
}

const VARS = ["--map-ramp-1", "--map-ramp-2", "--map-ramp-3", "--map-ramp-4", "--map-ramp-5"] as const

function resolveColor(variable: string): string {
  const probe = document.createElement("div")
  probe.style.display = "none"
  probe.style.backgroundColor = `var(${variable})`
  document.body.appendChild(probe)
  const resolved = getComputedStyle(probe).backgroundColor
  probe.remove()
  return resolved
}

export function useMapRamp(): MapRamp {
  // resolvedTheme and accent are pure invalidation keys: flipping either
  // rewrites the CSS variables this reads through the probe.
  const { resolvedTheme, accent } = useTheme()
  return useMemo(
    () => ({
      steps: VARS.map(resolveColor) as MapRamp["steps"],
      noData: resolveColor("--map-ramp-nodata"),
      border: resolveColor("--border"),
    }),
    [resolvedTheme, accent],
  )
}
