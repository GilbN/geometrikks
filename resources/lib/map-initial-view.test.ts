import { describe, expect, it } from "vitest"
import { HOME_ZOOM, FIT_MAX_ZOOM, FIT_PADDING, WORLD_VIEW, initialMapView, type MapView } from "@/lib/map-initial-view"
import type { SiteHomesData } from "@/lib/site-homes"

const SIZE = { width: 1200, height: 800 }
const OSLO = { latitude: 59.91, longitude: 10.75 }
const BERGEN = { latitude: 60.39, longitude: 5.32 }
const SYDNEY = { latitude: -33.87, longitude: 151.21 }

function homes(...entries: Array<[string, { latitude: number; longitude: number }]>): SiteHomesData {
  return { homes: entries.map(([hostname, c]) => ({ hostname, ...c })), default: null }
}

/** Screen offset of a coordinate from the view center, in pixels (512px
 *  tiles). The mercator map renders world copies, so x takes the nearest copy. */
function offsetPx(view: MapView, c: { latitude: number; longitude: number }): [number, number] {
  const scale = 512 * 2 ** view.zoom
  const x = (lng: number) => ((lng + 180) / 360) * scale
  const y = (lat: number) => {
    const rad = (lat * Math.PI) / 180
    return ((1 - Math.log(Math.tan(Math.PI / 4 + rad / 2)) / Math.PI) / 2) * scale
  }
  let dx = x(c.longitude) - x(view.longitude)
  dx -= Math.round(dx / scale) * scale
  return [dx, y(c.latitude) - y(view.latitude)]
}

/** MapLibre raises the zoom until the world is at least as tall as the map. */
function minZoomFor(height: number): number {
  return Math.max(Math.log2(height / 512), 0)
}

