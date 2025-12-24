/**
 * Hook for theme-aware map style URL.
 */

import { useTheme } from "@/components/theme-provider"

const MAP_STYLES = {
  dark: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
  light: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
} as const

export function useMapStyle() {
  const { theme } = useTheme()

  // Use dark for "dark" and "system" themes (since system defaults to dark in this app)
  const effectiveTheme = theme === "light" ? "light" : "dark"

  return {
    mapStyle: MAP_STYLES[effectiveTheme],
    theme: effectiveTheme,
  }
}
