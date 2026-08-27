/**
 * Hook for theme-aware map style URL.
 */

import { useTheme } from "@/components/theme-provider"

const MAP_STYLES = {
  dark: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
  light: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
} as const

export function useMapStyle() {
  // resolvedTheme, not theme: "system" has to land on whichever mode the
  // rest of the page is showing, and it changes live with the OS setting.
  const { resolvedTheme } = useTheme()

  return {
    mapStyle: MAP_STYLES[resolvedTheme],
    theme: resolvedTheme,
  }
}
