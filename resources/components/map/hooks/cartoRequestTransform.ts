/**
 * CARTO basemap requests need `?key=` on every URL (style, TileJSON, tiles,
 * sprite, glyphs). MapLibre's transformRequest hook sees each one before it
 * is fetched, so the key never has to be baked into the style JSON.
 */

import type { RequestTransformFunction } from "maplibre-gl"

const CARTO_HOST = /(^|\.)cartocdn\.com$/i

export function withCartoApiKey(url: string, key: string | null | undefined): string {
  if (!key) return url
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  if (!CARTO_HOST.test(parsed.hostname)) return url
  parsed.searchParams.set("key", key)
  return parsed.toString()
}

export function createCartoRequestTransform(key: string | null | undefined): RequestTransformFunction | undefined {
  if (!key) return undefined
  return (url) => {
    const keyed = withCartoApiKey(url, key)
    return keyed === url ? undefined : { url: keyed }
  }
}