describe("initialMapView", () => {
  it("uses the configured default view over everything else", () => {
    const view = initialMapView({
      defaultView: { latitude: 71.129982, longitude: 27.653369, zoom: 15 },
      siteHomes: homes(["a", OSLO]),
      selectedSources: ["a"],
      size: SIZE,
    })
    expect(view).toEqual({ latitude: 71.129982, longitude: 27.653369, zoom: 15 })
  })

  it("opens on the whole world when there are no homes", () => {
    expect(initialMapView({ defaultView: null, siteHomes: undefined, selectedSources: [], size: SIZE })).toEqual(
      WORLD_VIEW,
    )
    expect(
      initialMapView({ defaultView: null, siteHomes: { homes: [], default: null }, selectedSources: [], size: SIZE }),
    ).toEqual(WORLD_VIEW)
  })

  it("centers on a single home", () => {
    const view = initialMapView({
      defaultView: null,
      siteHomes: { homes: [], default: SYDNEY },
      selectedSources: [],
      size: SIZE,
    })
    expect(view).toEqual({ ...SYDNEY, zoom: HOME_ZOOM })
  })

  it("counts a site home sharing the default's coordinate as one home", () => {
    const view = initialMapView({
      defaultView: null,
      siteHomes: { homes: [{ hostname: "a", ...OSLO }], default: OSLO },
      selectedSources: [],
      size: SIZE,
    })
    expect(view).toEqual({ ...OSLO, zoom: HOME_ZOOM })
  })

  it("centers on the one selected source's home", () => {
    const view = initialMapView({
      defaultView: null,
      siteHomes: homes(["oslo", OSLO], ["sydney", SYDNEY]),
      selectedSources: ["sydney"],
      size: SIZE,
    })
    expect(view).toEqual({ ...SYDNEY, zoom: HOME_ZOOM })
  })

  it("falls back to the default home for a selected source without its own", () => {
    const view = initialMapView({
      defaultView: null,
      siteHomes: { homes: [{ hostname: "oslo", ...OSLO }], default: SYDNEY },
      selectedSources: ["unknown"],
      size: SIZE,
    })
    expect(view).toEqual({ ...SYDNEY, zoom: HOME_ZOOM })
  })

  it("fits every home when several sources or none are selected", () => {
    for (const selectedSources of [[], ["oslo", "sydney"]]) {
      const view = initialMapView({
        defaultView: null,
        siteHomes: homes(["oslo", OSLO], ["sydney", SYDNEY]),
        selectedSources,
        size: SIZE,
      })
      expect(view.zoom).toBeLessThan(HOME_ZOOM)
      expect(view.zoom).toBeGreaterThanOrEqual(0)
      for (const home of [OSLO, SYDNEY]) {
        const [dx, dy] = offsetPx(view, home)
        expect(Math.abs(dx)).toBeLessThanOrEqual(SIZE.width / 2 - FIT_PADDING + 0.5)
        expect(Math.abs(dy)).toBeLessThanOrEqual(SIZE.height / 2 - FIT_PADDING + 0.5)
      }
    }
  })

  it("caps the fit zoom so nearby homes do not open at street level", () => {
    const view = initialMapView({
      defaultView: null,
      siteHomes: homes(["oslo", OSLO], ["bergen", BERGEN]),
      selectedSources: [],
      size: SIZE,
    })
    expect(view.zoom).toBe(FIT_MAX_ZOOM)
    expect(view.longitude).toBeCloseTo((OSLO.longitude + BERGEN.longitude) / 2, 5)
    expect(view.latitude).toBeGreaterThan(OSLO.latitude)
    expect(view.latitude).toBeLessThan(BERGEN.latitude)
  })

  it("keeps every home clear of extra padding, such as an overlay on one side", () => {
    const padding = { top: FIT_PADDING, right: 320, bottom: FIT_PADDING, left: FIT_PADDING }
    const view = initialMapView({
      defaultView: null,
      siteHomes: homes(["nyc", { latitude: 40.71, longitude: -74 }], ["tokyo", { latitude: 35.68, longitude: 139.69 }]),
      selectedSources: [],
      size: SIZE,
      padding,
    })
    for (const home of [{ latitude: 40.71, longitude: -74 }, { latitude: 35.68, longitude: 139.69 }]) {
      const [dx, dy] = offsetPx(view, home)
      const x = SIZE.width / 2 + dx
      const y = SIZE.height / 2 + dy
      expect(x).toBeGreaterThanOrEqual(padding.left - 0.5)
      expect(x).toBeLessThanOrEqual(SIZE.width - padding.right + 0.5)
      expect(y).toBeGreaterThanOrEqual(padding.top - 0.5)
      expect(y).toBeLessThanOrEqual(SIZE.height - padding.bottom + 0.5)
    }
  })

  it("centers on the homes without a padding shift in an unmeasured container", () => {
    const view = initialMapView({
      defaultView: null,
      siteHomes: homes(["oslo", OSLO], ["sydney", SYDNEY]),
      selectedSources: [],
      size: { width: 0, height: 0 },
      padding: { top: FIT_PADDING, right: 316, bottom: FIT_PADDING, left: FIT_PADDING },
    })
    expect(view.zoom).toBe(0)
    expect(view.longitude).toBeCloseTo((OSLO.longitude + SYDNEY.longitude) / 2, 5)
    const [, dyOslo] = offsetPx(view, OSLO)
    const [, dySydney] = offsetPx(view, SYDNEY)
    expect(dyOslo + dySydney).toBeCloseTo(0, 5)
  })

  it("never fits below the zoom MapLibre allows for the container height", () => {
    const size = { width: 390, height: 780 }
    const nyc = { latitude: 40.71, longitude: -74 }
    const tokyo = { latitude: 35.68, longitude: 139.69 }
    const view = initialMapView({
      defaultView: null,
      siteHomes: homes(["nyc", nyc], ["tokyo", tokyo]),
      selectedSources: [],
      size,
    })
    expect(view.zoom).toBeGreaterThanOrEqual(minZoomFor(size.height) - 1e-9)
    // Across the Pacific the two fit side by side even at that zoom.
    for (const home of [nyc, tokyo]) {
      const [dx] = offsetPx(view, home)
      expect(Math.abs(dx)).toBeLessThanOrEqual(size.width / 2)
    }
  })

  it("fits homes across the antimeridian the short way", () => {
    const fiji = { latitude: -17.71, longitude: 178.07 }
    const samoa = { latitude: -13.76, longitude: -172.1 }
    const view = initialMapView({
      defaultView: null,
      siteHomes: homes(["fiji", fiji], ["samoa", samoa]),
      selectedSources: [],
      size: SIZE,
    })
    expect(view.zoom).toBe(FIT_MAX_ZOOM)
    expect(Math.abs(view.longitude)).toBeGreaterThan(170)
    for (const home of [fiji, samoa]) {
      const [dx, dy] = offsetPx(view, home)
      expect(Math.abs(dx)).toBeLessThanOrEqual(SIZE.width / 2 - FIT_PADDING + 0.5)
      expect(Math.abs(dy)).toBeLessThanOrEqual(SIZE.height / 2 - FIT_PADDING + 0.5)
    }
  })
})
