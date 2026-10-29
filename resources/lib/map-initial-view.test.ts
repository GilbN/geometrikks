import { describe, expect, it } from "vitest"
import { SERVER_LOCATION_ZOOM, FIT_MAX_ZOOM, FIT_PADDING, WORLD_VIEW, initialMapView, trafficView, trafficWindow, type MapView } from "@/lib/map-initial-view"
import type { ServerLocationsData } from "@/lib/server-locations"

const SIZE = { width: 1200, height: 800 }
const OSLO = { latitude: 59.91, longitude: 10.75 }
const BERGEN = { latitude: 60.39, longitude: 5.32 }
const SYDNEY = { latitude: -33.87, longitude: 151.21 }

function locations(...entries: Array<[string, { latitude: number; longitude: number }]>): ServerLocationsData {
  return { locations: entries.map(([server, c]) => ({ server, ...c })), default: null }
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
      serverLocations: locations(["a", OSLO]),
      selectedServers: ["a"],
      size: SIZE,
    })
    expect(view).toEqual({ latitude: 71.129982, longitude: 27.653369, zoom: 15 })
  })

  it("opens on the whole world when there are no server locations", () => {
    expect(initialMapView({ defaultView: null, serverLocations: undefined, selectedServers: [], size: SIZE })).toEqual(
      WORLD_VIEW,
    )
    expect(
      initialMapView({ defaultView: null, serverLocations: { locations: [], default: null }, selectedServers: [], size: SIZE }),
    ).toEqual(WORLD_VIEW)
  })

  it("centers on a single server location", () => {
    const view = initialMapView({
      defaultView: null,
      serverLocations: { locations: [], default: SYDNEY },
      selectedServers: [],
      size: SIZE,
    })
    expect(view).toEqual({ ...SYDNEY, zoom: SERVER_LOCATION_ZOOM })
  })

  it("counts a server location sharing the default's coordinate as one location", () => {
    const view = initialMapView({
      defaultView: null,
      serverLocations: { locations: [{ server: "a", ...OSLO }], default: OSLO },
      selectedServers: [],
      size: SIZE,
    })
    expect(view).toEqual({ ...OSLO, zoom: SERVER_LOCATION_ZOOM })
  })

  it("centers on the one selected server's location", () => {
    const view = initialMapView({
      defaultView: null,
      serverLocations: locations(["oslo", OSLO], ["sydney", SYDNEY]),
      selectedServers: ["sydney"],
      size: SIZE,
    })
    expect(view).toEqual({ ...SYDNEY, zoom: SERVER_LOCATION_ZOOM })
  })

  it("falls back to the default location for a selected server without its own", () => {
    const view = initialMapView({
      defaultView: null,
      serverLocations: { locations: [{ server: "oslo", ...OSLO }], default: SYDNEY },
      selectedServers: ["unknown"],
      size: SIZE,
    })
    expect(view).toEqual({ ...SYDNEY, zoom: SERVER_LOCATION_ZOOM })
  })

  it("fits every server location when several servers or none are selected", () => {
    for (const selectedServers of [[], ["oslo", "sydney"]]) {
      const view = initialMapView({
        defaultView: null,
        serverLocations: locations(["oslo", OSLO], ["sydney", SYDNEY]),
        selectedServers,
        size: SIZE,
      })
      expect(view.zoom).toBeLessThan(SERVER_LOCATION_ZOOM)
      expect(view.zoom).toBeGreaterThanOrEqual(0)
      for (const serverLocation of [OSLO, SYDNEY]) {
        const [dx, dy] = offsetPx(view, serverLocation)
        expect(Math.abs(dx)).toBeLessThanOrEqual(SIZE.width / 2 - FIT_PADDING + 0.5)
        expect(Math.abs(dy)).toBeLessThanOrEqual(SIZE.height / 2 - FIT_PADDING + 0.5)
      }
    }
  })

  it("caps the fit zoom so nearby server locations do not open at street level", () => {
    const view = initialMapView({
      defaultView: null,
      serverLocations: locations(["oslo", OSLO], ["bergen", BERGEN]),
      selectedServers: [],
      size: SIZE,
    })
    expect(view.zoom).toBe(FIT_MAX_ZOOM)
    expect(view.longitude).toBeCloseTo((OSLO.longitude + BERGEN.longitude) / 2, 5)
    expect(view.latitude).toBeGreaterThan(OSLO.latitude)
    expect(view.latitude).toBeLessThan(BERGEN.latitude)
  })

  it("keeps every server location clear of extra padding, such as an overlay on one side", () => {
    const padding = { top: FIT_PADDING, right: 320, bottom: FIT_PADDING, left: FIT_PADDING }
    const view = initialMapView({
      defaultView: null,
      serverLocations: locations(["nyc", { latitude: 40.71, longitude: -74 }], ["tokyo", { latitude: 35.68, longitude: 139.69 }]),
      selectedServers: [],
      size: SIZE,
      padding,
    })
    for (const serverLocation of [{ latitude: 40.71, longitude: -74 }, { latitude: 35.68, longitude: 139.69 }]) {
      const [dx, dy] = offsetPx(view, serverLocation)
      const x = SIZE.width / 2 + dx
      const y = SIZE.height / 2 + dy
      expect(x).toBeGreaterThanOrEqual(padding.left - 0.5)
      expect(x).toBeLessThanOrEqual(SIZE.width - padding.right + 0.5)
      expect(y).toBeGreaterThanOrEqual(padding.top - 0.5)
      expect(y).toBeLessThanOrEqual(SIZE.height - padding.bottom + 0.5)
    }
  })

  it("centers on the server locations without a padding shift in an unmeasured container", () => {
    const view = initialMapView({
      defaultView: null,
      serverLocations: locations(["oslo", OSLO], ["sydney", SYDNEY]),
      selectedServers: [],
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
      serverLocations: locations(["nyc", nyc], ["tokyo", tokyo]),
      selectedServers: [],
      size,
    })
    expect(view.zoom).toBeGreaterThanOrEqual(minZoomFor(size.height) - 1e-9)
    // Across the Pacific the two fit side by side even at that zoom.
    for (const serverLocation of [nyc, tokyo]) {
      const [dx] = offsetPx(view, serverLocation)
      expect(Math.abs(dx)).toBeLessThanOrEqual(size.width / 2)
    }
  })

  it("fits server locations across the antimeridian the short way", () => {
    const fiji = { latitude: -17.71, longitude: 178.07 }
    const samoa = { latitude: -13.76, longitude: -172.1 }
    const view = initialMapView({
      defaultView: null,
      serverLocations: locations(["fiji", fiji], ["samoa", samoa]),
      selectedServers: [],
      size: SIZE,
    })
    expect(view.zoom).toBe(FIT_MAX_ZOOM)
    expect(Math.abs(view.longitude)).toBeGreaterThan(170)
    for (const serverLocation of [fiji, samoa]) {
      const [dx, dy] = offsetPx(view, serverLocation)
      expect(Math.abs(dx)).toBeLessThanOrEqual(SIZE.width / 2 - FIT_PADDING + 0.5)
      expect(Math.abs(dy)).toBeLessThanOrEqual(SIZE.height / 2 - FIT_PADDING + 0.5)
    }
  })
})

