import { useId } from "react"
import { Moon, Sun } from "lucide-react"
import { RadioGroup as RadioGroupPrimitive } from "radix-ui"

import { useTheme } from "@/components/theme-provider"
import { RadioGroup } from "@/components/ui/radio-group"
import { Toggle } from "@/components/ui/toggle"
import {
  COLOR_THEMES,
  THEMES,
  THEME_CATALOG,
  parseTheme,
  type ColorTheme,
  type ResolvedTheme,
  type Theme,
} from "@/lib/theme"
import { cn } from "@/lib/utils"

const SCHEME_LABELS: Record<Theme, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
}

// Glass like the settings cards; selection adds the ring and a primary tint
// layered over the glass, never replacing it.
const OPTION =
  "group rounded-xl bg-glass-card text-left ring-1 ring-border backdrop-blur-[2px] transition-colors hover:ring-primary/50 " +
  "data-[state=checked]:ring-primary data-[state=checked]:bg-[linear-gradient(var(--primary-glow),var(--primary-glow))] data-[state=checked]:hover:ring-primary"

const FOCUS_OUTLINE = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"

const HEADING = "text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground"

const PREVIEW_BAR = "h-1 rounded-full bg-muted-foreground/30"

/** A miniature app in one scheme of one theme. Token classes only: a `dark:`
 * variant matches any `.dark` ancestor, so it would fire inside a light
 * preview on a dark page. */
function SchemePreview({ scheme, colorTheme, className }: { scheme: ResolvedTheme; colorTheme: ColorTheme; className?: string }) {
  return (
    <span
      aria-hidden
      data-theme={colorTheme}
      className={cn(scheme, "grid h-24 grid-cols-[22%_1fr] overflow-hidden rounded-md border border-border bg-background", className)}
    >
      <span className="flex flex-col gap-1.5 border-r border-border bg-sidebar px-1.5 py-2">
        <span className={PREVIEW_BAR} />
        <span className={PREVIEW_BAR} />
        <span className={PREVIEW_BAR} />
      </span>
      <span className="relative flex flex-col gap-1.5 p-2.5">
        <span className={cn(PREVIEW_BAR, "w-[45%]")} />
        <span className={cn(PREVIEW_BAR, "w-[30%]")} />
        <span className="absolute top-2 right-2 flex h-10 w-[34%] flex-col gap-1.5 rounded-md border border-border bg-card p-1.5">
          <span className={PREVIEW_BAR} />
          <span className={PREVIEW_BAR} />
          <span className={cn(PREVIEW_BAR, "w-2/3")} />
        </span>
        <span className="absolute right-2 bottom-2 left-2.5 h-3.5 rounded-full border border-border bg-card">
          <span className="absolute top-1/2 right-0.5 size-2 -translate-y-1/2 rounded-full bg-primary" />
        </span>
      </span>
    </span>
  )
}

function SchemeArt({ scheme, lightTheme, darkTheme }: { scheme: Theme; lightTheme: ColorTheme; darkTheme: ColorTheme }) {
  if (scheme === "light") return <SchemePreview scheme="light" colorTheme={lightTheme} />
  if (scheme === "dark") return <SchemePreview scheme="dark" colorTheme={darkTheme} />
  return (
    <span className="grid [&>*]:[grid-area:1/1]">
      <SchemePreview scheme="light" colorTheme={lightTheme} />
      <SchemePreview scheme="dark" colorTheme={darkTheme} className="[clip-path:inset(0_0_0_50%)]" />
    </span>
  )
}

const ORB_BADGES = { light: Sun, dark: Moon } as const

/** The ring sits on an unscoped wrapper so it takes the page's primary; on
 * the orb itself it would take the orb's theme and scheme. */
