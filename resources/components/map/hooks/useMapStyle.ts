/**
 * Hook for theme-aware map style URL plus the request hook that attaches the
 * configured CARTO API key. `ready` is false until the runtime settings have
 * settled: react-map-gl reads transformRequest only when it creates the map,
 * so a map mounted before the key arrives would stay keyless for its lifetime.
 *
 * With `satellite` on and an Esri key configured, the style is CARTO Dark
 * Matter rebuilt around Esri imagery. On the first load `ready` also waits
 * for that style, so a saved Satellite choice doesn't flash the street map.
 * Once ready, it stays ready. GeoMap unmounts the map whenever `ready` is
 * false, so a later switch to satellite keeps the street map up until the
 * new style arrives.
 */

import { useQuery } from "@tanstack/react-query"
import type { StyleSpecification } from "maplibre-gl"
import { useMemo, useState } from "react"

import { useTheme } from "@/components/theme-provider"
import { useRuntimeSettings } from "@/lib/queries"

import { createCartoRequestTransform, withCartoApiKey } from "./cartoRequestTransform"
import { buildSatelliteStyle, CARTO_DARK_STYLE_URL } from "./satelliteStyle"

const MAP_STYLES = {
  dark: CARTO_DARK_STYLE_URL,
  light: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
} as const

async function fetchCartoDarkStyle(cartoApiKey: string | null | undefined): Promise<StyleSpecification> {
  const response = await fetch(withCartoApiKey(CARTO_DARK_STYLE_URL, cartoApiKey))
  if (!response.ok) throw new Error(`CARTO style request failed with ${response.status}`)
  return (await response.json()) as StyleSpecification
}

export function useMapStyle({ satellite = false }: { satellite?: boolean } = {}) {
  // resolvedTheme, not theme: "system" has to land on whichever mode the
  // rest of the page is showing, and it changes live with the OS setting.
  const { resolvedTheme } = useTheme()
  const { data: runtimeSettings, isPending } = useRuntimeSettings()
  const cartoApiKey = runtimeSettings?.map.cartoApiKey
  const esriApiKey = runtimeSettings?.map.esriApiKey
  const transformRequest = useMemo(() => createCartoRequestTransform(cartoApiKey), [cartoApiKey])

  const showSatellite = satellite && Boolean(esriApiKey)
  const { data: cartoDark, isError: satelliteFailed } = useQuery({
    queryKey: ["map-style", "carto-dark", cartoApiKey],
    queryFn: () => fetchCartoDarkStyle(cartoApiKey),
    enabled: showSatellite,
    staleTime: Number.POSITIVE_INFINITY,
  })
  const satelliteStyle = useMemo(
    () => (showSatellite && cartoDark && esriApiKey ? buildSatelliteStyle(cartoDark, esriApiKey) : undefined),
    [showSatellite, cartoDark, esriApiKey],
  )

  const [ready, setReady] = useState(false)
  const satellitePending = showSatellite && !cartoDark && !satelliteFailed
  if (!ready && !isPending && !satellitePending) setReady(true)

  return {
    mapStyle: satelliteStyle ?? MAP_STYLES[resolvedTheme],
    theme: resolvedTheme,
    transformRequest,
    satelliteAvailable: Boolean(esriApiKey),
    satelliteFailed: showSatellite && satelliteFailed,
    ready,
  }
}
