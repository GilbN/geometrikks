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
 * restyled as a line above the tab bar in main.css.
 *
 * With `startCollapsed` (a phone held sideways) the button starts collapsed
 * and changes are not saved, so the phone never overwrites the desktop's
 * choice under the shared key.
 *
 * GeoMap sets `foldEsriCredit` on phones over satellite imagery. The Esri
 * credit then folds behind an "Esri" button, so the portrait line and the
 * sideways pill each stay one row. CARTO wants its own credit always on the
 * map, but Esri allows its source names behind an expandable control on
 * small screens.
 */

import { Info } from "lucide-react"
import { AttributionControl } from "maplibre-gl"
import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useControl } from "react-map-gl/maplibre"

import { loadAttributionPreference, saveAttributionPreference } from "@/lib/map-preferences"

const COMPACT_CLASS = "maplibregl-compact"
const SHOW_CLASS = "maplibregl-compact-show"

export function MapAttribution({
  compact = true,
  startCollapsed = false,
  foldEsriCredit = false,
}: {
  compact?: boolean
  startCollapsed?: boolean
  foldEsriCredit?: boolean
}) {
  const observer = useRef<MutationObserver | null>(null)
  const [container, setContainer] = useState<HTMLDetailsElement | null>(null)
  const [esriOpen, setEsriOpen] = useState(false)
  useControl(
    () => new AttributionControl({ compact }),
    ({ map }) => {
      const container = map.getContainer().querySelector<HTMLDetailsElement>(".maplibregl-ctrl-attrib")
      const button = container?.querySelector<HTMLElement>(".maplibregl-ctrl-attrib-button")
      if (!container || !button) return
      setContainer(container)

      let applied = false
      const applyStored = () => {
        applied = true
        const expanded = startCollapsed ? false : loadAttributionPreference()
        if (container.classList.contains(SHOW_CLASS) !== expanded) {
          button.click()
        }
      }

      observer.current = new MutationObserver(() => {
        if (!container.classList.contains(COMPACT_CLASS)) return
        if (applied) {
          if (startCollapsed) return
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
      setContainer(null)
    },
    { position: "bottom-left" },
  )

  const folded = foldEsriCredit && container !== null
  const open = folded && esriOpen
  useEffect(() => {
    container?.toggleAttribute("data-esri-fold", folded)
    container?.toggleAttribute("data-esri-open", open)
  }, [container, folded, open])

  if (!folded) return null
  // The leading space keeps "Hide" off the end of the expanded credit.
  return createPortal(
    <>
      {" "}
      <button
        type="button"
        className="esri-credit-toggle"
        aria-expanded={open}
        aria-label={open ? "Hide the Esri credit" : "Show the Esri credit"}
        onClick={() => setEsriOpen(!open)}
      >
        {open ? "Hide" : <>Esri<Info aria-hidden /></>}
      </button>
    </>,
    container,
  )
}
