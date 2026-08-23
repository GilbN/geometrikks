import { createContext, useContext, useEffect, useMemo, useState } from "react"
import { type Accent, accentAttribute, parseAccent } from "@/lib/accent"
import { type Theme, parseTheme } from "@/lib/theme"

type ThemeProviderProps = {
  children: React.ReactNode
  defaultTheme?: Theme
  storageKey?: string
  accentStorageKey?: string
}

type ThemeProviderState = {
  theme: Theme
  setTheme: (theme: Theme) => void
  accent: Accent
  setAccent: (accent: Accent) => void
}

const ThemeProviderContext = createContext<ThemeProviderState | undefined>(undefined)

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
  storageKey = "vite-ui-theme",
  accentStorageKey = "geometrikks-accent",
}: ThemeProviderProps) {
  const [theme, setThemeState] = useState<Theme>(() =>
    parseTheme(readStorage(storageKey), defaultTheme),
  )
  const [accent, setAccentState] = useState<Accent>(() => parseAccent(readStorage(accentStorageKey)))

  useEffect(() => {
    const root = window.document.documentElement
    const apply = (dark: boolean) => {
      root.classList.remove("light", "dark")
      root.classList.add(dark ? "dark" : "light")
    }
    if (theme !== "system") {
      apply(theme === "dark")
      return
    }
    const query = window.matchMedia("(prefers-color-scheme: dark)")
    apply(query.matches)
    const onChange = (event: MediaQueryListEvent) => apply(event.matches)
    query.addEventListener("change", onChange)
    return () => query.removeEventListener("change", onChange)
  }, [theme])

  useEffect(() => {
    const root = window.document.documentElement
    const attr = accentAttribute(accent)
    if (attr === null) root.removeAttribute("data-accent")
    else root.setAttribute("data-accent", attr)
  }, [accent])

  const value = useMemo<ThemeProviderState>(
    () => ({
      theme,
      setTheme: (next) => {
        writeStorage(storageKey, next)
        setThemeState(next)
      },
      accent,
      setAccent: (next) => {
        writeStorage(accentStorageKey, next)
        setAccentState(next)
      },
    }),
    [theme, accent, storageKey, accentStorageKey],
  )

  return <ThemeProviderContext.Provider value={value}>{children}</ThemeProviderContext.Provider>
}

export const useTheme = () => {
  const context = useContext(ThemeProviderContext)
  if (context === undefined) throw new Error("useTheme must be used within a ThemeProvider")
  return context
}
