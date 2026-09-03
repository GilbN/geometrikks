/**
 * Hook for theme-aware map style URL plus the request hook that attaches the
 * configured CARTO API key. `ready` is false until the runtime settings have
 * settled: react-map-gl reads transformRequest only when it creates the map,
 * so a map mounted before the key arrives would stay keyless for its lifetime.
 */

import { useMemo } from "react"

import { useTheme } from "@/components/theme-provider"
import { useRuntimeSettings } from "@/lib/queries"

import { createCartoRequestTransform } from "./cartoRequestTransform"

const MAP_STYLES = {
  dark: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
  light: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
} as const

export function useMapStyle() {
  // resolvedTheme, not theme: "system" has to land on whichever mode the
  // rest of the page is showing, and it changes live with the OS setting.
  const { resolvedTheme } = useTheme()
  const { data: runtimeSettings, isPending } = useRuntimeSettings()
  const cartoApiKey = runtimeSettings?.map.cartoApiKey
  const transformRequest = useMemo(() => createCartoRequestTransform(cartoApiKey), [cartoApiKey])

  return {
    mapStyle: MAP_STYLES[resolvedTheme],
    theme: resolvedTheme,
    transformRequest,
    ready: !isPending,
  }
}