describe("trafficView", () => {
  const PHONE = { width: 390, height: 700 }
  const NEW_YORK = { latitude: 40.71, longitude: -74.0 }
  const TOKYO = { latitude: 35.68, longitude: 139.69 }
  const SINGAPORE = { latitude: 1.35, longitude: 103.82 }
  const point = (c: { latitude: number; longitude: number }, weight: number) => ({
    coordinate: [c.longitude, c.latitude] as [number, number],
    weight,
  })
  const inView = (view: MapView, c: { latitude: number; longitude: number }, size: { width: number; height: number }) => {
    const [dx, dy] = offsetPx(view, c)
    return Math.abs(dx) <= size.width / 2 && Math.abs(dy) <= size.height / 2
  }

  it("is null without traffic", () => {
    expect(trafficView([], PHONE)).toBeNull()
  })

  it("fits all the traffic when it fits across the container", () => {
    const view = trafficView([point(OSLO, 5), point(BERGEN, 3)], SIZE)!
    expect(inView(view, OSLO, SIZE)).toBe(true)
    expect(inView(view, BERGEN, SIZE)).toBe(true)
  })

  it("on a phone that can't show it all, frames the stretch with the most traffic", () => {
    const points = [point(NEW_YORK, 30), point(TOKYO, 17), point(SINGAPORE, 27), point(SYDNEY, 12)]
    const view = trafficView(points, PHONE)!
    // Asia and Australia hold 56 events; New York with Sydney across the Pacific holds 42.
    expect(inView(view, TOKYO, PHONE)).toBe(true)
    expect(inView(view, SINGAPORE, PHONE)).toBe(true)
    expect(inView(view, SYDNEY, PHONE)).toBe(true)
    expect(inView(view, NEW_YORK, PHONE)).toBe(false)
  })

  it("counts a window across the Pacific like any other", () => {
    // New York and Sydney fit in one phone-wide stretch of longitude, and
    // together they outweigh Asia.
    const view = trafficView([point(NEW_YORK, 46), point(TOKYO, 17), point(SINGAPORE, 27), point(SYDNEY, 12)], PHONE)!
    expect(inView(view, NEW_YORK, PHONE)).toBe(true)
    expect(inView(view, SYDNEY, PHONE)).toBe(true)
  })

  it("takes the heavier side when one location outweighs the rest", () => {
    const view = trafficView([point(NEW_YORK, 500), point(TOKYO, 17), point(SINGAPORE, 27)], PHONE)!
    expect(inView(view, NEW_YORK, PHONE)).toBe(true)
  })

  it("can span the antimeridian", () => {
    const AUCKLAND = { latitude: -36.85, longitude: 174.76 }
    const HONOLULU = { latitude: 21.31, longitude: -157.86 }
    const view = trafficView([point(AUCKLAND, 10), point(HONOLULU, 10)], PHONE)!
    expect(inView(view, AUCKLAND, PHONE)).toBe(true)
    expect(inView(view, HONOLULU, PHONE)).toBe(true)
  })

  it("gives a window across the antimeridian an east edge past 180", () => {
    const AUCKLAND = { latitude: -36.85, longitude: 174.76 }
    const HONOLULU = { latitude: 21.31, longitude: -157.86 }
    const window = trafficWindow([point(AUCKLAND, 10), point(HONOLULU, 10)], PHONE)!
    expect(window.west).toBeCloseTo(174.76)
    expect(window.east).toBeCloseTo(-157.86 + 360)
  })

  it("ignores the padding of a container that hasn't been laid out", () => {
    // A 1px span would pick one location; the unpadded width still shows a region.
    const window = trafficWindow([point(OSLO, 5), point(BERGEN, 3)], { width: 100, height: 100 })!
    expect(window.coordinates).toHaveLength(2)
  })

  it("lets the caller raise the zoom cap for a single location", () => {
    expect(trafficView([point(OSLO, 1)], SIZE)!.zoom).toBe(FIT_MAX_ZOOM)
    expect(trafficView([point(OSLO, 1)], SIZE, undefined, 12)!.zoom).toBe(12)
  })
})
