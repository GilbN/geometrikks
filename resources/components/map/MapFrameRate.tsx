import { useEffect, useRef } from "react"
import { useMap } from "react-map-gl/maplibre"

/** Passive render counter: it must never request a map repaint itself. */
export function MapFrameRate() {
  const { current: map } = useMap()
  const counterRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const instance = map?.getMap()
    const container = counterRef.current
    if (!instance || !container) return
    let disposed = false
    let remove: (() => void) | undefined

    void import("mapbox-gl-fps/lib/MapboxFPS.js").then(({ FPSMeasurer }) => {
      if (disposed) return
      const measurer = new FPSMeasurer()
      const render = () => measurer.registerRenderFrame()
      measurer.startMeasuring()
      instance.on("render", render)
      // Sample even without renders so an idle map reports zero. Updating this
      // DOM label does not trigger MapLibre's render loop.
      const timer = window.setInterval(() => {
        measurer.updateFPS()
        // The plugin otherwise retains every sample for the entire session.
        measurer.measurements.splice(0, Math.max(0, measurer.measurements.length - 120))
        const label = `${measurer.getLastMeasurement().toFixed(1)} FPS`
        if (container.textContent !== label) container.textContent = label
      }, 1000)
      remove = () => {
        window.clearInterval(timer)
        instance.off("render", render)
        measurer.stopMeasuring()
      }
    })

    return () => {
      disposed = true
      remove?.()
    }
  }, [map])

  return (
    <div
      ref={counterRef}
      data-testid="map-frame-rate"
      title="Map renders per second. Zero is normal when idle. This counter does not measure CPU usage."
      className="pointer-events-none absolute bottom-[max(3rem,env(safe-area-inset-bottom))] left-1/2 z-10 min-w-20 -translate-x-1/2 rounded-full border border-border bg-background/90 px-3 py-1 text-center font-mono text-xs tabular-nums text-foreground shadow-sm lg:bottom-[max(1rem,env(safe-area-inset-bottom))]"
    >
      0.0 FPS
    </div>
  )
}
