/** URL codec for the map's data filters (sources/countries/cities). Pure
 *  module: vitest runs without a DOM, so no router imports here. */
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
