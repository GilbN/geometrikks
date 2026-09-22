/** URL codec for the map's data filters (sources/countries/cities), plus the
 *  route's search schema. Pure module: vitest runs without a DOM, so no
 *  router imports here. */
import { z } from "zod"
import { arrayParam } from "@/lib/url-filters"

export interface MapFilterState {
  sources: string[]
  countryCodes: string[]
  cities: string[]
}

export interface MapSearch {
  sources?: string[]
  countries?: string[]
  cities?: string[]
  /** Dev-only demo traffic mode; preserved so navigation never strips it. */
  demoTraffic?: string
  /** Location id to fly to and open; set by the IP inspector, cleared by GeoMap once handled. */
  focus?: number
  /** IP to fly to when the caller only knows the address; GeoMap resolves
   *  it to the IP's busiest location in range and rewrites it as `focus`. */
  focusIp?: string
}

/** Search params for a "fly to on the map" navigation. Data filters are
 *  cleared so the target location cannot be filtered off the map; a known
 *  location id wins over resolving the IP. */
export function flyToSearch(ip: string, locationId?: number): Partial<MapSearch> {
  return {
    focus: locationId,
    focusIp: locationId === undefined ? ip : undefined,
    sources: undefined,
    countries: undefined,
    cities: undefined,
  }
}

export function decodeMapSearch(search: MapSearch): MapFilterState {
  return {
    sources: search.sources ?? [],
    countryCodes: search.countries ?? [],
    cities: search.cities ?? [],
  }
}

export function encodeMapSearch(filters: MapFilterState): Partial<MapSearch> {
  return {
    sources: arrayParam(filters.sources),
    countries: arrayParam(filters.countryCodes),
    cities: arrayParam(filters.cities),
  }
}

export const mapSearchSchema = z.object({
  sources: z.array(z.string()).optional().catch(undefined),
  countries: z.array(z.string()).optional().catch(undefined),
  cities: z.array(z.string()).optional().catch(undefined),
  demoTraffic: z.string().optional().catch(undefined),
  focus: z.coerce.number().int().positive().optional().catch(undefined),
  focusIp: z.string().min(1).optional().catch(undefined),
})
