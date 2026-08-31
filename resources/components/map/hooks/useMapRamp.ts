/** Resolve the --map-ramp-* CSS variables to rgba() strings MapLibre accepts.
 * getComputedStyle hands back custom-property text verbatim, var() and calc()
 * unresolved, so each variable is read off a probe element's background-color,
 * which the browser resolves. That value comes back in the space it was
 * authored in, oklch() for this theme, and MapLibre's parser only knows hex,
 * rgb/rgba, hsl/hsla and keywords. A layer whose paint carries an oklch()
 * string fails style validation and is never added, so a 1x1 canvas paints the
 * resolved color and the pixel readback converts it to sRGB. ThemeProvider
 * mutates the DOM in effects after render, so render-time reads race with
 * class/data-accent updates; a MutationObserver on documentElement catches
 * those mutations and re-resolves. */
import { useEffect, useState } from "react"

export interface MapRamp {
  steps: [string, string, string, string, string]
  noData: string
  border: string
}

const VARS = ["--map-ramp-1", "--map-ramp-2", "--map-ramp-3", "--map-ramp-4", "--map-ramp-5"] as const

const TRANSPARENT = "rgba(0, 0, 0, 0)"

/** ctx.fillStyle keeps its previous value when handed a string it cannot
 * parse, with no error, so the sentinel goes in first and a fully transparent
 * readback means the assignment was rejected. */
function toSRGB(ctx: CanvasRenderingContext2D, color: string): string {
  ctx.fillStyle = TRANSPARENT
  ctx.fillStyle = color
  ctx.clearRect(0, 0, 1, 1)
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
  if (a === 0) return color
  return `rgba(${r}, ${g}, ${b}, ${a / 255})`
}

function resolveRamp(): MapRamp {
  const probe = document.createElement("div")
  probe.style.display = "none"
  document.body.appendChild(probe)
  const canvas = document.createElement("canvas")
  canvas.width = 1
  canvas.height = 1
  const ctx = canvas.getContext("2d", { willReadFrequently: true })

  const read = (variable: string): string => {
    probe.style.backgroundColor = `var(${variable})`
    const resolved = getComputedStyle(probe).backgroundColor
    return ctx ? toSRGB(ctx, resolved) : resolved
  }

  try {
    return {
      steps: VARS.map(read) as MapRamp["steps"],
      noData: read("--map-ramp-nodata"),
      border: read("--border"),
    }
  } finally {
    probe.remove()
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
