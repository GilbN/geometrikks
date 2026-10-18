import { createContext, useContext, useEffect, useMemo, useState } from "react"
import {
  type ColorTheme,
  type ResolvedTheme,
  type Theme,
  parseColorTheme,
  parseTheme,
  resolveTheme,
  themeColor,
  THEME_STORAGE_KEYS,
} from "@/lib/theme"

type ThemeProviderProps = {
  children: React.ReactNode
  defaultTheme?: Theme
  storageKey?: string
}

type ThemeProviderState = {
  /** The stored preference, "system" included. */
  theme: Theme
  /** What the page is showing right now; "system" resolved against the OS. */
  resolvedTheme: ResolvedTheme
  setTheme: (theme: Theme) => void
  /** The theme painting the page now: the side that matches `resolvedTheme`. */
  colorTheme: ColorTheme
  lightTheme: ColorTheme
  darkTheme: ColorTheme
  setLightTheme: (next: ColorTheme) => void
  setDarkTheme: (next: ColorTheme) => void
  /** Sets both sides. */
  setColorTheme: (next: ColorTheme) => void
}

const ThemeProviderContext = createContext<ThemeProviderState | undefined>(undefined)

function prefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Private mode or blocked storage: the choice still applies this session.
  }
}

export function ThemeProvider({
  children,
  defaultTheme = "system",
  storageKey = THEME_STORAGE_KEYS.mode,
}: ThemeProviderProps) {
  const [theme, setThemeState] = useState<Theme>(() =>
    parseTheme(readStorage(storageKey), defaultTheme),
  )
  const [lightTheme, setLightThemeState] = useState<ColorTheme>(() =>
    parseColorTheme(readStorage(THEME_STORAGE_KEYS.lightTheme), readStorage(THEME_STORAGE_KEYS.legacyAccent)),
  )
  const [darkTheme, setDarkThemeState] = useState<ColorTheme>(() =>
    parseColorTheme(readStorage(THEME_STORAGE_KEYS.darkTheme), readStorage(THEME_STORAGE_KEYS.legacyAccent)),
  )
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    resolveTheme(theme, prefersDark()),
  )

  useEffect(() => {
    setResolvedTheme(resolveTheme(theme, prefersDark()))
    if (theme !== "system") return
    const query = window.matchMedia("(prefers-color-scheme: dark)")
    const onChange = (event: MediaQueryListEvent) =>
      setResolvedTheme(resolveTheme(theme, event.matches))
    query.addEventListener("change", onChange)
    return () => query.removeEventListener("change", onChange)
  }, [theme])

  const colorTheme = resolvedTheme === "dark" ? darkTheme : lightTheme

  useEffect(() => {
    const root = window.document.documentElement
    root.classList.remove("light", "dark")
    root.classList.add(resolvedTheme)
    root.setAttribute("data-theme", colorTheme)
    root.style.colorScheme = resolvedTheme
    document.querySelector('meta[name="theme-color"]')?.setAttribute(
      "content",
      themeColor(resolvedTheme, colorTheme),
    )
  }, [resolvedTheme, colorTheme])

  const value = useMemo<ThemeProviderState>(() => {
    const setLightTheme = (next: ColorTheme) => {
      writeStorage(THEME_STORAGE_KEYS.lightTheme, next)
      setLightThemeState(next)
    }
    const setDarkTheme = (next: ColorTheme) => {
      writeStorage(THEME_STORAGE_KEYS.darkTheme, next)
      setDarkThemeState(next)
    }
    return {
      theme,
      resolvedTheme,
      setTheme: (next) => {
        writeStorage(storageKey, next)
        setThemeState(next)
      },
      colorTheme,
      lightTheme,
      darkTheme,
      setLightTheme,
      setDarkTheme,
      setColorTheme: (next) => {
        setLightTheme(next)
        setDarkTheme(next)
      },
    }
  }, [theme, resolvedTheme, colorTheme, lightTheme, darkTheme, storageKey])

  return <ThemeProviderContext.Provider value={value}>{children}</ThemeProviderContext.Provider>
}

export const useTheme = () => {
  const context = useContext(ThemeProviderContext)
  if (context === undefined) throw new Error("useTheme must be used within a ThemeProvider")
  return context
}
