import { createContext, useContext, useEffect, useMemo, useState } from "react"
import { type Accent, accentAttribute, parseAccent } from "@/lib/accent"
import { type ResolvedTheme, type Theme, parseTheme, resolveTheme } from "@/lib/theme"

type ThemeProviderProps = {
  children: React.ReactNode
  defaultTheme?: Theme
  storageKey?: string
  accentStorageKey?: string
}

type ThemeProviderState = {
  /** The stored preference, "system" included. */
  theme: Theme
  /** What the page is showing right now; "system" resolved against the OS. */
  resolvedTheme: ResolvedTheme
  setTheme: (theme: Theme) => void
  accent: Accent
  setAccent: (accent: Accent) => void
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
  storageKey = "vite-ui-theme",
  accentStorageKey = "geometrikks-accent",
}: ThemeProviderProps) {
  const [theme, setThemeState] = useState<Theme>(() =>
    parseTheme(readStorage(storageKey), defaultTheme),
  )
  const [accent, setAccentState] = useState<Accent>(() => parseAccent(readStorage(accentStorageKey)))
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
  }, [resolvedTheme])

  useEffect(() => {
    const root = window.document.documentElement
    const attr = accentAttribute(accent)
    if (attr === null) root.removeAttribute("data-accent")
    else root.setAttribute("data-accent", attr)
  }, [accent])

  const value = useMemo<ThemeProviderState>(
    () => ({
      theme,
      resolvedTheme,
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
    [theme, resolvedTheme, accent, storageKey, accentStorageKey],
  )

  return <ThemeProviderContext.Provider value={value}>{children}</ThemeProviderContext.Provider>
}

export const useTheme = () => {
  const context = useContext(ThemeProviderContext)
  if (context === undefined) throw new Error("useTheme must be used within a ThemeProvider")
  return context
}
