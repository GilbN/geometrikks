/**
 * Map pin for the configured server home location.
 *
 * A teardrop pin with the home glyph in its head, anchored so the tip sits
 * on the exact coordinate. Because the body floats above the point, data
 * markers at (or near) home stay visible. A DOM marker rather than a map
 * layer so it stays crisp at every zoom level. The ground ripple pauses when
 * the user prefers reduced motion. Clicking the pin head flies the map to
 * the home location, mirroring the "Go to home location" control; only the
 * head is interactive so data markers under the tip stay clickable.
 */
import { Marker } from "react-map-gl/maplibre"
import { Home } from "lucide-react"

type Coordinate = [longitude: number, latitude: number]

export function HomeMarker({
  coordinates,
  onClick,
}: {
  coordinates: Coordinate | null
  onClick?: () => void
}) {
  if (!coordinates) return null
  const [longitude, latitude] = coordinates

  return (
    <Marker
      longitude={longitude}
      latitude={latitude}
      anchor="bottom"
      className="pointer-events-none"
    >
      <div className="relative" aria-label="Server home location">
        {/* Ground ripple where the tip meets the coordinate */}
        <span className="absolute bottom-0 left-1/2 h-3 w-3 -translate-x-1/2 translate-y-1/2 rounded-full border border-primary/70 animate-ping [animation-duration:2.4s] motion-reduce:animate-none motion-reduce:opacity-0" />
        {/* Teardrop pin */}
        <svg
          width="30"
          height="40"
          viewBox="0 0 30 40"
          className="drop-shadow-[0_0_6px_var(--primary-dim)]"
        >
          <path
            d="M15 38.5 C 11 31.5 3 21.5 3 13 A 12 12 0 1 1 27 13 C 27 21.5 19 31.5 15 38.5 Z"
            fill="var(--background)"
            fillOpacity="0.92"
            stroke="var(--primary)"
            strokeWidth="2"
            strokeLinejoin="round"
          />
        </svg>
        {/* Home glyph centered in the pin head (head center is at y=13 of 40) */}
        <Home className="absolute top-[6px] left-1/2 h-3.5 w-3.5 -translate-x-1/2 text-primary" />
        {/* Only the head is clickable; the stem and tip pass clicks through so
            data markers sharing the home coordinate remain reachable. */}
        <button
          type="button"
          onClick={(event) => {
            // Keep the click from reaching the map's own click handlers.
            event.stopPropagation()
            onClick?.()
          }}
          title="Go to home location"
          aria-label="Zoom to home location"
          className="pointer-events-auto absolute top-px left-1/2 h-6 w-6 -translate-x-1/2 cursor-pointer rounded-full"
        />
      </div>
    </Marker>
  )
}
