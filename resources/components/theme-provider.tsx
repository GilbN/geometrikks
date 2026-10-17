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
  colorThemeStorageKey?: string
}

type ThemeProviderState = {
  /** The stored preference, "system" included. */
  theme: Theme
  /** What the page is showing right now; "system" resolved against the OS. */
  resolvedTheme: ResolvedTheme
  setTheme: (theme: Theme) => void
  colorTheme: ColorTheme
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
  colorThemeStorageKey = THEME_STORAGE_KEYS.theme,
}: ThemeProviderProps) {
  const [theme, setThemeState] = useState<Theme>(() =>
    parseTheme(readStorage(storageKey), defaultTheme),
  )
  const [colorTheme, setColorThemeState] = useState<ColorTheme>(() =>
    parseColorTheme(readStorage(colorThemeStorageKey), readStorage(THEME_STORAGE_KEYS.legacyAccent)),
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

  const value = useMemo<ThemeProviderState>(
    () => ({
      theme,
      resolvedTheme,
      setTheme: (next) => {
        writeStorage(storageKey, next)
        setThemeState(next)
      },
      colorTheme,
      setColorTheme: (next) => {
        writeStorage(colorThemeStorageKey, next)
        setColorThemeState(next)
      },
    }),
    [theme, resolvedTheme, colorTheme, storageKey, colorThemeStorageKey],
  )

  return <ThemeProviderContext.Provider value={value}>{children}</ThemeProviderContext.Provider>
}

export const useTheme = () => {
  const context = useContext(ThemeProviderContext)
  if (context === undefined) throw new Error("useTheme must be used within a ThemeProvider")
  return context
}
