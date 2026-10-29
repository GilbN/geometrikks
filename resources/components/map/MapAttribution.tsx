/**
 * MapLibre's compact attribution control with its expanded/collapsed state
 * kept in localStorage. MapLibre owns the toggle (click expands or collapses,
 * a drag collapses) and expresses the state as a CSS class, so the stored
 * value is applied by replaying a click and changes are picked up by watching
 * that class.
 *
 * The control is not compact when it is added: MapLibre waits for the style's
 * sources to report their attribution, then adds the compact classes in an
 * expanded state. The stored preference is applied at that moment, and only
 * class changes after it count as the user's choice.
 *
 * With `compact` off (phones) there is no toggle: the full text always shows,
 * restyled as a line under the action card in main.css.
 */

import { AttributionControl } from "maplibre-gl"
import { useRef } from "react"
import { useControl } from "react-map-gl/maplibre"

import { loadAttributionPreference, saveAttributionPreference } from "@/lib/map-preferences"

const COMPACT_CLASS = "maplibregl-compact"
const SHOW_CLASS = "maplibregl-compact-show"

export function MapAttribution({ compact = true }: { compact?: boolean }) {
  const observer = useRef<MutationObserver | null>(null)
  useControl(
    () => new AttributionControl({ compact }),
    ({ map }) => {
      const container = map.getContainer().querySelector<HTMLDetailsElement>(".maplibregl-ctrl-attrib")
      const button = container?.querySelector<HTMLElement>(".maplibregl-ctrl-attrib-button")
      if (!container || !button) return

      let applied = false
      const applyStored = () => {
        applied = true
        if (container.classList.contains(SHOW_CLASS) !== loadAttributionPreference()) {
          button.click()
        }
      }

      observer.current = new MutationObserver(() => {
        if (!container.classList.contains(COMPACT_CLASS)) return
        if (applied) {
          saveAttributionPreference(container.classList.contains(SHOW_CLASS))
        } else {
          applyStored()
        }
      })
      observer.current.observe(container, { attributes: true, attributeFilter: ["class"] })
      if (container.classList.contains(COMPACT_CLASS)) applyStored()
    },
    () => {
      observer.current?.disconnect()
      observer.current = null
    },
    { position: "bottom-left" },
  )
  return null
}