function ThemeSideToggle({
  scheme,
  colorTheme,
  pressed,
  onPress,
}: {
  scheme: ResolvedTheme
  colorTheme: ColorTheme
  pressed: boolean
  onPress: () => void
}) {
  const Badge = ORB_BADGES[scheme]
  return (
    <Toggle
      pressed={pressed}
      onPressedChange={(next) => {
        if (next) onPress()
      }}
      aria-label={`${THEME_CATALOG[colorTheme].label} ${scheme} theme`}
      className={
        "relative z-10 size-14 min-w-0 rounded-full p-0 hover:bg-transparent aria-pressed:bg-transparent focus-visible:ring-0 " +
        "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
      }
    >
      <span className="relative block rounded-full ring-offset-2 ring-offset-card group-aria-pressed/toggle:ring-2 group-aria-pressed/toggle:ring-primary">
        <span
          aria-hidden
          data-theme={colorTheme}
          className={cn(scheme, "block size-14 rounded-full ring-1 ring-border ring-inset")}
          style={{
            backgroundImage: "radial-gradient(circle at 32% 28%, var(--card) 0 12%, var(--background) 45%, var(--primary) 100%)",
          }}
        />
        <span className="absolute -right-1 -bottom-1 hidden size-5 place-items-center rounded-full bg-card text-foreground ring-1 ring-border group-aria-pressed/toggle:grid">
          <Badge className="size-3" />
        </span>
      </span>
    </Toggle>
  )
}

function ThemeCard({ colorTheme }: { colorTheme: ColorTheme }) {
  const id = useId()
  const { lightTheme, darkTheme, setLightTheme, setDarkTheme, setColorTheme } = useTheme()
  const { label, description } = THEME_CATALOG[colorTheme]
  const both = lightTheme === colorTheme && darkTheme === colorTheme
  return (
    <div data-slot="theme-card" data-state={both ? "checked" : "unchecked"} className={cn(OPTION, "relative px-4 pt-5 pb-4")}>
      <div className="mb-4 flex justify-center gap-4">
        <ThemeSideToggle
          scheme="light"
          colorTheme={colorTheme}
          pressed={lightTheme === colorTheme}
          onPress={() => setLightTheme(colorTheme)}
        />
        <ThemeSideToggle
          scheme="dark"
          colorTheme={colorTheme}
          pressed={darkTheme === colorTheme}
          onPress={() => setDarkTheme(colorTheme)}
        />
      </div>
      <button
        type="button"
        aria-pressed={both}
        aria-describedby={`${id}-description`}
        onClick={() => setColorTheme(colorTheme)}
        className={
          "block text-left text-sm font-medium after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none " +
          "focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-ring"
        }
      >
        {label}
      </button>
      <span id={`${id}-description`} className="block text-xs text-muted-foreground">{description}</span>
    </div>
  )
}

export function AppearancePage() {
  const { theme, setTheme, lightTheme, darkTheme } = useTheme()
  const schemeHeadingId = useId()
  const themesHeadingId = useId()

  return (
    <div className="space-y-8">
      <section aria-labelledby={schemeHeadingId} className="space-y-3">
        <div className="space-y-1">
          <h2 id={schemeHeadingId} className={HEADING}>Color scheme</h2>
          <p className="text-[13px] text-muted-foreground">
            System follows the device and switches live when it does.
          </p>
        </div>
        <RadioGroup
          aria-label="Color scheme"
          value={theme}
          onValueChange={(value) => setTheme(parseTheme(value, theme))}
          className="grid-cols-3 gap-2"
        >
          {THEMES.map((value) => (
            <RadioGroupPrimitive.Item key={value} value={value} className={cn(OPTION, FOCUS_OUTLINE, "p-2 pb-1.5 sm:p-2.5 sm:pb-2")}>
              <SchemeArt scheme={value} lightTheme={lightTheme} darkTheme={darkTheme} />
              <span className="mt-1.5 block text-center text-[13px] text-muted-foreground group-data-[state=checked]:font-medium group-data-[state=checked]:text-foreground">
                {SCHEME_LABELS[value]}
              </span>
            </RadioGroupPrimitive.Item>
          ))}
        </RadioGroup>
      </section>

      <section aria-labelledby={themesHeadingId} className="space-y-3">
        <div className="space-y-1">
          <h2 id={themesHeadingId} className={HEADING}>Themes</h2>
          <p className="text-[13px] text-muted-foreground">
            Pick a theme for both modes, or click a sun or moon to set one mode.
          </p>
        </div>
        <div role="group" aria-labelledby={themesHeadingId} className="grid gap-2 sm:grid-cols-2">
          {COLOR_THEMES.map((value) => (
            <ThemeCard key={value} colorTheme={value} />
          ))}
        </div>
      </section>
    </div>
  )
}
