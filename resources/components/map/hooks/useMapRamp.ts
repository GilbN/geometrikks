/** Resolve the --map-ramp-* CSS variables to rgb() strings MapLibre accepts.
 * getComputedStyle returns custom-property text unresolved (oklch(calc(...)))
 * so each variable is read through a probe element's background-color, which
 * the browser resolves. ThemeProvider mutates the DOM in effects after render,
 * so render-time reads race with class/data-accent updates; a MutationObserver
 * on documentElement catches those mutations and re-resolves. */
import { useEffect, useState } from "react"

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

function resolveRamp(): MapRamp {
  return {
    steps: VARS.map(resolveColor) as MapRamp["steps"],
    noData: resolveColor("--map-ramp-nodata"),
    border: resolveColor("--border"),
  }
}

export function useMapRamp(): MapRamp {
  const [ramp, setRamp] = useState<MapRamp>(resolveRamp)
  useEffect(() => {
    const observer = new MutationObserver(() => setRamp(resolveRamp()))
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-accent"],
    })
    return () => observer.disconnect()
  }, [])
  return ramp
}
