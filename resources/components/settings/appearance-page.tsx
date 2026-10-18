import { useId } from "react"
import { Moon, Sun } from "lucide-react"
import { RadioGroup as RadioGroupPrimitive } from "radix-ui"

import { useTheme } from "@/components/theme-provider"
import { RadioGroup } from "@/components/ui/radio-group"
import {
  COLOR_THEMES,
  THEMES,
  THEME_CATALOG,
  parseColorTheme,
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
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring " +
  "data-[state=checked]:ring-primary data-[state=checked]:bg-[linear-gradient(var(--primary-glow),var(--primary-glow))] data-[state=checked]:hover:ring-primary"

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

function SchemeArt({ scheme, colorTheme }: { scheme: Theme; colorTheme: ColorTheme }) {
  if (scheme !== "system") return <SchemePreview scheme={scheme} colorTheme={colorTheme} />
  return (
    <span className="grid [&>*]:[grid-area:1/1]">
      <SchemePreview scheme="light" colorTheme={colorTheme} />
      <SchemePreview scheme="dark" colorTheme={colorTheme} className="[clip-path:inset(0_0_0_50%)]" />
    </span>
  )
}

const ORB_BADGES = { light: Sun, dark: Moon } as const

/** The ring sits on an unscoped wrapper so it takes the page's primary; on
 * the orb itself it would take the orb's theme and scheme. */
function Orb({ scheme, colorTheme }: { scheme: ResolvedTheme; colorTheme: ColorTheme }) {
  const Badge = ORB_BADGES[scheme]
  return (
    <span className="relative rounded-full ring-offset-2 ring-offset-card group-data-[state=checked]:ring-2 group-data-[state=checked]:ring-primary">
      <span
        data-theme={colorTheme}
        className={cn(scheme, "block size-14 rounded-full ring-1 ring-border ring-inset")}
        style={{
          backgroundImage: "radial-gradient(circle at 32% 28%, var(--card) 0 12%, var(--background) 45%, var(--primary) 100%)",
        }}
      />
      <span className="absolute -right-1 -bottom-1 hidden size-5 place-items-center rounded-full bg-card text-foreground ring-1 ring-border group-data-[state=checked]:grid">
        <Badge className="size-3" />
      </span>
    </span>
  )
}

function ThemeCard({ colorTheme }: { colorTheme: ColorTheme }) {
  const id = useId()
  const { label, description } = THEME_CATALOG[colorTheme]
  return (
    <RadioGroupPrimitive.Item
      value={colorTheme}
      aria-labelledby={`${id}-label`}
      aria-describedby={`${id}-description`}
      className={cn(OPTION, "px-4 pt-5 pb-4")}
    >
      <span aria-hidden className="mb-4 flex justify-center gap-4">
        <Orb scheme="light" colorTheme={colorTheme} />
        <Orb scheme="dark" colorTheme={colorTheme} />
      </span>
      <span id={`${id}-label`} className="block text-sm font-medium">{label}</span>
      <span id={`${id}-description`} className="block text-xs text-muted-foreground">{description}</span>
    </RadioGroupPrimitive.Item>
  )
}

export function AppearancePage() {
  const { theme, setTheme, colorTheme, setColorTheme } = useTheme()

  return (
    <div className="space-y-8">
      <section aria-labelledby="scheme-heading" className="space-y-3">
        <div className="space-y-1">
          <h2 id="scheme-heading" className={HEADING}>Color scheme</h2>
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
            <RadioGroupPrimitive.Item key={value} value={value} className={cn(OPTION, "p-2 pb-1.5 sm:p-2.5 sm:pb-2")}>
              <SchemeArt scheme={value} colorTheme={colorTheme} />
              <span className="mt-1.5 block text-center text-[13px] text-muted-foreground group-data-[state=checked]:font-medium group-data-[state=checked]:text-foreground">
                {SCHEME_LABELS[value]}
              </span>
            </RadioGroupPrimitive.Item>
          ))}
        </RadioGroup>
      </section>

      <section aria-labelledby="themes-heading" className="space-y-3">
        <h2 id="themes-heading" className={HEADING}>Themes</h2>
        <RadioGroup
          aria-label="Theme"
          value={colorTheme}
          onValueChange={(value) => setColorTheme(parseColorTheme(value, null))}
          className="gap-2 sm:grid-cols-2"
        >
          {COLOR_THEMES.map((value) => (
            <ThemeCard key={value} colorTheme={value} />
          ))}
        </RadioGroup>
      </section>
    </div>
  )
}
